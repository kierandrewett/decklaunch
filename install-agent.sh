#!/usr/bin/env bash
set -euo pipefail

BINARY="decklaunch-agent"
INSTALL_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/decklaunch"
ENV_FILE="$CONFIG_DIR/agent.env"
SERVICE_FILE="$HOME/.config/systemd/user/decklaunch-agent.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build
echo "Building $BINARY..."
cargo build --release --bin "$BINARY" --manifest-path "$SCRIPT_DIR/Cargo.toml"

# Install binary
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/target/release/$BINARY" "$INSTALL_DIR/$BINARY"
echo "Installed $INSTALL_DIR/$BINARY"

# Create env file if it doesn't exist
mkdir -p "$CONFIG_DIR"
if [ ! -f "$ENV_FILE" ]; then
    read -rp "Server WebSocket URL (e.g. ws://192.168.1.10:8080/ws/agent): " server_url
    read -rp "Auth token: " auth_token
    cat > "$ENV_FILE" <<EOF
DECK_SERVER=$server_url
DECK_TOKEN=$auth_token
EOF
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE"
else
    echo "$ENV_FILE already exists, skipping"
fi

# Install systemd service
mkdir -p "$(dirname "$SERVICE_FILE")"
cp "$SCRIPT_DIR/decklaunch-agent.service" "$SERVICE_FILE"
echo "Installed systemd service"

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now decklaunch-agent.service
echo "Service started. Check status with: systemctl --user status decklaunch-agent"
