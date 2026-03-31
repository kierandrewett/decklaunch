use crate::config::{TileAction, TileType, WeatherConfig, StocksConfig, VOLUME_POLL_CMD, MIC_POLL_CMD, stocks_history_path};
use crate::state::{AppState, ExecResult, TileState};
use axum::extract::ws::Message;
use chrono::Local;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
use tracing::{debug, warn};

pub async fn run_polling_engine(state: Arc<AppState>) {
    loop {
        let config = state.config.read().await.clone();
        drop(state.config.read().await); // just clone once

        // Collect (tile_id, agent, command, interval) for all pollable tiles
        let poll_tiles: Vec<(String, String, String, Duration)> = config
            .tiles
            .iter()
            .filter_map(|t| {
                let agent = t.action.as_ref().and_then(|a| match a {
                    TileAction::PcPoll { agent, .. } => Some(agent.clone()),
                    _ => None,
                })?;
                let (command, interval) = match &t.tile_type {
                    TileType::Volume => (VOLUME_POLL_CMD.to_string(), Duration::from_secs(5)),
                    TileType::Mic    => (MIC_POLL_CMD.to_string(),    Duration::from_secs(5)),
                    TileType::PcData => {
                        if let Some(TileAction::PcPoll { command, interval_seconds, .. }) = &t.action {
                            (command.clone(), Duration::from_secs((*interval_seconds).max(5)))
                        } else {
                            return None;
                        }
                    }
                    _ => return None,
                };
                if agent.is_empty() { return None; }
                Some((t.id.clone(), agent, command, interval))
            })
            .collect();

        // Spawn a task per tile
        let mut handles = vec![];
        for (tile_id, agent, command, interval) in poll_tiles {
            let state_clone = state.clone();
            let handle = tokio::spawn(async move {
                // Small random stagger to avoid burst
                let jitter_ms = rand_jitter_ms();
                tokio::time::sleep(Duration::from_millis(jitter_ms)).await;

                let mut ticker = tokio::time::interval(interval);
                loop {
                    ticker.tick().await;
                    poll_tile(&state_clone, &tile_id, &agent, &command).await;
                }
            });
            handles.push(handle);
        }

        // Also poll weather tiles
        let weather_tiles: Vec<_> = config
            .tiles
            .iter()
            .filter(|t| t.tile_type == TileType::Weather)
            .cloned()
            .collect();

        for tile in weather_tiles {
            let state_clone = state.clone();
            let tile_id = tile.id.clone();
            let weather_cfg = tile.weather.clone();
            let handle = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(600)); // 10 min
                loop {
                    ticker.tick().await;
                    poll_weather(&state_clone, &tile_id, weather_cfg.as_ref()).await;
                }
            });
            handles.push(handle);
        }

        // Poll stocks tiles
        let stocks_tiles: Vec<_> = config
            .tiles
            .iter()
            .filter(|t| t.tile_type == TileType::Stocks)
            .cloned()
            .collect();

        for tile in stocks_tiles {
            let state_clone = state.clone();
            let tile_id = tile.id.clone();
            let stocks_cfg = tile.stocks.clone();
            let handle = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(30));
                loop {
                    ticker.tick().await;
                    poll_stocks(&state_clone, &tile_id, stocks_cfg.as_ref()).await;
                }
            });
            handles.push(handle);
        }

        // Wait for a config reload signal
        // We subscribe to the panel broadcast and look for "reload"
        let mut rx = state.panel_tx.subscribe();
        let reload_signal = async {
            loop {
                if let Ok(msg) = rx.recv().await {
                    if msg.contains(r#""type":"reload""#) {
                        return;
                    }
                }
            }
        };

        reload_signal.await;

        // Cancel all handles and restart
        for h in handles {
            h.abort();
        }
    }
}

async fn poll_tile(state: &Arc<AppState>, tile_id: &str, agent_id: &str, command: &str) {
    let exec_id = uuid::Uuid::new_v4().to_string();

    let agent_tx = {
        let agents = state.agents.lock().await;
        agents.get(agent_id).map(|a| a.tx.clone())
    };

    let agent_tx = match agent_tx {
        Some(tx) => tx,
        None => {
            debug!("Polling: agent {agent_id} not connected for tile {tile_id}");
            let mut states = state.tile_states.write().await;
            states.insert(
                tile_id.to_string(),
                TileState {
                    data: None,
                    stale: true,
                },
            );
            drop(states);
            state.push_full_state().await;
            return;
        }
    };

    let exec_msg = serde_json::json!({
        "type": "exec",
        "id": exec_id,
        "command": command,
    });

    let (tx, rx) = tokio::sync::oneshot::channel::<ExecResult>();
    {
        let mut pending = state.pending_execs.lock().await;
        pending.insert(exec_id.clone(), tx);
    }

    if agent_tx
        .send(Message::Text(exec_msg.to_string()))
        .is_err()
    {
        warn!("Failed to send exec for tile {tile_id}");
        let mut pending = state.pending_execs.lock().await;
        pending.remove(&exec_id);
        return;
    }

    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(result)) => {
            let data = if result.ok {
                result.stdout.trim().to_string()
            } else {
                format!("err: {}", result.stderr.trim())
            };
            let mut states = state.tile_states.write().await;
            states.insert(
                tile_id.to_string(),
                TileState {
                    data: Some(data),
                    stale: false,
                },
            );
            drop(states);
            state.push_full_state().await;
        }
        _ => {
            warn!("Exec timeout for tile {tile_id}");
            let mut states = state.tile_states.write().await;
            if let Some(s) = states.get_mut(tile_id) {
                s.stale = true;
            }
            let mut pending = state.pending_execs.lock().await;
            pending.remove(&exec_id);
            drop(pending);
            drop(states);
            state.push_full_state().await;
        }
    }
}

async fn poll_weather(state: &Arc<AppState>, tile_id: &str, cfg: Option<&WeatherConfig>) {
    let (lat, lon, location) = cfg
        .map(|c| (c.lat, c.lon, c.location.as_str()))
        .unwrap_or((51.5, -0.12, "London"));

    let url = format!(
        "https://api.open-meteo.com/v1/forecast\
         ?latitude={lat}&longitude={lon}\
         &current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day\
         &daily=weather_code,temperature_2m_max,temperature_2m_min\
         &wind_speed_unit=kmh&temperature_unit=celsius&timezone=auto&forecast_days=5"
    );

    match reqwest::get(&url).await {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(json) => {
                let c = &json["current"];
                let temp       = c["temperature_2m"].as_f64().unwrap_or(0.0);
                let feels_like = c["apparent_temperature"].as_f64().unwrap_or(0.0);
                let humidity   = c["relative_humidity_2m"].as_i64().unwrap_or(0);
                let wind       = c["wind_speed_10m"].as_f64().unwrap_or(0.0);
                let code       = c["weather_code"].as_i64().unwrap_or(0);
                let is_day     = c["is_day"].as_i64().unwrap_or(1);

                // Build forecast: skip index 0 (today), take next 4 days
                let daily = &json["daily"];
                let times    = daily["time"].as_array();
                let codes    = daily["weather_code"].as_array();
                let max_temps = daily["temperature_2m_max"].as_array();
                let min_temps = daily["temperature_2m_min"].as_array();

                let forecast: Vec<serde_json::Value> = (1..=4)
                    .filter_map(|i| {
                        let date = times?.get(i)?.as_str()?;
                        let fc = codes?.get(i)?.as_i64().unwrap_or(0);
                        let hi = max_temps?.get(i)?.as_f64().unwrap_or(0.0);
                        let lo = min_temps?.get(i)?.as_f64().unwrap_or(0.0);
                        let day = day_abbrev(date);
                        Some(serde_json::json!({
                            "day":  day,
                            "icon": weather_code_icon(fc, 1),
                            "hi":   format!("{hi:.0}°"),
                            "lo":   format!("{lo:.0}°"),
                        }))
                    })
                    .collect();

                let data = serde_json::json!({
                    "temp":      format!("{temp:.0}°"),
                    "feelsLike": format!("{feels_like:.0}°"),
                    "humidity":  humidity,
                    "wind":      format!("{wind:.0} km/h"),
                    "condition": weather_code_description(code),
                    "icon":      weather_code_icon(code, is_day),
                    "location":  location,
                    "forecast":  forecast,
                });

                let mut states = state.tile_states.write().await;
                states.insert(tile_id.to_string(), TileState {
                    data: Some(data.to_string()),
                    stale: false,
                });
                drop(states);
                state.push_full_state().await;
            }
            Err(e) => warn!("Weather JSON parse error: {e}"),
        },
        Err(e) => warn!("Weather fetch error: {e}"),
    }
}

async fn load_stocks_history() -> HashMap<String, f64> {
    match fs::read_to_string(stocks_history_path()).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

async fn save_stocks_history(history: &HashMap<String, f64>) {
    let path = stocks_history_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent).await;
    }
    if let Ok(data) = serde_json::to_string(history) {
        let _ = fs::write(&path, data).await;
    }
}

fn calc_period(history: &HashMap<String, f64>, today: &str, days_ago: i64, current: f64) -> serde_json::Value {
    let target = (Local::now() - chrono::Duration::days(days_ago)).format("%Y-%m-%d").to_string();
    let base_val = history.keys()
        .filter(|k| k.as_str() <= target.as_str() && k.as_str() < today)
        .max()
        .and_then(|k| history.get(k))
        .copied();
    match base_val {
        Some(base) if base > 0.0 => {
            let change = current - base;
            let pct = change / base * 100.0;
            serde_json::json!({
                "change": format!("{change:+.0}"),
                "pct":    format!("{pct:+.1}%"),
                "sign":   if change >= 0.0 { "up" } else { "down" }
            })
        }
        _ => serde_json::Value::Null,
    }
}

async fn poll_stocks(state: &Arc<AppState>, tile_id: &str, cfg: Option<&StocksConfig>) {
    let Some(cfg) = cfg else {
        warn!("Stocks tile {tile_id} has no stocks config");
        return;
    };

    let base = if cfg.mode == "demo" {
        "https://demo.trading212.com"
    } else {
        "https://live.trading212.com"
    };
    let url = format!("{base}/api/v0/equity/positions");

    let credentials = base64_encode(format!("{}:{}", cfg.api_key, cfg.secret_key).as_bytes());
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Basic {credentials}"))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status();
            let body = match r.text().await {
                Ok(t) => t,
                Err(e) => { warn!("Stocks read body error for tile {tile_id}: {e}"); return; }
            };
            if !status.is_success() {
                warn!("Stocks API error {status} for tile {tile_id}: {body}");
                return;
            }
            match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(json) => {
                // API returns { "items": [...] } or directly an array depending on version
                let items = json.get("items")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .or_else(|| json.as_array().cloned())
                    .unwrap_or_default();

                if items.is_empty() {
                    tracing::info!("Stocks raw response for tile {tile_id}: {body}");
                } else {
                    tracing::info!("Stocks first item for tile {tile_id}: {}", items[0]);
                }

                let mut positions: Vec<serde_json::Value> = items
                    .iter()
                    .filter_map(|item| {
                        // Try multiple field name variants
                        let ticker = item["ticker"].as_str()
                            .or_else(|| item["symbol"].as_str())
                            .or_else(|| item["instrument"].as_str())
                            .unwrap_or("?")
                            .to_string();
                        let qty = item["quantity"].as_f64()
                            .or_else(|| item["shares"].as_f64())
                            .unwrap_or(0.0);
                        let avg = item["averagePricePaid"].as_f64()
                            .or_else(|| item["averagePrice"].as_f64())
                            .unwrap_or(0.0);
                        let current = item["currentPrice"].as_f64().unwrap_or(0.0);
                        let ppl = item["ppl"].as_f64()
                            .or_else(|| item["unrealisedPnl"].as_f64())
                            .unwrap_or_else(|| (current - avg) * qty);
                        // avg (averagePricePaid) and ppl are both in account currency (GBP),
                        // so avg * qty + ppl gives current market value in account currency.
                        // Using qty * currentPrice would be wrong for non-GBP instruments.
                        let value    = avg * qty + ppl;
                        let invested = avg * qty;
                        let pct_chg  = if invested > 0.0 { ppl / invested * 100.0 } else { 0.0 };
                        Some(serde_json::json!({
                            "ticker":  ticker,
                            "price":   format!("{current:.2}"),
                            "ppl":     format!("{ppl:+.2}"),
                            "pplSign": if ppl >= 0.0 { "up" } else { "down" },
                            "pct":     format!("{pct_chg:+.1}%"),
                            "value":   format!("{value:.2}"),
                            "qty":     format!("{qty:.4}").trim_end_matches('0').trim_end_matches('.').to_string(),
                        }))
                    })
                    .collect();

                // Sort by absolute P&L descending
                positions.sort_by(|a, b| {
                    let pa = a["ppl"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0).abs();
                    let pb = b["ppl"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0).abs();
                    pb.partial_cmp(&pa).unwrap_or(std::cmp::Ordering::Equal)
                });

                // Compute totals from the already-processed positions (consistent with what we display)
                let total_ppl: f64 = positions.iter()
                    .filter_map(|p| p["ppl"].as_str())
                    .filter_map(|s| s.parse::<f64>().ok())
                    .sum();
                let total_val: f64 = positions.iter()
                    .filter_map(|p| p["value"].as_str())
                    .filter_map(|s| s.parse::<f64>().ok())
                    .sum();

                // Load history, update today's snapshot, compute period changes
                let today = Local::now().format("%Y-%m-%d").to_string();
                let mut history = load_stocks_history().await;
                history.insert(today.clone(), total_val);
                // Prune entries older than 400 days
                let cutoff = (Local::now() - chrono::Duration::days(400)).format("%Y-%m-%d").to_string();
                history.retain(|k, _| k.as_str() >= cutoff.as_str());
                save_stocks_history(&history).await;

                let period_1d = calc_period(&history, &today, 1, total_val);
                let period_2d = calc_period(&history, &today, 2, total_val);
                let period_3d = calc_period(&history, &today, 3, total_val);
                let period_1w = calc_period(&history, &today, 7, total_val);
                let period_1m = calc_period(&history, &today, 30, total_val);

                // YTD: latest snapshot before Jan 1 of this year, or earliest snapshot this year
                let year_start = format!("{}-01-01", Local::now().format("%Y"));
                let ytd_base = history.keys()
                    .filter(|k| k.as_str() < year_start.as_str())
                    .max()
                    .or_else(|| {
                        history.keys()
                            .filter(|k| k.as_str() >= year_start.as_str() && k.as_str() < today.as_str())
                            .min()
                    })
                    .and_then(|k| history.get(k))
                    .copied();
                let period_ytd = match ytd_base {
                    Some(base) if base > 0.0 => {
                        let change = total_val - base;
                        let pct = change / base * 100.0;
                        serde_json::json!({
                            "change": format!("{change:+.0}"),
                            "pct":    format!("{pct:+.1}%"),
                            "sign":   if change >= 0.0 { "up" } else { "down" }
                        })
                    }
                    _ => serde_json::Value::Null,
                };

                let data = serde_json::json!({
                    "positions": positions,
                    "totalPpl":  format!("{total_ppl:+.2}"),
                    "totalPplSign": if total_ppl >= 0.0 { "up" } else { "down" },
                    "totalValue": format!("{total_val:.2}"),
                    "periods": {
                        "1d":  period_1d,
                        "2d":  period_2d,
                        "3d":  period_3d,
                        "1w":  period_1w,
                        "1m":  period_1m,
                        "ytd": period_ytd,
                    }
                });

                let mut states = state.tile_states.write().await;
                states.insert(tile_id.to_string(), TileState {
                    data: Some(data.to_string()),
                    stale: false,
                });
                drop(states);
                state.push_full_state().await;
            }
            Err(e) => warn!("Stocks JSON parse error for tile {tile_id}: {e} — body: {body}"),
        }
        },
        Err(e) => warn!("Stocks fetch error for tile {tile_id}: {e}"),
    }
}

fn day_abbrev(date: &str) -> &'static str {
    // date is "YYYY-MM-DD"; derive weekday from it
    // Simple approach: use a lookup on the day-of-week
    use std::time::{SystemTime, UNIX_EPOCH};
    // Parse YYYY-MM-DD manually
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 { return "—"; }
    let (Ok(y), Ok(m), Ok(d)) = (parts[0].parse::<i32>(), parts[1].parse::<i32>(), parts[2].parse::<i32>()) else { return "—" };
    // Tomohiko Sakamoto's algorithm for day of week (0=Sun)
    let t: [i32; 12] = [0,3,2,5,0,3,5,1,4,6,2,4];
    let yy = if m < 3 { y - 1 } else { y };
    let dow = ((yy + yy/4 - yy/100 + yy/400 + t[(m-1) as usize] + d) % 7 + 7) % 7;
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dow as usize]
}

fn weather_code_description(code: i64) -> &'static str {
    match code {
        0           => "Clear",
        1 | 2 | 3   => "Partly cloudy",
        45 | 48     => "Fog",
        51 | 53 | 55 => "Drizzle",
        61 | 63 | 65 => "Rain",
        71 | 73 | 75 => "Snow",
        80 | 81 | 82 => "Showers",
        95          => "Thunderstorm",
        96 | 99     => "Hail storm",
        _           => "Cloudy",
    }
}

fn weather_code_icon(code: i64, is_day: i64) -> &'static str {
    match code {
        0           => if is_day == 1 { "sun" } else { "star" },
        1 | 2 | 3   => "cloud",
        45 | 48     => "cloud",
        51 | 53 | 55 | 61 | 63 | 65 | 80 | 81 | 82 => "cloud-rain",
        71 | 73 | 75 => "cloud-snow",
        95 | 96 | 99 => "zap",
        _           => "cloud",
    }
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn rand_jitter_ms() -> u64 {
    use rand::Rng;
    rand::thread_rng().gen_range(0..5000)
}
