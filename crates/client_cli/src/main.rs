use clap::{Parser, Subcommand};
use filedock_protocol::{
    is_valid_chunk_hash, ChunkPresenceRequest, ChunkPresenceResponse, HealthResponse,
    ChunkRef, SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest, ManifestFileEntry,
    TreeResponse, SnapshotMeta,
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

    /// List a snapshot directory (server-side) using the uploaded manifest.
    Tree {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Snapshot id.
        #[arg(long)]
        snapshot: String,

        /// Relative directory path inside the snapshot (empty = root).
        #[arg(long, default_value = "")]
        path: String,
    },

    /// Download a file from a snapshot by relative path.
    PullFile {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Snapshot id.
        #[arg(long)]
        snapshot: String,

        /// Relative file path inside the snapshot.
        #[arg(long)]
        path: String,

        /// Output file path (local).
        #[arg(long)]
        out: PathBuf,
    },

    /// Download an entire snapshot to a local folder.
    PullFolder {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Snapshot id.
        #[arg(long)]
        snapshot: String,

        /// Output folder.
        #[arg(long)]
        out: PathBuf,
    },

    /// List snapshots known to the server.
    Snapshots {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,
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
            let chunks = chunk_file(&data);
            if chunks.is_empty() {
                return Err("chunking produced no chunks".to_string());
            }
            let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();

            let client = reqwest::Client::new();

            let pres_resp = chunk_presence(&client, &server, hashes.clone()).await?;
            let missing: std::collections::HashSet<String> =
                pres_resp.missing.into_iter().collect();

            // Upload missing chunks (re-slice from original buffer).
            let mut offset = 0usize;
            for c in &chunks {
                let end = offset + c.size as usize;
                if missing.contains(&c.hash) {
                    put_chunk(&client, &server, &c.hash, data[offset..end].to_vec()).await?;
                }
                offset = end;
            }

            println!("uploaded chunks: {}", chunks.len());
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

            #[derive(Debug, Clone)]
            struct FilePlan {
                abs_path: PathBuf,
                rel_path: String,
                size: u64,
                mtime_unix: i64,
                chunks: Vec<ChunkRef>,
            }

            // Pass 1: build file plans and gather all chunk hashes.
            let mut plans = Vec::<FilePlan>::new();
            let mut all_hashes = Vec::<String>::new();

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

                // Read file once to compute chunk hashes.
                let data = tokio::fs::read(&abs_path)
                    .await
                    .map_err(|e| format!("read file: {e}"))?;
                let chunks = chunk_file(&data);
                if chunks.is_empty() {
                    return Err(format!("chunking produced no chunks: {}", abs_path.display()));
                }

                all_hashes.extend(chunks.iter().map(|c| c.hash.clone()));
                plans.push(FilePlan {
                    abs_path,
                    rel_path: rel_str,
                    size,
                    mtime_unix,
                    chunks,
                });
            }

            // Batch presence check for entire folder.
            let pres_resp = chunk_presence(&client, &server, all_hashes).await?;
            let missing: std::collections::HashSet<String> =
                pres_resp.missing.into_iter().collect();

            // Pass 2: upload missing chunks.
            let mut files = Vec::new();
            for plan in plans {
                let data = tokio::fs::read(&plan.abs_path)
                    .await
                    .map_err(|e| format!("read file: {e}"))?;

                let mut offset = 0usize;
                for c in &plan.chunks {
                    let end = offset + c.size as usize;
                    if missing.contains(&c.hash) {
                        put_chunk(&client, &server, &c.hash, data[offset..end].to_vec()).await?;
                    }
                    offset = end;
                }

                files.push(ManifestFileEntry {
                    path: plan.rel_path,
                    size: plan.size,
                    mtime_unix: plan.mtime_unix,
                    chunk_hash: None,
                    chunks: Some(plan.chunks),
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

        Command::Tree {
            server,
            snapshot,
            path,
        } => {
            let client = reqwest::Client::new();
            let url = format!(
                "{}/v1/snapshots/{}/tree",
                server.trim_end_matches('/'),
                snapshot
            );
            let resp: TreeResponse = client
                .get(url)
                .query(&[("path", path)])
                .send()
                .await
                .map_err(|e| format!("tree request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("tree response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("tree decode: {e}"))?;
            println!("{}", serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?);
        }

        Command::PullFile {
            server,
            snapshot,
            path,
            out,
        } => {
            let client = reqwest::Client::new();
            let url = format!(
                "{}/v1/snapshots/{}/file",
                server.trim_end_matches('/'),
                snapshot
            );
            let bytes = client
                .get(url)
                .query(&[("path", path)])
                .send()
                .await
                .map_err(|e| format!("file request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("file response: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("read bytes: {e}"))?;

            if let Some(parent) = out.parent() {
                if !parent.as_os_str().is_empty() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("mkdir: {e}"))?;
                }
            }
            tokio::fs::write(&out, &bytes)
                .await
                .map_err(|e| format!("write out: {e}"))?;
            println!("downloaded: {}", out.display());
        }

        Command::PullFolder {
            server,
            snapshot,
            out,
        } => {
            let client = reqwest::Client::new();

            let manifest_url = format!(
                "{}/v1/snapshots/{}/manifest",
                server.trim_end_matches('/'),
                snapshot
            );
            let manifest: SnapshotManifest = client
                .get(manifest_url)
                .send()
                .await
                .map_err(|e| format!("manifest request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("manifest response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("manifest decode: {e}"))?;

            for f in manifest.files {
                let rel_path = f.path;
                let out_path = out.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                let url = format!(
                    "{}/v1/snapshots/{}/file",
                    server.trim_end_matches('/'),
                    snapshot
                );
                let bytes = client
                    .get(url)
                    .query(&[("path", rel_path)])
                    .send()
                    .await
                    .map_err(|e| format!("file request: {e}"))?
                    .error_for_status()
                    .map_err(|e| format!("file response: {e}"))?
                    .bytes()
                    .await
                    .map_err(|e| format!("read bytes: {e}"))?;

                if let Some(parent) = out_path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("mkdir: {e}"))?;
                }
                tokio::fs::write(&out_path, &bytes)
                    .await
                    .map_err(|e| format!("write out: {e}"))?;
            }

            println!("restored to: {}", out.display());
        }

        Command::Snapshots { server } => {
            let client = reqwest::Client::new();
            let url = format!("{}/v1/snapshots", server.trim_end_matches('/'));
            let metas: Vec<SnapshotMeta> = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("snapshots request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("snapshots response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("snapshots decode: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&metas).map_err(|e| e.to_string())?
            );
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

const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024;

fn chunk_file(data: &[u8]) -> Vec<ChunkRef> {
    let mut out = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let end = std::cmp::min(offset + DEFAULT_CHUNK_SIZE, data.len());
        let chunk = &data[offset..end];
        let hash = blake3::hash(chunk).to_hex().to_string();
        // This should always be true, but keep it as a sanity check.
        if !is_valid_chunk_hash(&hash) {
            // Fall back to empty result; caller will error on use.
            return Vec::new();
        }
        out.push(ChunkRef {
            hash,
            size: (end - offset) as u64,
        });
        offset = end;
    }
    out
}
