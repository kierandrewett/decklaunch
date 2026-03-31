use crate::config::Config;
use axum::extract::ws::Message;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{broadcast, Mutex, RwLock};

pub type Tx = tokio::sync::mpsc::UnboundedSender<Message>;

#[derive(Debug, Clone)]
pub struct AgentInfo {
    pub hostname: String,
    pub os: String,
    pub last_seen: Instant,
    pub tx: Tx,
}

#[derive(Debug, Clone)]
pub struct TileState {
    pub data: Option<String>,
    pub stale: bool,
}

pub struct AppState {
    pub config: RwLock<Config>,
    pub token: String,
    pub agents: Mutex<HashMap<String, AgentInfo>>,
    /// tile_id -> pending exec_id -> response channel
    pub pending_execs: Mutex<HashMap<String, tokio::sync::oneshot::Sender<ExecResult>>>,
    /// tile state cache
    pub tile_states: RwLock<HashMap<String, TileState>>,
    /// broadcast channel for panel messages
    pub panel_tx: broadcast::Sender<String>,
    /// server start time
    pub started_at: Instant,
    /// app icon cache: packageName -> base64 PNG
    pub app_icons: RwLock<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct ExecResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl AppState {
    pub fn new(config: Config, token: String) -> Arc<Self> {
        let (panel_tx, _) = broadcast::channel(256);
        Arc::new(AppState {
            config: RwLock::new(config),
            token,
            agents: Mutex::new(HashMap::new()),
            pending_execs: Mutex::new(HashMap::new()),
            tile_states: RwLock::new(HashMap::new()),
            panel_tx,
            started_at: Instant::now(),
            app_icons: RwLock::new(HashMap::new()),
        })
    }

    pub async fn broadcast_to_panels(&self, msg: &str) {
        let _ = self.panel_tx.send(msg.to_string());
    }

    pub async fn push_full_state(&self) {
        let states = self.tile_states.read().await;
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
        self.broadcast_to_panels(&msg.to_string()).await;
    }

    pub async fn mark_agent_tiles_stale(&self, agent_id: &str) {
        let config = self.config.read().await;
        let mut states = self.tile_states.write().await;
        for tile in &config.tiles {
            if let Some(action) = &tile.action {
                let tile_agent = match action {
                    crate::config::TileAction::PcCommand { agent, .. } => Some(agent.as_str()),
                    crate::config::TileAction::PcPoll { agent, .. } => Some(agent.as_str()),
                    _ => None,
                };
                if tile_agent == Some(agent_id) {
                    if let Some(state) = states.get_mut(&tile.id) {
                        state.stale = true;
                    }
                }
            }
        }
        drop(states);
        drop(config);
        self.push_full_state().await;
    }
}
