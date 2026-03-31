use crate::config::{TileAction, TileType, VOLUME_POLL_CMD, MIC_POLL_CMD, VOLUME_SET_CMD, MIC_SET_CMD, VOLUME_MUTE_CMD, MIC_MUTE_CMD};
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PanelIncoming {
    Auth { token: String },
    TileAction    { #[serde(rename = "tileId")] tile_id: String },
    TileDrag      { #[serde(rename = "tileId")] tile_id: String, value: f64 },
    Refresh       { #[serde(rename = "tileId")] tile_id: String },
    MediaControl  { #[serde(rename = "tileId")] tile_id: String, action: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PanelOutgoing {
    AuthOk,
    AuthFail { reason: String },
    Ack { #[serde(rename = "tileId")] tile_id: String },
    Error { message: String },
}

pub async fn handle_panel_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut broadcast_rx = state.panel_tx.subscribe();

    // Auth timeout
    let auth_result = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(PanelIncoming::Auth { token }) = serde_json::from_str(&text) {
                    return token;
                }
            }
        }
        String::new()
    })
    .await;

    let token = match auth_result {
        Ok(t) => t,
        Err(_) => {
            warn!("Panel WebSocket auth timeout");
            let msg = serde_json::to_string(&PanelOutgoing::AuthFail {
                reason: "auth timeout".into(),
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg)).await;
            let _ = sender.close().await;
            return;
        }
    };

    if token != state.token {
        warn!("Panel WebSocket invalid token");
        let msg = serde_json::to_string(&PanelOutgoing::AuthFail {
            reason: "invalid token".into(),
        })
        .unwrap();
        let _ = sender.send(Message::Text(msg)).await;
        let _ = sender.close().await;
        return;
    }

    info!("Panel WebSocket authenticated");

    // Send auth OK
    let _ = sender
        .send(Message::Text(
            serde_json::to_string(&PanelOutgoing::AuthOk).unwrap(),
        ))
        .await;

    // Send full current state
    {
        let states = state.tile_states.read().await;
        let tiles: Vec<serde_json::Value> = states
            .iter()
            .map(|(id, s)| {
                serde_json::json!({
                    "id": id,
                    "data": s.data,
                    "stale": s.stale,
                })
            })
            .collect();
        let msg = serde_json::json!({ "type": "state", "tiles": tiles });
        let _ = sender.send(Message::Text(msg.to_string())).await;
    }

    // Spin up a task to forward broadcast messages to this panel
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();
    let mut sender = sender;

    let broadcast_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = broadcast_rx.recv() => {
                    match msg {
                        Ok(text) => {
                            if sender.send(Message::Text(text)).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
                _ = &mut close_rx => break,
            }
        }
    });

    // Handle incoming messages
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                match serde_json::from_str::<PanelIncoming>(&text) {
                    Ok(PanelIncoming::TileAction { tile_id }) => {
                        handle_tile_action(&state, &tile_id).await;
                    }
                    Ok(PanelIncoming::TileDrag { tile_id, value }) => {
                        handle_tile_drag(&state, &tile_id, value).await;
                    }
                    Ok(PanelIncoming::Refresh { tile_id }) => {
                        trigger_tile_refresh(&state, &tile_id).await;
                    }
                    Ok(PanelIncoming::MediaControl { tile_id, action }) => {
                        handle_media_control(&state, &tile_id, &action).await;
                    }
                    Ok(PanelIncoming::Auth { .. }) => {} // already authed
                    Err(e) => {
                        warn!("Panel sent unknown message: {e}: {text}");
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(p) => {
                // axum handles pong automatically
                let _ = state.panel_tx.send("".to_string()); // no-op
                let _ = p;
            }
            _ => {}
        }
    }

    let _ = close_tx.send(());
    broadcast_task.abort();
    info!("Panel WebSocket disconnected");
}

async fn handle_media_control(state: &Arc<AppState>, tile_id: &str, action: &str) {
    let command = match action {
        "play" | "pause" | "play-pause" => "playerctl play-pause",
        "next"     => "playerctl next",
        "previous" => "playerctl previous",
        _ => return,
    };

    let config = state.config.read().await;
    let tile = config.tiles.iter().find(|t| t.id == tile_id).cloned();
    drop(config);

    if let Some(tile) = tile {
        if let Some(TileAction::PcPoll { agent, .. }) = &tile.action {
            send_exec_to_agent(state, agent, tile_id, command, false, None).await;
        }
    }
}

async fn handle_tile_action(state: &Arc<AppState>, tile_id: &str) {
    let config = state.config.read().await;
    let tile = config.tiles.iter().find(|t| t.id == tile_id).cloned();
    drop(config);

    let tile = match tile {
        Some(t) => t,
        None => {
            warn!("tile_action for unknown tile: {tile_id}");
            return;
        }
    };

    match &tile.tile_type {
        TileType::Command => {
            if let Some(TileAction::PcCommand { agent, command }) = &tile.action {
                send_exec_to_agent(state, agent, tile_id, command, false, None).await;
            }
        }
        TileType::Volume => {
            // Toggle mute, then poll so panel gets updated level
            if let Some(TileAction::PcPoll { agent, .. }) = &tile.action {
                let agent = agent.clone();
                let tile_id_owned = tile_id.to_string();
                send_exec_to_agent(state, &agent, &tile_id_owned, VOLUME_MUTE_CMD, false, None).await;
                let state2 = state.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    send_exec_to_agent(&state2, &agent, &tile_id_owned, VOLUME_POLL_CMD, true, None).await;
                });
            }
        }
        TileType::Mic => {
            // Toggle agent mic mute, then refresh the tile so the new volume % is shown
            if let Some(TileAction::PcPoll { agent, .. }) = &tile.action {
                let agent = agent.clone();
                let tile_id_owned = tile_id.to_string();
                // Run mute toggle (fire-and-forget)
                send_exec_to_agent(state, &agent, &tile_id_owned, MIC_MUTE_CMD, false, None).await;
                // Schedule a refresh so the panel gets updated level
                let state2 = state.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    send_exec_to_agent(&state2, &agent, &tile_id_owned, MIC_POLL_CMD, true, None).await;
                });
            }
        }
        TileType::PcData => {
            if let Some(TileAction::PcPoll { agent, tap_command: Some(cmd), .. }) = &tile.action {
                // Run tap command and wait for it to finish before sending the ack,
                // so the panel's follow-up refresh sees the updated state.
                let exec_id = uuid::Uuid::new_v4().to_string();
                let agent_tx = {
                    let agents = state.agents.lock().await;
                    agents.get(agent.as_str()).map(|a| a.tx.clone())
                };
                if let Some(agent_tx) = agent_tx {
                    let exec_msg = serde_json::json!({
                        "type": "exec",
                        "id": exec_id,
                        "command": cmd,
                        "stdin": null,
                    });
                    let (tx, rx) = tokio::sync::oneshot::channel::<crate::state::ExecResult>();
                    {
                        let mut pending = state.pending_execs.lock().await;
                        pending.insert(exec_id.clone(), tx);
                    }
                    if agent_tx.send(Message::Text(exec_msg.to_string())).is_err() {
                        warn!("Failed to send tap exec to agent {agent}");
                    } else {
                        let _ = tokio::time::timeout(Duration::from_secs(30), rx).await;
                    }
                }
            } else {
                trigger_tile_refresh(state, tile_id).await;
            }
        }
        _ => {
            // Other tile types (app, shortcut, etc.) are handled client-side
        }
    }

    // Broadcast ack
    let ack = serde_json::json!({ "type": "ack", "tileId": tile_id });
    state.broadcast_to_panels(&ack.to_string()).await;
}

async fn trigger_tile_refresh(state: &Arc<AppState>, tile_id: &str) {
    let config = state.config.read().await;
    let tile = config.tiles.iter().find(|t| t.id == tile_id).cloned();
    drop(config);

    let tile = match tile {
        Some(t) => t,
        None => return,
    };

    let (agent, command) = match (&tile.tile_type, &tile.action) {
        (TileType::Volume, Some(TileAction::PcPoll { agent, .. })) =>
            (agent.clone(), VOLUME_POLL_CMD.to_string()),
        (TileType::Mic, Some(TileAction::PcPoll { agent, .. })) =>
            (agent.clone(), MIC_POLL_CMD.to_string()),
        (_, Some(TileAction::PcPoll { agent, command, .. })) =>
            (agent.clone(), command.clone()),
        _ => return,
    };
    send_exec_to_agent(state, &agent, tile_id, &command, true, None).await;
}

async fn handle_tile_drag(state: &Arc<AppState>, tile_id: &str, value: f64) {
    let config = state.config.read().await;
    let tile = config.tiles.iter().find(|t| t.id == tile_id).cloned();
    drop(config);

    if let Some(tile) = tile {
        match &tile.tile_type {
            TileType::Volume => {
                if let Some(TileAction::PcPoll { agent, .. }) = &tile.action {
                    let cmd = format!("pactl set-sink-mute @DEFAULT_SINK@ false; {} {}%", VOLUME_SET_CMD, value.round() as i64);
                    send_exec_to_agent(state, agent, tile_id, &cmd, false, None).await;
                }
            }
            TileType::Mic => {
                if let Some(TileAction::PcPoll { agent, .. }) = &tile.action {
                    let cmd = format!("pactl set-source-mute @DEFAULT_SOURCE@ false; {} {}%", MIC_SET_CMD, value.round() as i64);
                    send_exec_to_agent(state, agent, tile_id, &cmd, false, None).await;
                }
            }
            _ => {
                if let Some(TileAction::PcPoll { agent, drag_command: Some(cmd), .. }) = &tile.action {
                    let stdin = format!("{}\n", value.round() as i64);
                    send_exec_to_agent(state, agent, tile_id, cmd, false, Some(&stdin)).await;
                }
            }
        }
    }

    // Ack so the panel knows the command was dispatched and can trigger a refresh
    let ack = serde_json::json!({ "type": "ack", "tileId": tile_id });
    state.broadcast_to_panels(&ack.to_string()).await;
}

async fn send_exec_to_agent(
    state: &Arc<AppState>,
    agent_id: &str,
    tile_id: &str,
    command: &str,
    update_tile: bool,
    stdin: Option<&str>,
) {
    let exec_id = uuid::Uuid::new_v4().to_string();
    let agents = state.agents.lock().await;
    let agent = agents.get(agent_id).cloned();
    drop(agents);

    let agent = match agent {
        Some(a) => a,
        None => {
            warn!("No agent connected with id: {agent_id}");
            if update_tile {
                let mut states = state.tile_states.write().await;
                states.insert(
                    tile_id.to_string(),
                    crate::state::TileState {
                        data: Some("offline".into()),
                        stale: true,
                    },
                );
                drop(states);
                state.push_full_state().await;
            }
            return;
        }
    };

    let exec_msg = serde_json::json!({
        "type": "exec",
        "id": exec_id,
        "command": command,
        "stdin": stdin,
    });

    if agent.tx.send(Message::Text(exec_msg.to_string())).is_err() {
        warn!("Failed to send exec to agent {agent_id}");
    }

    if update_tile {
        // Register pending exec — polling.rs will pick up the result via exec_results
        // For manual refresh, just fire and let the result come back via ws_agent
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut pending = state.pending_execs.lock().await;
            pending.insert(exec_id.clone(), tx);
        }

        let state_clone = state.clone();
        let tile_id = tile_id.to_string();
        tokio::spawn(async move {
            match tokio::time::timeout(Duration::from_secs(30), rx).await {
                Ok(Ok(result)) => {
                    let data = if result.ok {
                        result.stdout.trim().to_string()
                    } else {
                        format!("err: {}", result.stderr.trim())
                    };
                    let mut states = state_clone.tile_states.write().await;
                    states.insert(
                        tile_id.clone(),
                        crate::state::TileState {
                            data: Some(data),
                            stale: false,
                        },
                    );
                    drop(states);
                    state_clone.push_full_state().await;
                }
                _ => {
                    let mut states = state_clone.tile_states.write().await;
                    if let Some(s) = states.get_mut(&tile_id) {
                        s.stale = true;
                    }
                    drop(states);
                    state_clone.push_full_state().await;
                }
            }
        });
    }
}
