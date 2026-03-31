FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY server/ server/
COPY agent/ agent/
RUN cargo build --release --bin decklaunch-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/decklaunch-server /usr/local/bin/
EXPOSE 8080
ENTRYPOINT ["decklaunch-server"]
