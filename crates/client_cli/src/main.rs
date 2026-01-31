use clap::{Parser, Subcommand};
use filedock_protocol::{is_valid_chunk_hash, ChunkPresenceRequest, ChunkPresenceResponse, HealthResponse};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "filedock", version, about = "FileDock CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Print a basic JSON structure used by the protocol crate.
    HealthSample,

    /// Upload a file as a single chunk to a FileDock server (MVP).
    PushFile {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Path to a local file.
        #[arg(long)]
        file: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let cli = Cli::parse();

    match cli.command {
        Command::HealthSample => {
            let resp = HealthResponse {
                status: "ok".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }
        Command::PushFile { server, file } => {
            let data = tokio::fs::read(&file)
                .await
                .map_err(|e| format!("read file: {e}"))?;
            let hash = blake3::hash(&data).to_hex().to_string();
            if !is_valid_chunk_hash(&hash) {
                return Err("unexpected hash format".to_string());
            }

            let client = reqwest::Client::new();

            let presence_url = format!("{}/v1/chunks/presence", server.trim_end_matches('/'));
            let pres_req = ChunkPresenceRequest {
                hashes: vec![hash.clone()],
            };
            let pres_resp: ChunkPresenceResponse = client
                .post(presence_url)
                .json(&pres_req)
                .send()
                .await
                .map_err(|e| format!("presence request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("presence response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("presence decode: {e}"))?;

            if pres_resp.missing.is_empty() {
                println!("already present: {hash}");
                return Ok(());
            }

            // Upload missing chunk
            let put_url = format!(
                "{}/v1/chunks/{}",
                server.trim_end_matches('/'),
                hash
            );
            let resp = client
                .put(put_url)
                .body(data)
                .send()
                .await
                .map_err(|e| format!("upload request: {e}"))?;

            if !resp.status().is_success() {
                return Err(format!("upload failed: {}", resp.status()));
            }

            println!("uploaded: {hash}");
        }
    }

    Ok(())
}

