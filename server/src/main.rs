mod config;
mod polling;
mod server;
mod state;
mod ws_agent;
mod ws_panel;

use clap::Parser;
use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "decklaunch-server", about = "DeckLaunch server")]
struct Args {
    /// Port to listen on
    #[arg(long, env = "DECK_PORT", default_value = "8080")]
    port: u16,

    /// Auth token (overrides stored token)
    #[arg(long, env = "DECK_TOKEN")]
    token: Option<String>,

    /// Print the current token and exit
    #[arg(long)]
    print_token: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    let token = config::load_or_generate_token(args.token).await?;

    if args.print_token {
        println!("{token}");
        return Ok(());
    }

    let cfg = config::load_config().await?;
    info!("Loaded config from {}", config::config_path().display());

    let app_state = state::AppState::new(cfg, token.clone());

    // Start polling engine
    let polling_state = app_state.clone();
    tokio::spawn(async move {
        polling::run_polling_engine(polling_state).await;
    });

    let router = server::create_router(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));
    info!("Listening on http://{addr}");
    info!("Panel UI:  http://{addr}/?token={token}");
    info!("Config UI: http://{addr}/config");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}
