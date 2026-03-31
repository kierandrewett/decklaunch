use crate::config::{save_config, KnownAgent};
use crate::state::{AgentInfo, AppState, ExecResult};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentIncoming {
    Auth { token: String },
    Hello { hostname: String, os: String },
    ExecResult {
        id: String,
        ok: bool,
        stdout: String,
        stderr: String,
        exit_code: i32,
    },
    MediaUpdate {
        title: String,
        artist: String,
        album: String,
        status: String,
        #[serde(default)]
        art_base64: Option<String>,
        #[serde(default)]
        art_mime: String,
    },
    Ping,
    Pong,
}

pub async fn handle_agent_ws(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    // Auth phase — must receive auth within 5 seconds
    let auth_result = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(AgentIncoming::Auth { token }) = serde_json::from_str(&text) {
                    return Some(token);
                }
            }
        }
        None
    })
    .await;

    let token = match auth_result {
        Ok(Some(t)) => t,
        _ => {
            warn!("Agent WebSocket auth failed or timed out");
            let close_msg = Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4001,
                reason: std::borrow::Cow::Borrowed("auth required"),
            }));
            let _ = sender.send(close_msg).await;
            return;
        }
    };

    if token != state.token {
        warn!("Agent provided invalid token");
        let close_msg = Message::Close(Some(axum::extract::ws::CloseFrame {
            code: 4001,
            reason: std::borrow::Cow::Borrowed("invalid token"),
        }));
        let _ = sender.send(close_msg).await;
        return;
    }

    // Wait for hello
    let hello_result = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if let Ok(AgentIncoming::Hello { hostname, os }) = serde_json::from_str(&text) {
                    return Some((hostname, os));
                }
            }
        }
        None
    })
    .await;

    let (hostname, os) = match hello_result {
        Ok(Some(h)) => h,
        _ => {
            warn!("Agent did not send hello");
            return;
        }
    };

    info!("Agent connected: {hostname} ({os})");

    // Create mpsc channel for outbound messages to this agent
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Register agent — use hostname as the agent ID
    let agent_id = hostname.clone();
    {
        let mut agents = state.agents.lock().await;
        agents.insert(
            agent_id.clone(),
            AgentInfo {
                hostname: hostname.clone(),
                os: os.clone(),
                last_seen: Instant::now(),
                tx: tx.clone(),
            },
        );
    }

    // Persist agent into config (upsert) so it shows up in the known-agents list
    {
        let mut cfg = state.config.write().await;
        cfg.agents.insert(agent_id.clone(), KnownAgent {
            hostname: hostname.clone(),
            os: os.clone(),
        });
        if let Err(e) = save_config(&cfg).await {
            warn!("Failed to persist known agent: {e}");
        }
    }

    // Un-stale tiles for this agent
    {
        let config = state.config.read().await;
        let mut states = state.tile_states.write().await;
        for tile in &config.tiles {
            if let Some(action) = &tile.action {
                let tile_agent = match action {
                    crate::config::TileAction::PcPoll { agent, .. } => Some(agent.as_str()),
                    crate::config::TileAction::PcCommand { agent, .. } => Some(agent.as_str()),
                    _ => None,
                };
                if tile_agent == Some(&agent_id) {
                    if let Some(s) = states.get_mut(&tile.id) {
                        s.stale = false;
                    }
                }
            }
        }
    }
    state.push_full_state().await;

    // Forward outbound messages from the channel to the WebSocket sender
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();

    let forward_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(m) => {
                            if sender.send(m).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = &mut close_rx => break,
            }
        }
    });

    // Ping every 30s
    let ping_tx = tx.clone();
    let ping_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let ping = serde_json::json!({ "type": "ping" });
            if ping_tx
                .send(Message::Text(ping.to_string()))
                .is_err()
            {
                break;
            }
        }
    });

    // Handle incoming messages from agent
    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<AgentIncoming>(&text) {
                Ok(AgentIncoming::ExecResult {
                    id,
                    ok,
                    stdout,
                    stderr,
                    exit_code,
                }) => {
                    // Update last_seen
                    {
                        let mut agents = state.agents.lock().await;
                        if let Some(a) = agents.get_mut(&agent_id) {
                            a.last_seen = Instant::now();
                        }
                    }

                    // Resolve pending exec if any
                    let sender_opt = {
                        let mut pending = state.pending_execs.lock().await;
                        pending.remove(&id)
                    };

                    if let Some(sender) = sender_opt {
                        let _ = sender.send(ExecResult {
                            ok,
                            stdout: stdout.clone(),
                            stderr: stderr.clone(),
                            exit_code,
                        });
                    } else {
                        // Might be a polling result — polling.rs registers its own senders
                        // But we also handle it here by looking up tile by exec_id mapping
                        // This is handled via pending_execs registered by polling.rs
                        warn!("Received exec_result for unknown id: {id}");
                    }
                }
                Ok(AgentIncoming::MediaUpdate { title, artist, album, status, art_base64, art_mime }) => {
                    let data = serde_json::json!({
                        "title": title,
                        "artist": artist,
                        "album": album,
                        "status": status,
                        "artBase64": art_base64,
                        "artMime": if art_mime.is_empty() { "image/jpeg".to_string() } else { art_mime },
                    });
                    let config = state.config.read().await;
                    let mut states = state.tile_states.write().await;
                    for tile in &config.tiles {
                        if tile.tile_type != crate::config::TileType::Media { continue; }
                        let tile_agent = tile.action.as_ref().and_then(|a| match a {
                            crate::config::TileAction::PcPoll { agent, .. } => Some(agent.as_str()),
                            _ => None,
                        });
                        if tile_agent == Some(&agent_id) {
                            states.insert(tile.id.clone(), crate::state::TileState {
                                data: Some(data.to_string()),
                                stale: false,
                            });
                        }
                    }
                    drop(states);
                    drop(config);
                    state.push_full_state().await;
                }
                Ok(AgentIncoming::Ping) => {
                    let pong = serde_json::json!({"type": "pong"});
                    let _ = tx.send(Message::Text(pong.to_string()));
                }
                Ok(AgentIncoming::Pong) => {
                    let mut agents = state.agents.lock().await;
                    if let Some(a) = agents.get_mut(&agent_id) {
                        a.last_seen = Instant::now();
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    warn!("Agent sent unknown message: {e}: {text}");
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    info!("Agent disconnected: {hostname}");
    let _ = close_tx.send(());
    forward_task.abort();
    ping_task.abort();

    // Remove from live runtime map (stays in config.agents as a known agent)
    {
        let mut agents = state.agents.lock().await;
        agents.remove(&agent_id);
    }

    state.mark_agent_tiles_stale(&agent_id).await;
}
