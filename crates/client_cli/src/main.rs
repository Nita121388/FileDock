use clap::{Parser, Subcommand};
use filedock_protocol::{
    is_valid_chunk_hash, ChunkPresenceRequest, ChunkPresenceResponse, HealthResponse,
    SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest, ManifestFileEntry,
};
use std::path::PathBuf;
use walkdir::WalkDir;

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

    /// Upload a folder as a snapshot manifest (MVP: each file is uploaded as a single chunk).
    PushFolder {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Device name to store in snapshot metadata (free-form).
        #[arg(long)]
        device: String,

        /// Root folder to back up.
        #[arg(long)]
        folder: PathBuf,
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

            let pres_resp = chunk_presence(&client, &server, vec![hash.clone()]).await?;

            if pres_resp.missing.is_empty() {
                println!("already present: {hash}");
                return Ok(());
            }

            // Upload missing chunk
            put_chunk(&client, &server, &hash, data).await?;

            println!("uploaded: {hash}");
        }

        Command::PushFolder {
            server,
            device,
            folder,
        } => {
            let client = reqwest::Client::new();

            let root = folder
                .canonicalize()
                .map_err(|e| format!("canonicalize folder: {e}"))?;

            // Create snapshot id
            let create_url = format!("{}/v1/snapshots", server.trim_end_matches('/'));
            let create_req = SnapshotCreateRequest {
                device_name: device,
                root_path: root.display().to_string(),
            };
            let create_resp: SnapshotCreateResponse = client
                .post(create_url)
                .json(&create_req)
                .send()
                .await
                .map_err(|e| format!("create snapshot request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("create snapshot response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("create snapshot decode: {e}"))?;

            let snapshot_id = create_resp.snapshot_id;
            println!("snapshot: {snapshot_id}");

            let mut files = Vec::new();

            for entry in WalkDir::new(&root).follow_links(false) {
                let entry = entry.map_err(|e| format!("walkdir: {e}"))?;
                if !entry.file_type().is_file() {
                    continue;
                }

                let abs_path = entry.path().to_path_buf();
                let rel = abs_path
                    .strip_prefix(&root)
                    .map_err(|e| format!("strip prefix: {e}"))?;
                let rel_str = rel
                    .iter()
                    .map(|s| s.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");

                let meta = tokio::fs::metadata(&abs_path)
                    .await
                    .map_err(|e| format!("stat file: {e}"))?;
                let size = meta.len();
                let mtime_unix = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let data = tokio::fs::read(&abs_path)
                    .await
                    .map_err(|e| format!("read file: {e}"))?;
                let hash = blake3::hash(&data).to_hex().to_string();
                if !is_valid_chunk_hash(&hash) {
                    return Err("unexpected hash format".to_string());
                }

                let pres_resp = chunk_presence(&client, &server, vec![hash.clone()]).await?;
                if !pres_resp.missing.is_empty() {
                    put_chunk(&client, &server, &hash, data).await?;
                }

                files.push(ManifestFileEntry {
                    path: rel_str,
                    size,
                    mtime_unix,
                    chunk_hash: hash,
                });
            }

            let manifest = SnapshotManifest {
                snapshot_id: snapshot_id.clone(),
                created_unix: now_unix(),
                files,
            };

            let put_url = format!(
                "{}/v1/snapshots/{}/manifest",
                server.trim_end_matches('/'),
                snapshot_id
            );
            client
                .put(put_url)
                .json(&manifest)
                .send()
                .await
                .map_err(|e| format!("put manifest request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("put manifest response: {e}"))?;

            println!("manifest uploaded: {snapshot_id}");
        }
    }

    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn chunk_presence(
    client: &reqwest::Client,
    server: &str,
    hashes: Vec<String>,
) -> Result<ChunkPresenceResponse, String> {
    let presence_url = format!("{}/v1/chunks/presence", server.trim_end_matches('/'));
    let pres_req = ChunkPresenceRequest { hashes };
    client
        .post(presence_url)
        .json(&pres_req)
        .send()
        .await
        .map_err(|e| format!("presence request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("presence response: {e}"))?
        .json()
        .await
        .map_err(|e| format!("presence decode: {e}"))
}

async fn put_chunk(
    client: &reqwest::Client,
    server: &str,
    hash: &str,
    data: Vec<u8>,
) -> Result<(), String> {
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
    Ok(())
}
