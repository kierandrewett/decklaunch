set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Rust
build:
    cargo build

build-release:
    cargo build --release

run-server *ARGS:
    cargo run --release --bin decklaunch-server -- {{ARGS}}

run-agent *ARGS:
    cargo run --release --bin decklaunch-agent -- {{ARGS}}

print-token:
    cargo run --release --bin decklaunch-server -- --print-token

fmt:
    cargo fmt --all

clippy:
    cargo clippy --all-targets --all-features -- -D warnings

test:
    cargo test --workspace

# Docker
docker-build:
    docker build -t decklaunch-server .

docker-up:
    docker compose up -d --build

docker-down:
    docker compose down

compose-up file="./compose.yaml":
    docker compose -f {{file}} up -d --no-deps --build

# Android
android-build:
    cd android && ./gradlew :app:assembleDebug

android-install:
    cd android && adb install -r app/build/outputs/apk/debug/app-debug.apk

android-build-install:
    cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk

android-type-token:
    token_file="$HOME/.config/decklaunch/token"; \
    [[ -f "$token_file" ]] || { echo "Token file not found: $token_file"; exit 1; }; \
    token="$(tr -d '\n\r' < "$token_file")"; \
    [[ -n "$token" ]] || { echo "Token file is empty: $token_file"; exit 1; }; \
    adb wait-for-device; \
    adb shell input text "$token"

android-type-token-value token:
    [[ -n "{{token}}" ]] || { echo "Usage: just android-type-token-value <token>"; exit 1; }; \
    adb wait-for-device; \
    adb shell input text "{{token}}"

# Agent
agent-install:
    ./install-agent.sh
