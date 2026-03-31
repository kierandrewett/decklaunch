use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "decklaunch-agent", about = "DeckLaunch PC agent")]
struct Args {
    #[arg(long, env = "DECK_SERVER")]
    server: String,
    #[arg(long, env = "DECK_TOKEN")]
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Exec { id: String, command: String, #[serde(default)] stdin: Option<String> },
    Ping,
    Pong,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentMessage {
    Auth { token: String },
    Hello { hostname: String, os: &'static str },
    ExecResult { id: String, ok: bool, stdout: String, stderr: String, exit_code: i32 },
    MediaUpdate { title: String, artist: String, album: String, status: String, #[serde(skip_serializing_if = "Option::is_none")] art_base64: Option<String>, #[serde(skip_serializing_if = "String::is_empty")] art_mime: String },
    Pong,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let args = Args::parse();
    loop {
        info!("Connecting to {}", args.server);
        match run_agent(&args.server, &args.token).await {
            Ok(()) => info!("Agent disconnected cleanly"),
            Err(e) => warn!("Agent error: {e}"),
        }
        info!("Reconnecting in 5s...");
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn run_agent(server_url: &str, token: &str) -> anyhow::Result<()> {
    let (ws_stream, _) = connect_async(server_url).await?;
    let (mut write, mut read) = ws_stream.split();

    write.send(Message::Text(serde_json::to_string(&AgentMessage::Auth { token: token.to_string() })?)).await?;

    let hostname = hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_else(|_| "unknown".to_string());
    let os_str: &'static str = if cfg!(target_os = "linux") { "linux" } else if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "windows") { "windows" } else { "unknown" };
    write.send(Message::Text(serde_json::to_string(&AgentMessage::Hello { hostname: hostname.clone(), os: os_str })?)).await?;

    info!("Connected as {hostname} ({os_str})");

    // Channel for tasks to send outbound messages
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    // MPRIS watcher (Linux only)
    #[cfg(target_os = "linux")]
    let mpris_handle = {
        let tx = out_tx.clone();
        tokio::spawn(async move { mpris::run(tx).await })
    };

    // Ping task
    let ping_tx = out_tx.clone();
    let ping_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if ping_tx.send(serde_json::json!({"type":"ping"}).to_string()).is_err() { break; }
        }
    });

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<ServerMessage>(&text) {
                            Ok(ServerMessage::Exec { id, command, stdin }) => {
                                info!("[exec:{id}] {command}");
                                let result = run_command(&command, stdin.as_deref()).await;
                                info!("[exec:{id}] exit={} stdout={:?}", result.exit_code, result.stdout.trim());
                                let reply = serde_json::to_string(&AgentMessage::ExecResult {
                                    id, ok: result.ok, stdout: result.stdout,
                                    stderr: result.stderr, exit_code: result.exit_code,
                                })?;
                                let _ = out_tx.send(reply);
                            }
                            Ok(ServerMessage::Ping) => {
                                let _ = out_tx.send(serde_json::to_string(&AgentMessage::Pong)?);
                            }
                            Ok(ServerMessage::Pong) => {}
                            Err(e) => warn!("Unknown message: {e}: {text}"),
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => { write.send(Message::Pong(data)).await?; }
                    _ => {}
                }
            }
            msg = out_rx.recv() => {
                match msg {
                    Some(text) => { write.send(Message::Text(text)).await?; }
                    None => break,
                }
            }
        }
    }

    ping_task.abort();
    #[cfg(target_os = "linux")]
    mpris_handle.abort();

    Ok(())
}

struct ExecOutput { ok: bool, stdout: String, stderr: String, exit_code: i32 }

async fn run_command(command: &str, stdin_data: Option<&str>) -> ExecOutput {
    #[cfg(target_os = "windows")]
    let mut cmd = { let mut c = Command::new("cmd"); c.args(["/C", command]); c };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = { let mut c = Command::new("sh"); c.args(["-c", command]); c };

    let child = cmd
        .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();

    let result = match child {
        Ok(mut c) => {
            if let (Some(data), Some(mut stdin_handle)) = (stdin_data, c.stdin.take()) {
                let data = data.to_string();
                tokio::spawn(async move { use tokio::io::AsyncWriteExt; let _ = stdin_handle.write_all(data.as_bytes()).await; });
            }
            c.wait_with_output().await
        }
        Err(e) => Err(e),
    };

    match result {
        Ok(output) => ExecOutput {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        },
        Err(e) => ExecOutput { ok: false, stdout: String::new(), stderr: e.to_string(), exit_code: -1 },
    }
}

#[cfg(target_os = "linux")]
mod mpris {
    use super::AgentMessage;
    use std::collections::HashMap;
    use tokio::sync::mpsc::UnboundedSender;
    use tracing::{debug, info, warn};
    use zbus::{zvariant::OwnedValue, Connection};

    /// Key fields we compare to avoid resending identical state.
    #[derive(Clone, PartialEq, Default)]
    struct LastSent {
        title: String,
        artist: String,
        album: String,
        status: String,
        art_url: String,
    }

    pub async fn run(tx: UnboundedSender<String>) {
        loop {
            match watch(&tx).await {
                Ok(()) => break,
                Err(e) => {
                    warn!("MPRIS watcher: {e}, retrying in 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    async fn watch(tx: &UnboundedSender<String>) -> anyhow::Result<()> {
        use futures_util::StreamExt;
        use zbus::{MatchRule, MessageStream, message::Type};

        let conn = Connection::session().await?;

        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .interface("org.freedesktop.DBus.Properties")?
            .member("PropertiesChanged")?
            .build();

        let mut stream = MessageStream::for_match_rule(rule, &conn, None).await?;

        // (url, base64, mime) cache — avoid re-fetching same art URL
        let mut art_cache: Option<(String, String, &'static str)> = None;
        let mut last_sent = LastSent::default();

        push_state(&conn, tx, &mut art_cache, &mut last_sent).await;

        // Poll every 500 ms as a fallback; D-Bus signals drive real-time updates.
        let mut poll_interval = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            tokio::select! {
                msg = stream.next() => {
                    match msg {
                        Some(Ok(msg)) => {
                            if let Ok((iface,)) = msg.body().deserialize::<(String,)>() {
                                if iface == "org.mpris.MediaPlayer2.Player" {
                                    push_state(&conn, tx, &mut art_cache, &mut last_sent).await;
                                }
                            }
                        }
                        _ => break,
                    }
                }
                _ = poll_interval.tick() => {
                    push_state(&conn, tx, &mut art_cache, &mut last_sent).await;
                }
            }
        }

        Ok(())
    }

    async fn push_state(
        conn: &Connection,
        tx: &UnboundedSender<String>,
        art_cache: &mut Option<(String, String, &'static str)>,
        last_sent: &mut LastSent,
    ) {
        match build_update(conn, art_cache).await {
            Some((msg, art_url)) => {
                // Only send if something meaningful changed
                let key = LastSent {
                    title:   match &msg { AgentMessage::MediaUpdate { title,  .. } => title.clone(),  _ => String::new() },
                    artist:  match &msg { AgentMessage::MediaUpdate { artist, .. } => artist.clone(), _ => String::new() },
                    album:   match &msg { AgentMessage::MediaUpdate { album,  .. } => album.clone(),  _ => String::new() },
                    status:  match &msg { AgentMessage::MediaUpdate { status, .. } => status.clone(), _ => String::new() },
                    art_url,
                };
                if key == *last_sent {
                    return;
                }
                *last_sent = key;
                if let Ok(json) = serde_json::to_string(&msg) {
                    info!("MPRIS push: {json}");
                    let _ = tx.send(json);
                }
            }
            None => warn!("MPRIS build_update returned None"),
        }
    }

    async fn build_update(conn: &Connection, art_cache: &mut Option<(String, String, &'static str)>) -> Option<(AgentMessage, String)> {
        use zbus::{Proxy, fdo::DBusProxy};

        let dbus = DBusProxy::new(conn).await.ok()?;
        let names = dbus.list_names().await.ok()?;

        let players: Vec<String> = names.iter()
            .filter(|n| n.as_str().starts_with("org.mpris.MediaPlayer2."))
            .map(|n| n.to_string())
            .collect();

        if players.is_empty() {
            return Some((AgentMessage::MediaUpdate {
                title: String::new(), artist: String::new(),
                album: String::new(), status: "stopped".into(), art_base64: None, art_mime: String::new(),
            }, String::new()));
        }

        // Pick best player: Playing > Paused > Stopped
        let mut best: Option<(String, u8)> = None;
        for name in &players {
            let proxy = Proxy::new(conn, name.as_str(), "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player").await.ok()?;
            let status: String = proxy.get_property("PlaybackStatus").await.unwrap_or_default();
            let priority = match status.as_str() { "Playing" => 2, "Paused" => 1, _ => 0 };
            if best.as_ref().map_or(true, |(_, p)| priority > *p) {
                best = Some((name.clone(), priority));
            }
        }

        let (player_name, _) = best?;
        let proxy = Proxy::new(conn, player_name.as_str(), "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player").await.ok()?;

        let status: String = proxy.get_property("PlaybackStatus").await.unwrap_or_default();
        let metadata: HashMap<String, OwnedValue> = proxy.get_property("Metadata").await.unwrap_or_default();

        let title = str_val(&metadata, "xesam:title");
        let artist = arr_str_val(&metadata, "xesam:artist");
        let album = str_val(&metadata, "xesam:album");
        let art_url = str_val(&metadata, "mpris:artUrl");

        debug!("MPRIS: {status} - {artist} - {title} (art: {art_url})");

        let (art_base64, art_mime) = if !art_url.is_empty() {
            if art_cache.as_ref().map(|(u, _, _)| u == &art_url).unwrap_or(false) {
                let c = art_cache.as_ref().unwrap();
                (Some(c.1.clone()), c.2)
            } else {
                let result = fetch_art(&art_url).await;
                if let (Some(ref b64), mime) = result {
                    *art_cache = Some((art_url.clone(), b64.clone(), mime));
                }
                result
            }
        } else {
            *art_cache = None;
            (None, "image/jpeg")
        };

        Some((AgentMessage::MediaUpdate {
            title,
            artist,
            album,
            status: status.to_lowercase(),
            art_base64,
            art_mime: art_mime.to_string(),
        }, art_url))
    }

    async fn fetch_art(url: &str) -> (Option<String>, &'static str) {
        use base64::Engine;
        let bytes: Option<Vec<u8>> = if url.starts_with("file://") {
            let path = url.trim_start_matches("file://");
            tokio::fs::read(path).await.ok()
        } else if url.starts_with("http://") || url.starts_with("https://") {
            match reqwest::get(url).await {
                Ok(resp) => resp.bytes().await.ok().map(|b| b.to_vec()),
                Err(e) => { warn!("Art fetch error: {e}"); None }
            }
        } else {
            return (None, "image/jpeg");
        };

        match bytes {
            Some(b) => {
                let mime = if b.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
                (Some(base64::engine::general_purpose::STANDARD.encode(&b)), mime)
            }
            None => (None, "image/jpeg"),
        }
    }

    fn str_val(map: &HashMap<String, OwnedValue>, key: &str) -> String {
        use std::ops::Deref;
        use zbus::zvariant::Value;
        map.get(key).and_then(|v| {
            if let Value::Str(s) = v.deref() { Some(s.to_string()) } else { None }
        }).unwrap_or_default()
    }

    fn arr_str_val(map: &HashMap<String, OwnedValue>, key: &str) -> String {
        use std::ops::Deref;
        use zbus::zvariant::Value;
        map.get(key).and_then(|v| {
            if let Value::Array(arr) = v.deref() {
                let parts: Vec<String> = arr.iter()
                    .filter_map(|v| if let Value::Str(s) = v { Some(s.to_string()) } else { None })
                    .collect();
                Some(parts.join(", "))
            } else {
                None
            }
        }).unwrap_or_default()
    }
}
