use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub columns: u32,
    pub rows: u32,
    #[serde(default)]
    pub agents: HashMap<String, KnownAgent>,
    #[serde(default)]
    pub tiles: Vec<Tile>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            columns: 4,
            rows: 3,
            agents: HashMap::new(),
            tiles: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownAgent {
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tile {
    pub id: String,
    pub position: TilePosition,
    #[serde(rename = "type")]
    pub tile_type: TileType,
    #[serde(default)]
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<TileAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather: Option<WeatherConfig>,
    #[serde(rename = "showSeconds", default, skip_serializing_if = "is_false")]
    pub show_seconds: bool,
    #[serde(rename = "hideControls", default, skip_serializing_if = "is_false")]
    pub hide_controls: bool,
    #[serde(rename = "liveRing", default, skip_serializing_if = "is_false")]
    pub live_ring: bool,
    #[serde(rename = "iconVariants", default, skip_serializing_if = "Vec::is_empty")]
    pub icon_variants: Vec<IconVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calendar: Option<CalendarConfig>,
    #[serde(rename = "tapUrl", skip_serializing_if = "Option::is_none")]
    pub tap_url: Option<String>,
    #[serde(rename = "tapApp", skip_serializing_if = "Option::is_none")]
    pub tap_app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stocks: Option<StocksConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StocksConfig {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "secretKey")]
    pub secret_key: String,
    /// "live" or "demo"
    #[serde(default = "default_stocks_mode")]
    pub mode: String,
}

fn default_stocks_mode() -> String {
    "live".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarConfig {
    #[serde(rename = "calendarId", skip_serializing_if = "Option::is_none")]
    pub calendar_id: Option<String>,
    #[serde(default = "default_calendar_days")]
    pub days: u32,
}

fn default_calendar_days() -> u32 {
    14
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IconVariant {
    pub when: String,
    pub icon: String,
}

fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherConfig {
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TilePosition {
    pub row: u32,
    pub col: u32,
    #[serde(rename = "rowSpan", default = "one")]
    pub row_span: u32,
    #[serde(rename = "colSpan", default = "one")]
    pub col_span: u32,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TileType {
    App,
    Command,
    PcData,
    Shortcut,
    Weather,
    Media,
    Clock,
    Calendar,
    Spacer,
    Volume,
    Mic,
    Stocks,
}

/// Built-in shell commands for Volume and Mic tiles (run via `sh -c` on the agent).
pub const VOLUME_POLL_CMD: &str = r#"M=$(pactl get-sink-mute @DEFAULT_SINK@); if echo "$M" | grep -q yes; then echo 0%; else printf '%s%%' "$(pactl get-sink-volume @DEFAULT_SINK@ | grep -oP '\d+(?=%)' | head -1)"; fi"#;
pub const MIC_POLL_CMD: &str = r#"M=$(pactl get-source-mute @DEFAULT_SOURCE@); if echo "$M" | grep -q yes; then echo 0%; else printf '%s%%' "$(pactl get-source-volume @DEFAULT_SOURCE@ | grep -oP '\d+(?=%)' | head -1)"; fi"#;
pub const VOLUME_SET_CMD: &str = "pactl set-sink-volume @DEFAULT_SINK@";
pub const MIC_SET_CMD: &str = "pactl set-source-volume @DEFAULT_SOURCE@";
pub const VOLUME_MUTE_CMD: &str = "pactl set-sink-mute @DEFAULT_SINK@ toggle";
pub const MIC_MUTE_CMD: &str = "pactl set-source-mute @DEFAULT_SOURCE@ toggle";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TileAction {
    LaunchApp {
        #[serde(rename = "packageName")]
        package_name: String,
    },
    PcCommand {
        agent: String,
        command: String,
    },
    PcPoll {
        agent: String,
        #[serde(default)]
        command: String,
        #[serde(rename = "intervalSeconds", default = "default_interval")]
        interval_seconds: u64,
        #[serde(rename = "tapCommand", skip_serializing_if = "Option::is_none")]
        tap_command: Option<String>,
        #[serde(rename = "dragCommand", skip_serializing_if = "Option::is_none")]
        drag_command: Option<String>,
    },
    OpenUrl {
        url: String,
    },
}

fn default_interval() -> u64 {
    60
}

pub fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("decklaunch").join("config.json")
}

pub fn token_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("decklaunch").join("token")
}

pub fn stocks_history_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("decklaunch").join("stocks_history.json")
}

pub async fn load_config() -> anyhow::Result<Config> {
    let path = config_path();
    if !path.exists() {
        return Ok(Config::default());
    }
    let data = fs::read_to_string(&path).await?;
    let config = serde_json::from_str(&data)?;
    Ok(config)
}

pub async fn save_config(config: &Config) -> anyhow::Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let data = serde_json::to_string_pretty(config)?;
    fs::write(&path, data).await?;
    Ok(())
}

pub async fn load_or_generate_token(override_token: Option<String>) -> anyhow::Result<String> {
    if let Some(t) = override_token {
        return Ok(t);
    }
    let path = token_path();
    if path.exists() {
        let token = fs::read_to_string(&path).await?.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    // Generate new token
    let token = generate_token();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(&path, &token).await?;
    println!("Generated auth token: {token}");
    println!("Token saved to: {}", path.display());
    Ok(token)
}

fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect()
}
