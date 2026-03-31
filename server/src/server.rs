use crate::config::{load_config, save_config, Config};
use crate::state::AppState;
use crate::ws_agent::handle_agent_ws;
use crate::ws_panel::handle_panel_ws;
use axum::{
    extract::{Query, State, WebSocketUpgrade},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::info;

#[derive(RustEmbed)]
#[folder = "static/"]
struct StaticFiles;

pub fn create_router(state: Arc<AppState>) -> Router {
    let auth_state = state.clone();

    Router::new()
        // WebSocket endpoints
        .route("/ws/panel", get(panel_ws_handler))
        .route("/ws/agent", get(agent_ws_handler))
        // API routes (auth required)
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/status", get(get_status))
        .route("/api/agents/:id", axum::routing::delete(delete_agent))
        .route("/api/app-icons", axum::routing::post(post_app_icons))
        .route("/api/app-icon/:pkg", get(get_app_icon))
        // Static UI routes
        .route("/", get(serve_panel_index))
        .route("/panel/*path", get(serve_panel_asset))
        .route("/config", get(serve_config_index))
        .route("/config/*path", get(serve_config_asset))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ─── Auth helpers ────────────────────────────────────────────────────────────

fn extract_bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string())
}

fn check_auth(state: &Arc<AppState>, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    let token = extract_bearer(headers)
        .or_else(|| query_token.map(|t| t.to_string()));
    token.as_deref() == Some(&state.token)
}

// ─── WebSocket handlers ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn panel_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.on_upgrade(|socket| handle_panel_ws(socket, state))
}

async fn agent_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.on_upgrade(|socket| handle_agent_ws(socket, state))
}

// ─── API handlers ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn get_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let config = state.config.read().await.clone();
    Json(config).into_response()
}

async fn put_config(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(new_config): Json<Config>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    if let Err(e) = save_config(&new_config).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }

    {
        let mut config = state.config.write().await;
        *config = new_config;
    }

    // Push reload to panels
    let reload = serde_json::json!({ "type": "reload" });
    state.broadcast_to_panels(&reload.to_string()).await;

    info!("Config updated");
    StatusCode::OK.into_response()
}

#[derive(Serialize)]
struct StatusResponse {
    uptime_seconds: u64,
    agents: Vec<AgentStatus>,
}

#[derive(Serialize)]
struct AgentStatus {
    id: String,
    hostname: String,
    os: String,
    connected: bool,
    last_seen_seconds_ago: Option<u64>,
}

async fn get_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let uptime = state.started_at.elapsed().as_secs();
    let live = state.agents.lock().await;
    let config = state.config.read().await;

    // Return all known agents (from config) merged with live connection state
    let agent_statuses: Vec<AgentStatus> = config
        .agents
        .iter()
        .map(|(id, known)| {
            let live_info = live.get(id);
            AgentStatus {
                id: id.clone(),
                hostname: known.hostname.clone(),
                os: known.os.clone(),
                connected: live_info.is_some(),
                last_seen_seconds_ago: live_info.map(|a| a.last_seen.elapsed().as_secs()),
            }
        })
        .collect();

    Json(StatusResponse {
        uptime_seconds: uptime,
        agents: agent_statuses,
    })
    .into_response()
}

async fn delete_agent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    let mut cfg = state.config.write().await;
    cfg.agents.remove(&id);
    if let Err(e) = save_config(&cfg).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    drop(cfg);

    StatusCode::NO_CONTENT.into_response()
}

// ─── App icon cache ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AppIconEntry {
    #[serde(rename = "packageName")]
    package_name: String,
    #[serde(rename = "iconBase64")]
    icon_base64: String,
}

async fn post_app_icons(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    Json(icons): Json<Vec<AppIconEntry>>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let mut store = state.app_icons.write().await;
    for entry in icons {
        store.insert(entry.package_name, entry.icon_base64);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn get_app_icon(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
    axum::extract::Path(pkg): axum::extract::Path<String>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    let store = state.app_icons.read().await;
    match store.get(&pkg) {
        Some(b64) => match B64.decode(b64.as_bytes()) {
            Ok(bytes) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "image/png"),
                 (header::CACHE_CONTROL, "public, max-age=86400")],
                bytes,
            ).into_response(),
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Bad base64").into_response(),
        },
        None => (StatusCode::NOT_FOUND, "Icon not found").into_response(),
    }
}

// ─── Static file serving ──────────────────────────────────────────────────────

async fn serve_panel_index(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    // Panel requires token in query param or Authorization header
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return serve_login_page("panel").into_response();
    }
    serve_embedded_file("panel/index.html")
}

async fn serve_panel_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    serve_embedded_file(&format!("panel/{path}"))
}

async fn serve_config_index(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Response {
    if !check_auth(&state, &headers, q.token.as_deref()) {
        return serve_embedded_file("config/index.html"); // config UI has its own login gate
    }
    serve_embedded_file("config/index.html")
}

async fn serve_config_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    serve_embedded_file(&format!("config/{path}"))
}

fn serve_embedded_file(path: &str) -> Response {
    match StaticFiles::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime.to_string())],
                content.data.to_vec(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

fn serve_login_page(area: &str) -> Response {
    let html = format!(
        r#"<!DOCTYPE html><html><head><title>DeckLaunch - Login</title>
<style>body{{background:#0a0a0a;color:#e0e0e0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
form{{display:flex;flex-direction:column;gap:1rem;background:#111;padding:2rem;border-radius:12px;border:1px solid #222}}
input{{background:#1a1a1a;border:1px solid #333;color:#e0e0e0;padding:.5rem 1rem;border-radius:6px;font-family:monospace}}
button{{background:#0af;color:#000;border:none;padding:.5rem 1rem;border-radius:6px;cursor:pointer;font-family:monospace}}
h2{{margin:0 0 1rem;color:#0af}}</style></head>
<body><form onsubmit="login(event)"><h2>DeckLaunch</h2>
<input id="tok" type="password" placeholder="Auth token" autofocus>
<button type="submit">Connect</button></form>
<script>function login(e){{e.preventDefault();const t=document.getElementById('tok').value;
location.href='/{area}?token='+encodeURIComponent(t);}}</script></body></html>"#
    );
    (StatusCode::UNAUTHORIZED, [(header::CONTENT_TYPE, "text/html")], html).into_response()
}
