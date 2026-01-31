use axum::{routing::get, Json, Router};
use filedock_protocol::HealthResponse;
use std::net::SocketAddr;
use tracing_subscriber::EnvFilter;

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let app = Router::new().route("/health", get(health));

    let addr: SocketAddr = "0.0.0.0:8787".parse().expect("valid listen addr");
    tracing::info!(%addr, "server listening");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind");

    axum::serve(listener, app).await.expect("serve");
}
