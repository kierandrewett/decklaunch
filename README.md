# DeckLaunch

Turn an Android phone into a stream deck / command panel.

```
┌─────────────────────┐        ┌──────────────┐
│   Rust Server       │◄──WS──►│  Android App │
│   (home server)     │        │  (WebView)   │
│                     │        └──────────────┘
│   /         Panel UI│
│   /config   Config  │        ┌──────────────┐
│   /api/*    REST    │◄──WS──►│  Rust Agent  │
│   /ws/panel  WS     │        │  (your PC)   │
│   /ws/agent  WS     │        └──────────────┘
└─────────────────────┘
```

## Components

- **`server/`** — Rust/axum server. Hosts the panel + config UIs, REST API, WebSocket endpoints, polling engine.
- **`agent/`** — Rust agent daemon. Runs on your PC. Executes shell commands on behalf of the server.
- **`android/`** — Kotlin Android app. Full-screen WebView launcher + native JS bridge.
- **`server/static/panel/`** — Panel web UI (what the phone displays).
- **`server/static/config/`** — Config editor web UI (use from a desktop browser).

## Quick start

### 1. Build

```bash
cargo build --release
```

Produces:
- `target/release/decklaunch-server`
- `target/release/decklaunch-agent`

### 2. Run the server (home server)

```bash
./target/release/decklaunch-server
```

On first run, a random auth token is generated and saved to `~/.config/decklaunch/token`. It's printed to stdout:

```
Generated auth token: a1b2c3d4...
Panel UI:  http://0.0.0.0:8080/?token=a1b2c3d4...
Config UI: http://0.0.0.0:8080/config
```

Options:
```
--port <PORT>     Listen port (default: 8080, env: DECK_PORT)
--token <TOKEN>   Override auth token (env: DECK_TOKEN)
--print-token     Print the current token and exit
```

### 3. Run the agent (your PC)

```bash
./target/release/decklaunch-agent \
  --server ws://your-server-ip:8080/ws/agent \
  --token <token>
```

The agent connects, identifies itself by hostname, and waits for `exec` commands. It reconnects automatically on disconnect.

### 4. Configure the panel

Open `http://your-server-ip:8080/config` in a desktop browser. You'll be prompted for the auth token.

- Add/remove tiles by clicking **+ Add Tile**
- Drag tiles to reposition them
- Click a tile to edit its properties in the right panel
- Press **Ctrl+S** or click **Save** to apply

### 5. Android app

Build the Android app with Android Studio or:
```bash
cd android
./gradlew assembleDebug
```

On first launch, enter the server URL (`http://server-ip:8080`) and the auth token. The app saves these to SharedPreferences and loads the panel in a full-screen WebView.

The app registers as a home screen — set it as your default launcher in Android settings.

## Auth

All endpoints require the pre-shared token:

| Endpoint | How to auth |
|---|---|
| `GET /` (panel) | `?token=<tok>` or `Authorization: Bearer <tok>` |
| `GET /config` | Config UI handles it via login page |
| `/api/*` | `Authorization: Bearer <tok>` or `?token=<tok>` |
| `/ws/panel` | First message: `{"type":"auth","token":"..."}` |
| `/ws/agent` | First message: `{"type":"auth","token":"..."}` |

## Tile types

| Type | Description |
|---|---|
| `app` | Taps call `Native.launchApp(packageName)` on the phone |
| `command` | Fire-and-forget shell command on a named agent |
| `pc_data` | Polled shell command; displays stdout as tile data |
| `shortcut` | Opens a URL in the browser |
| `weather` | Server polls Open-Meteo, displays temp + condition |
| `media` | Phone polls `Native.getNowPlaying()` via JS bridge |
| `clock` | Client-side live clock |
| `spacer` | Empty tile |

## Config file

`~/.config/decklaunch/config.json` — see `server/src/config.rs` for the full schema.

Example `pc_data` commands:
```bash
# Volume
pactl get-sink-volume @DEFAULT_SINK@ | grep -oP '\d+%' | head -1
# CPU temp
sensors | grep 'Package' | awk '{print $4}'
# Mouse battery (Solaar)
solaar show | grep Battery | awk '{print $3}'
# Now playing
playerctl metadata --format '{{artist}} - {{title}}'
# GPU usage
nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader
```

## Native bridge (Android)

The panel JS can call these methods via `window.Native`:

```js
Native.launchApp("com.android.chrome")
Native.getInstalledApps()       // JSON array of {packageName, appName, iconBase64}
Native.getDeviceInfo()          // JSON {deviceName, model, batteryLevel, wifiSsid}
Native.getNowPlaying()          // JSON {title, artist, album, state, albumArtBase64}
Native.mediaControl("play")     // play | pause | next | previous
```
