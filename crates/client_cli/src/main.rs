use clap::{Parser, Subcommand};
use filedock_protocol::{
    is_valid_chunk_hash, is_valid_rel_path, ChunkGcRequest, ChunkGcResponse, ChunkPresenceRequest,
    ChunkPresenceResponse, ChunkRef, DeviceHeartbeatRequest, DeviceHeartbeatResponse,
    HealthResponse, ManifestFileEntry, ServerConfigExport, SnapshotCreateRequest,
    SnapshotCreateResponse, SnapshotDeleteResponse, SnapshotManifest, SnapshotMeta,
    SnapshotPruneRequest, SnapshotPruneResponse, TreeResponse,
};
use futures_util::stream::{self, StreamExt};
use globset::{Glob, GlobSet, GlobSetBuilder};
use qrcode::QrCode;
use serde::Deserialize;
use std::collections::HashMap;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use walkdir::WalkDir;

const PRESENCE_BATCH: usize = 1000;
const DEFAULT_CONCURRENCY: usize = 4;
const TOKEN_HEADER: &str = "x-filedock-token";
const DEVICE_ID_HEADER: &str = "x-filedock-device-id";
const DEVICE_TOKEN_HEADER: &str = "x-filedock-device-token";

fn build_client() -> Result<reqwest::Client, String> {
    // If FILEDOCK_TOKEN is set, attach it to all requests.
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(token) = std::env::var("FILEDOCK_TOKEN") {
        let token = token.trim().to_string();
        if !token.is_empty() {
            let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
            let value = reqwest::header::HeaderValue::from_str(&token)
                .map_err(|e| format!("invalid FILEDOCK_TOKEN: {e}"))?;
            headers.insert(name, value);
        }
    }

    // Optional device auth.
    if let Ok(device_id) = std::env::var("FILEDOCK_DEVICE_ID") {
        let device_id = device_id.trim().to_string();
        if !device_id.is_empty() {
            let name = reqwest::header::HeaderName::from_static(DEVICE_ID_HEADER);
            let value = reqwest::header::HeaderValue::from_str(&device_id)
                .map_err(|e| format!("invalid FILEDOCK_DEVICE_ID: {e}"))?;
            headers.insert(name, value);
        }
    }
    if let Ok(device_token) = std::env::var("FILEDOCK_DEVICE_TOKEN") {
        let device_token = device_token.trim().to_string();
        if !device_token.is_empty() {
            let name = reqwest::header::HeaderName::from_static(DEVICE_TOKEN_HEADER);
            let value = reqwest::header::HeaderValue::from_str(&device_token)
                .map_err(|e| format!("invalid FILEDOCK_DEVICE_TOKEN: {e}"))?;
            headers.insert(name, value);
        }
    }

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

async fn fetch_server_config(
    client: &reqwest::Client,
    server: &str,
) -> Result<ServerConfigExport, String> {
    let url = format!("{}/v1/admin/config/export", server.trim_end_matches('/'));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("config export request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("config export response: {e}"))?;
    resp.json()
        .await
        .map_err(|e| format!("config export decode: {e}"))
}

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

        /// Optional note stored in snapshot metadata.
        #[arg(long)]
        note: Option<String>,

        /// Number of files to upload in parallel.
        #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
        concurrency: usize,

        /// Exclude glob patterns (matched against relative POSIX paths).
        /// Example: --exclude \"**/node_modules/**\" --exclude \"**/.git/**\"
        #[arg(long)]
        exclude: Vec<String>,

        /// Optional ignore file (one glob per line). If not provided, `.filedockignore` in the root
        /// folder is used when present.
        #[arg(long)]
        ignore_file: Option<PathBuf>,
    },

    /// Periodically upload a folder as snapshots (simple scheduler).
    PushFolderLoop {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Device name to store in snapshot metadata (free-form).
        #[arg(long)]
        device: String,

        /// Root folder to back up.
        #[arg(long)]
        folder: PathBuf,

        /// Optional note stored in snapshot metadata.
        #[arg(long)]
        note: Option<String>,

        /// Number of files to upload in parallel.
        #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
        concurrency: usize,

        /// Exclude glob patterns (matched against relative POSIX paths).
        /// Example: --exclude \"**/node_modules/**\" --exclude \"**/.git/**\"
        #[arg(long)]
        exclude: Vec<String>,

        /// Optional ignore file (one glob per line). If not provided, `.filedockignore` in the root
        /// folder is used when present.
        #[arg(long)]
        ignore_file: Option<PathBuf>,

        /// Seconds between runs. Use 0 to run once.
        #[arg(long, default_value_t = 900)]
        interval_secs: u64,
    },

    /// Export server connection config (JSON or QR).
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
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

        /// Number of files to download in parallel.
        #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
        concurrency: usize,
    },

    /// List snapshots known to the server.
    Snapshots {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,
    },

    /// Delete a snapshot (metadata + manifest). Chunks are not garbage-collected.
    DeleteSnapshot {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Snapshot id.
        #[arg(long)]
        snapshot: String,
    },

    /// Prune old snapshots (retention policy). Chunks are not garbage-collected.
    PruneSnapshots {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Optional filter: only prune this device_id.
        #[arg(long)]
        device_id: Option<String>,

        /// Optional filter: only prune this device_name.
        #[arg(long)]
        device_name: Option<String>,

        /// Keep the newest N snapshots per device (optional).
        #[arg(long)]
        keep_last: Option<u32>,

        /// Keep snapshots newer than N days per device (optional).
        #[arg(long)]
        keep_days: Option<u32>,

        /// Compute what would be deleted, but don't delete anything.
        #[arg(long)]
        dry_run: bool,
    },

    /// Garbage-collect unreferenced chunks (admin token required).
    GcChunks {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// If set, show what would be deleted but do not delete anything.
        #[arg(long)]
        dry_run: bool,

        /// Cap the number of chunks deleted in one run (optional).
        #[arg(long)]
        max_delete: Option<u32>,
    },

    /// Send a device heartbeat (requires device auth when server runs with FILEDOCK_TOKEN).
    DeviceHeartbeat {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Device id (if omitted, uses FILEDOCK_DEVICE_ID).
        #[arg(long)]
        device_id: Option<String>,

        /// Optional status string.
        #[arg(long)]
        status: Option<String>,
    },

    /// Run a simple "device agent" from a config file (TOML).
    ///
    /// This runs periodic `push-folder` snapshots and (optionally) sends device heartbeats.
    Agent {
        /// Config file path.
        #[arg(long)]
        config: PathBuf,
    },

    /// Check whether local files match a server snapshot (a lightweight "sync status").
    ///
    /// This does NOT modify anything; it compares local files to the snapshot manifest.
    Status {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Snapshot id to compare against.
        #[arg(long)]
        snapshot: Option<String>,

        /// Use the newest snapshot on the server (optionally filtered by device).
        #[arg(long)]
        latest: bool,

        /// Optional filter used with --latest (matches snapshot meta device_name).
        #[arg(long)]
        device_name: Option<String>,

        /// Local folder root.
        #[arg(long)]
        folder: PathBuf,

        /// Optional relative path (within --folder) to check a single file.
        #[arg(long)]
        path: Option<String>,

        /// If set, compute and compare chunk hashes (slower but accurate).
        #[arg(long)]
        verify: bool,
    },

    /// Plugin system (external executables named `filedock-<name>`).
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
}

#[derive(Subcommand, Debug)]
enum ConfigCommand {
    /// Export server config JSON (requires FILEDOCK_TOKEN when auth is enabled).
    Export {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,
    },

    /// Print a QR code for server config (requires FILEDOCK_TOKEN when auth is enabled).
    Qr {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,
    },
}

#[derive(Subcommand, Debug)]
enum PluginCommand {
    /// List available plugins (best-effort discovery from PATH and optional plugin dirs).
    List,

    /// Run a plugin by name and pass JSON on stdin.
    Run {
        /// Plugin name (maps to executable `filedock-<name>`).
        #[arg(long)]
        name: String,

        /// JSON string to pass on stdin.
        #[arg(long)]
        json: String,

        /// Timeout in seconds.
        #[arg(long, default_value_t = 30)]
        timeout_secs: u64,

        /// If set, print plugin stdout as-is (instead of trying to pretty-print JSON).
        #[arg(long)]
        raw: bool,
    },
}

#[derive(Debug, Clone, Deserialize)]
struct AgentConfig {
    /// Server base URL, e.g. http://127.0.0.1:8787
    server: String,
    /// Device name stored in snapshot metadata.
    device_name: String,
    /// Root folder to back up.
    folder: PathBuf,

    /// Optional note stored in snapshot metadata.
    #[serde(default)]
    note: Option<String>,

    /// Seconds between snapshot runs.
    #[serde(default = "default_agent_interval")]
    interval_secs: u64,

    /// Upload concurrency (files in parallel).
    #[serde(default = "default_agent_concurrency")]
    concurrency: usize,

    /// Exclude glob patterns (matched against relative POSIX paths).
    #[serde(default)]
    exclude: Vec<String>,

    /// Optional ignore file (one glob per line). If omitted, `.filedockignore` in the folder root is used if present.
    #[serde(default)]
    ignore_file: Option<PathBuf>,

    /// Optional token auth (maps to FILEDOCK_TOKEN).
    #[serde(default)]
    token: Option<String>,

    /// Optional device auth (maps to FILEDOCK_DEVICE_ID / FILEDOCK_DEVICE_TOKEN).
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_token: Option<String>,

    /// Heartbeat interval in seconds (0 disables). Requires device auth when server token is set.
    #[serde(default = "default_heartbeat_interval")]
    heartbeat_secs: u64,

    /// Optional free-form heartbeat status string.
    #[serde(default)]
    heartbeat_status: Option<String>,
}

fn default_agent_interval() -> u64 {
    900
}

fn default_heartbeat_interval() -> u64 {
    300
}

fn default_agent_concurrency() -> usize {
    DEFAULT_CONCURRENCY
}

fn apply_agent_env(cfg: &AgentConfig) {
    if let Some(tok) = cfg.token.as_deref() {
        let t = tok.trim();
        if !t.is_empty() {
            std::env::set_var("FILEDOCK_TOKEN", t);
        }
    }
    if let Some(id) = cfg.device_id.as_deref() {
        let s = id.trim();
        if !s.is_empty() {
            std::env::set_var("FILEDOCK_DEVICE_ID", s);
        }
    }
    if let Some(tok) = cfg.device_token.as_deref() {
        let s = tok.trim();
        if !s.is_empty() {
            std::env::set_var("FILEDOCK_DEVICE_TOKEN", s);
        }
    }
}

async fn send_heartbeat_impl(server: &str, status: Option<String>) -> Result<(), String> {
    let client = build_client()?;
    let dev_id = std::env::var("FILEDOCK_DEVICE_ID").unwrap_or_default();
    if dev_id.trim().is_empty() {
        return Err("FILEDOCK_DEVICE_ID required for heartbeat".to_string());
    }
    let url = format!(
        "{}/v1/devices/{}/heartbeat",
        server.trim_end_matches('/'),
        dev_id.trim()
    );
    let req = DeviceHeartbeatRequest {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        status,
    };
    let _resp: DeviceHeartbeatResponse = client
        .post(url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("heartbeat request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("heartbeat response: {e}"))?
        .json()
        .await
        .map_err(|e| format!("heartbeat decode: {e}"))?;
    Ok(())
}

async fn push_folder_impl(
    server: String,
    device: String,
    folder: PathBuf,
    note: Option<String>,
    concurrency: usize,
    exclude: Vec<String>,
    ignore_file: Option<PathBuf>,
) -> Result<String, String> {
    let client = build_client()?;

    let root = folder
        .canonicalize()
        .map_err(|e| format!("canonicalize folder: {e}"))?;

    let mut exclude_patterns = Vec::<String>::new();
    exclude_patterns.extend(load_ignore_patterns(&root, ignore_file)?);
    exclude_patterns.extend(exclude);
    let exclude_set = build_excludes(&exclude_patterns)?;

    // Create snapshot id
    let create_url = format!("{}/v1/snapshots", server.trim_end_matches('/'));
    let device_id = std::env::var("FILEDOCK_DEVICE_ID")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let create_req = SnapshotCreateRequest {
        device_name: device,
        device_id,
        root_path: root.display().to_string(),
        note,
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
    // Use a set to avoid sending huge duplicated hash lists to the presence endpoint.
    let mut all_hashes = std::collections::HashSet::<String>::new();
    let mut total_bytes = 0u64;

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

        if exclude_set.is_match(&rel_str) {
            continue;
        }

        let meta = tokio::fs::metadata(&abs_path)
            .await
            .map_err(|e| format!("stat file: {e}"))?;
        let size = meta.len();
        total_bytes = total_bytes.saturating_add(size);
        let mtime_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Compute chunk hashes without loading the whole file into memory.
        // Note: empty files are allowed (zero chunks).
        let chunks = compute_chunks_for_file(&abs_path).await?;

        for c in &chunks {
            all_hashes.insert(c.hash.clone());
        }
        plans.push(FilePlan {
            abs_path,
            rel_path: rel_str,
            size,
            mtime_unix,
            chunks,
        });
    }

    // Batch presence check for entire folder.
    let pres_resp = chunk_presence(&client, &server, all_hashes.into_iter().collect()).await?;
    let missing: std::collections::HashSet<String> = pres_resp.missing.into_iter().collect();

    let total_files = plans.len() as u64;
    println!(
        "files: {}  bytes: {}  missing_chunks: {}",
        total_files,
        total_bytes,
        missing.len()
    );

    // Pass 2: upload missing chunks, concurrent by file.
    let uploaded_files = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let uploaded_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let skipped_files = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let server_base = server.trim_end_matches('/').to_string();
    let missing = std::sync::Arc::new(missing);

    let results: Vec<Result<ManifestFileEntry, String>> = stream::iter(plans.into_iter())
        .map(|plan| {
            let client = client.clone();
            let missing = missing.clone();
            let uploaded_files = uploaded_files.clone();
            let uploaded_bytes = uploaded_bytes.clone();
            let skipped_files = skipped_files.clone();
            let server_base = server_base.clone();
            async move {
                let needs_upload = plan.chunks.iter().any(|c| missing.contains(&c.hash));
                if !needs_upload {
                    let done_files =
                        uploaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let done_bytes = uploaded_bytes
                        .fetch_add(plan.size, std::sync::atomic::Ordering::Relaxed)
                        + plan.size;
                    let done_skipped =
                        skipped_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    if done_files.is_multiple_of(25) || done_files == total_files {
                        eprintln!(
                            "uploaded files: {done_files}/{total_files}  bytes: {done_bytes}/{total_bytes}  skipped: {done_skipped}"
                        );
                    }

                    return Ok(ManifestFileEntry {
                        path: plan.rel_path,
                        size: plan.size,
                        mtime_unix: plan.mtime_unix,
                        chunk_hash: None,
                        chunks: Some(plan.chunks),
                    });
                }

                let mut file = tokio::fs::File::open(&plan.abs_path)
                    .await
                    .map_err(|e| format!("open file: {e}"))?;

                // Upload missing chunks while reading the file sequentially.
                // For non-missing chunks we seek forward to avoid reading data we won't upload.
                for c in &plan.chunks {
                    if c.size == 0 {
                        continue;
                    }
                    if missing.contains(&c.hash) {
                        let mut buf = vec![0u8; c.size as usize];
                        file.read_exact(&mut buf)
                            .await
                            .map_err(|e| format!("read chunk: {e}"))?;
                        put_chunk(&client, &server_base, &c.hash, buf).await?;
                    } else {
                        let off: i64 = c
                            .size
                            .try_into()
                            .map_err(|_| "chunk too large to seek".to_string())?;
                        file.seek(std::io::SeekFrom::Current(off))
                            .await
                            .map_err(|e| format!("seek: {e}"))?;
                    }
                }

                let done_files =
                    uploaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                let done_bytes =
                    uploaded_bytes.fetch_add(plan.size, std::sync::atomic::Ordering::Relaxed)
                        + plan.size;
                if done_files.is_multiple_of(25) || done_files == total_files {
                    let done_skipped = skipped_files.load(std::sync::atomic::Ordering::Relaxed);
                    eprintln!(
                        "uploaded files: {done_files}/{total_files}  bytes: {done_bytes}/{total_bytes}  skipped: {done_skipped}"
                    );
                }

                Ok(ManifestFileEntry {
                    path: plan.rel_path,
                    size: plan.size,
                    mtime_unix: plan.mtime_unix,
                    chunk_hash: None,
                    chunks: Some(plan.chunks),
                })
            }
        })
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await;

    let mut files = Vec::new();
    for r in results {
        files.push(r?);
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

    Ok(snapshot_id)
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
        Command::Config { command } => {
            let client = build_client()?;
            match command {
                ConfigCommand::Export { server } => {
                    let cfg = fetch_server_config(&client, &server).await?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?
                    );
                }
                ConfigCommand::Qr { server } => {
                    let cfg = fetch_server_config(&client, &server).await?;
                    let json = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
                    let code = QrCode::new(json.as_bytes()).map_err(|e| e.to_string())?;
                    let rendered = code.render::<qrcode::render::unicode::Dense1x2>().build();
                    println!("{rendered}");
                }
            }
        }
        Command::PushFile { server, file } => {
            let data = tokio::fs::read(&file)
                .await
                .map_err(|e| format!("read file: {e}"))?;
            let chunks = chunk_file(&data);
            if chunks.is_empty() {
                println!("empty file; nothing to upload");
                return Ok(());
            }
            let hashes: Vec<String> = chunks.iter().map(|c| c.hash.clone()).collect();

            let client = build_client()?;

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
            note,
            concurrency,
            exclude,
            ignore_file,
        } => {
            let _ = push_folder_impl(
                server,
                device,
                folder,
                note,
                concurrency,
                exclude,
                ignore_file,
            )
            .await?;
        }

        Command::PushFolderLoop {
            server,
            device,
            folder,
            note,
            concurrency,
            exclude,
            ignore_file,
            interval_secs,
        } => loop {
            let snap = push_folder_impl(
                server.clone(),
                device.clone(),
                folder.clone(),
                note.clone(),
                concurrency,
                exclude.clone(),
                ignore_file.clone(),
            )
            .await?;
            eprintln!("completed snapshot: {snap}");

            if interval_secs == 0 {
                break;
            }

            eprintln!("sleeping {interval_secs}s (Ctrl+C to stop)...");
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval_secs)) => {},
                _ = tokio::signal::ctrl_c() => { eprintln!("stopped"); break; }
            }
        },

        Command::Tree {
            server,
            snapshot,
            path,
        } => {
            let client = build_client()?;
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
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::PullFile {
            server,
            snapshot,
            path,
            out,
        } => {
            let client = build_client()?;
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
            concurrency,
        } => {
            let client = build_client()?;

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

            let total_files = manifest.files.len() as u64;
            let downloaded_files = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

            let server_base = server.trim_end_matches('/').to_string();
            let snapshot_id = snapshot.clone();
            let out_root = out.clone();

            let results: Vec<Result<(), String>> = stream::iter(manifest.files.into_iter())
                .map(|f| {
                    let client = client.clone();
                    let downloaded_files = downloaded_files.clone();
                    let server_base = server_base.clone();
                    let snapshot_id = snapshot_id.clone();
                    let out_root = out_root.clone();
                    async move {
                        let rel_path = f.path;
                        let out_path =
                            out_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                        let url = format!("{}/v1/snapshots/{}/file", server_base, snapshot_id);
                        let bytes =
                            get_bytes_with_retry(&client, &url, &[("path", rel_path.as_str())])
                                .await?;

                        if let Some(parent) = out_path.parent() {
                            tokio::fs::create_dir_all(parent)
                                .await
                                .map_err(|e| format!("mkdir: {e}"))?;
                        }
                        tokio::fs::write(&out_path, &bytes)
                            .await
                            .map_err(|e| format!("write out: {e}"))?;

                        let done =
                            downloaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        if done.is_multiple_of(25) || done == total_files {
                            eprintln!("downloaded files: {done}/{total_files}");
                        }
                        Ok(())
                    }
                })
                .buffer_unordered(concurrency.max(1))
                .collect()
                .await;

            for r in results {
                r?;
            }

            println!("restored to: {}", out.display());
        }

        Command::Snapshots { server } => {
            let client = build_client()?;
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

        Command::DeleteSnapshot { server, snapshot } => {
            let client = build_client()?;
            let url = format!("{}/v1/snapshots/{}", server.trim_end_matches('/'), snapshot);
            let resp: SnapshotDeleteResponse = client
                .delete(url)
                .send()
                .await
                .map_err(|e| format!("delete snapshot request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("delete snapshot response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("delete snapshot decode: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::PruneSnapshots {
            server,
            device_id,
            device_name,
            keep_last,
            keep_days,
            dry_run,
        } => {
            let client = build_client()?;
            let url = format!("{}/v1/snapshots/prune", server.trim_end_matches('/'));
            let req = SnapshotPruneRequest {
                device_id,
                device_name,
                keep_last,
                keep_days,
                dry_run,
            };
            let resp: SnapshotPruneResponse = client
                .post(url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("prune request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("prune response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("prune decode: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::GcChunks {
            server,
            dry_run,
            max_delete,
        } => {
            let client = build_client()?;
            let url = format!("{}/v1/admin/chunks/gc", server.trim_end_matches('/'));
            let req = ChunkGcRequest {
                dry_run,
                max_delete,
            };
            let resp: ChunkGcResponse = client
                .post(url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("gc request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("gc response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("gc decode: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::DeviceHeartbeat {
            server,
            device_id,
            status,
        } => {
            let client = build_client()?;
            let dev_id = device_id
                .or_else(|| std::env::var("FILEDOCK_DEVICE_ID").ok())
                .unwrap_or_default();
            if dev_id.trim().is_empty() {
                return Err("device_id required (or set FILEDOCK_DEVICE_ID)".to_string());
            }

            let url = format!(
                "{}/v1/devices/{}/heartbeat",
                server.trim_end_matches('/'),
                dev_id.trim()
            );
            let req = DeviceHeartbeatRequest {
                agent_version: env!("CARGO_PKG_VERSION").to_string(),
                status,
            };
            let resp: DeviceHeartbeatResponse = client
                .post(url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("heartbeat request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("heartbeat response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("heartbeat decode: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::Agent { config } => {
            let raw = tokio::fs::read_to_string(&config)
                .await
                .map_err(|e| format!("read config {}: {e}", config.display()))?;
            let cfg: AgentConfig = toml::from_str(&raw)
                .map_err(|e| format!("parse config {}: {e}", config.display()))?;

            apply_agent_env(&cfg);

            eprintln!(
                "agent: server={} device_name={} folder={} interval={}s concurrency={} heartbeat={}s",
                cfg.server,
                cfg.device_name,
                cfg.folder.display(),
                cfg.interval_secs,
                cfg.concurrency,
                cfg.heartbeat_secs
            );

            let heartbeat_enabled = cfg.heartbeat_secs > 0;
            let mut last_snapshot_id: Option<String> = None;

            // Best-effort initial heartbeat (independent of snapshot loop).
            if heartbeat_enabled {
                let st = cfg
                    .heartbeat_status
                    .clone()
                    .or_else(|| Some("online".to_string()));
                if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
                    eprintln!("heartbeat: {e}");
                }
            }

            // Single-run mode.
            if cfg.interval_secs == 0 {
                let snap = push_folder_impl(
                    cfg.server.clone(),
                    cfg.device_name.clone(),
                    cfg.folder.clone(),
                    cfg.note.clone(),
                    cfg.concurrency,
                    cfg.exclude.clone(),
                    cfg.ignore_file.clone(),
                )
                .await?;
                eprintln!("agent: completed snapshot: {snap}");
                if heartbeat_enabled {
                    let st = cfg
                        .heartbeat_status
                        .clone()
                        .or_else(|| Some(format!("snapshot {snap}")));
                    if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
                        eprintln!("heartbeat: {e}");
                    }
                }

                return Ok(());
            }

            // Repeating mode:
            // - snapshots every `interval_secs`
            // - heartbeats every `heartbeat_secs` (independent)
            let mut snap_iv = tokio::time::interval(Duration::from_secs(cfg.interval_secs));
            snap_iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut hb_iv = tokio::time::interval(Duration::from_secs(cfg.heartbeat_secs.max(1)));
            hb_iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {
                        eprintln!("agent: stopped");
                        break;
                    }

                    _ = hb_iv.tick(), if heartbeat_enabled => {
                        let st = cfg.heartbeat_status.clone()
                            .or_else(|| last_snapshot_id.clone().map(|s| format!("last snapshot {s}")))
                            .or_else(|| Some("online".to_string()));
                        if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
                            eprintln!("heartbeat: {e}");
                        }
                    }

                    _ = snap_iv.tick() => {
                        // Allow Ctrl-C to stop starting a new snapshot.
                        let snap = tokio::select! {
                            _ = tokio::signal::ctrl_c() => {
                                eprintln!("agent: stopped");
                                break;
                            }
                            r = push_folder_impl(
                                cfg.server.clone(),
                                cfg.device_name.clone(),
                                cfg.folder.clone(),
                                cfg.note.clone(),
                                cfg.concurrency,
                                cfg.exclude.clone(),
                                cfg.ignore_file.clone(),
                            ) => r?
                        };

                        eprintln!("agent: completed snapshot: {snap}");
                        last_snapshot_id = Some(snap.clone());

                        if heartbeat_enabled {
                            let st = cfg
                                .heartbeat_status
                                .clone()
                                .or_else(|| Some(format!("snapshot {snap}")));
                            if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
                                eprintln!("heartbeat: {e}");
                            }
                        }
                    }
                }
            }
        }

        Command::Status {
            server,
            snapshot,
            latest,
            device_name,
            folder,
            path,
            verify,
        } => {
            #[derive(Debug, serde::Serialize)]
            struct StatusItem {
                path: String,
                status: String,
                reason: Option<String>,
                local_size: Option<u64>,
                server_size: Option<u64>,
                local_mtime_unix: Option<i64>,
                server_mtime_unix: Option<i64>,
            }

            let client = build_client()?;
            let server_base = server.trim_end_matches('/').to_string();

            let root = folder
                .canonicalize()
                .map_err(|e| format!("canonicalize folder: {e}"))?;

            // Respect `.filedockignore` by default so status matches backup behavior.
            let exclude_patterns = load_ignore_patterns(&root, None)?;
            let exclude_set = build_excludes(&exclude_patterns)?;

            let snapshot_id = if latest {
                let url = format!("{}/v1/snapshots", server_base);
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

                let mut best: Option<SnapshotMeta> = None;
                for m in metas {
                    if let Some(dn) = device_name.as_ref() {
                        if m.device_name != *dn {
                            continue;
                        }
                    }
                    match best.as_ref() {
                        None => best = Some(m),
                        Some(b) => {
                            if m.created_unix > b.created_unix {
                                best = Some(m);
                            }
                        }
                    }
                }

                best.map(|m| m.snapshot_id).ok_or_else(|| {
                    if device_name.is_some() {
                        "no snapshots found for device_name".to_string()
                    } else {
                        "no snapshots found".to_string()
                    }
                })?
            } else {
                snapshot.ok_or_else(|| "snapshot required (or use --latest)".to_string())?
            };

            let url = format!("{}/v1/snapshots/{}/manifest", server_base, snapshot_id);
            let manifest: SnapshotManifest = client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("get manifest request: {e}"))?
                .error_for_status()
                .map_err(|e| format!("get manifest response: {e}"))?
                .json()
                .await
                .map_err(|e| format!("get manifest decode: {e}"))?;

            let mut by_path: HashMap<String, ManifestFileEntry> = HashMap::new();
            for f in manifest.files {
                by_path.insert(f.path.clone(), f);
            }

            let mut items: Vec<StatusItem> = Vec::new();

            async fn check_one(
                rel_path: String,
                abs_path: PathBuf,
                by_path: &HashMap<String, ManifestFileEntry>,
                verify: bool,
            ) -> Result<StatusItem, String> {
                // Check local metadata.
                let meta = tokio::fs::metadata(&abs_path).await;
                let local_meta = match meta {
                    Ok(m) => Some(m),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(e) => return Err(format!("stat {}: {e}", abs_path.display())),
                };

                let server_ent = by_path.get(&rel_path);

                if local_meta.is_none() {
                    if let Some(s) = server_ent {
                        return Ok(StatusItem {
                            path: rel_path,
                            status: "missing_local".to_string(),
                            reason: Some("missing locally".to_string()),
                            local_size: None,
                            server_size: Some(s.size),
                            local_mtime_unix: None,
                            server_mtime_unix: Some(s.mtime_unix),
                        });
                    }
                    return Ok(StatusItem {
                        path: rel_path,
                        status: "missing_local".to_string(),
                        reason: Some("missing locally".to_string()),
                        local_size: None,
                        server_size: None,
                        local_mtime_unix: None,
                        server_mtime_unix: None,
                    });
                }

                let lm = local_meta.unwrap();
                let local_size = lm.len();
                let local_mtime_unix = lm
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let Some(s) = server_ent else {
                    return Ok(StatusItem {
                        path: rel_path,
                        status: "missing_on_server".to_string(),
                        reason: Some("not in snapshot manifest".to_string()),
                        local_size: Some(local_size),
                        server_size: None,
                        local_mtime_unix: Some(local_mtime_unix),
                        server_mtime_unix: None,
                    });
                };

                if local_size != s.size {
                    return Ok(StatusItem {
                        path: rel_path,
                        status: "changed".to_string(),
                        reason: Some("size differs".to_string()),
                        local_size: Some(local_size),
                        server_size: Some(s.size),
                        local_mtime_unix: Some(local_mtime_unix),
                        server_mtime_unix: Some(s.mtime_unix),
                    });
                }

                if !verify {
                    let ok = local_mtime_unix == s.mtime_unix;
                    return Ok(StatusItem {
                        path: rel_path,
                        status: if ok { "up_to_date" } else { "changed" }.to_string(),
                        reason: if ok {
                            None
                        } else {
                            Some("mtime differs (use --verify to compare content)".to_string())
                        },
                        local_size: Some(local_size),
                        server_size: Some(s.size),
                        local_mtime_unix: Some(local_mtime_unix),
                        server_mtime_unix: Some(s.mtime_unix),
                    });
                }

                // Verify mode: compare chunk hashes.
                let expected: Vec<ChunkRef> = if let Some(chunks) = &s.chunks {
                    chunks.clone()
                } else if let Some(h) = &s.chunk_hash {
                    vec![ChunkRef {
                        hash: h.clone(),
                        size: s.size,
                    }]
                } else {
                    return Ok(StatusItem {
                        path: rel_path,
                        status: "changed".to_string(),
                        reason: Some("server manifest missing chunk info".to_string()),
                        local_size: Some(local_size),
                        server_size: Some(s.size),
                        local_mtime_unix: Some(local_mtime_unix),
                        server_mtime_unix: Some(s.mtime_unix),
                    });
                };

                let got = compute_chunks_for_file(&abs_path).await?;
                let ok = got.len() == expected.len()
                    && got
                        .iter()
                        .zip(expected.iter())
                        .all(|(a, b)| a.hash == b.hash && a.size == b.size);

                Ok(StatusItem {
                    path: rel_path,
                    status: if ok { "up_to_date" } else { "changed" }.to_string(),
                    reason: if ok {
                        None
                    } else {
                        Some("content differs".to_string())
                    },
                    local_size: Some(local_size),
                    server_size: Some(s.size),
                    local_mtime_unix: Some(local_mtime_unix),
                    server_mtime_unix: Some(s.mtime_unix),
                })
            }

            if let Some(p) = path {
                if !is_valid_rel_path(&p) {
                    return Err(
                        "invalid --path (expected relative POSIX path like a/b.txt)".to_string()
                    );
                }
                if exclude_set.is_match(&p) {
                    items.push(StatusItem {
                        path: p,
                        status: "ignored".to_string(),
                        reason: Some("matched .filedockignore".to_string()),
                        local_size: None,
                        server_size: None,
                        local_mtime_unix: None,
                        server_mtime_unix: None,
                    });
                } else {
                    let abs = root.join(PathBuf::from(&p));
                    items.push(check_one(p, abs, &by_path, verify).await?);
                }
            } else {
                // Folder mode: check every local file.
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

                    if exclude_set.is_match(&rel_str) {
                        continue;
                    }

                    items.push(check_one(rel_str, abs_path, &by_path, verify).await?);
                }

                // Also report files that exist in the snapshot but are missing locally.
                for rel_path in by_path.keys() {
                    if exclude_set.is_match(rel_path) {
                        continue;
                    }
                    let abs = root.join(PathBuf::from(rel_path));
                    if tokio::fs::metadata(&abs).await.is_err() {
                        let s = by_path.get(rel_path).unwrap();
                        items.push(StatusItem {
                            path: rel_path.clone(),
                            status: "missing_local".to_string(),
                            reason: Some("missing locally".to_string()),
                            local_size: None,
                            server_size: Some(s.size),
                            local_mtime_unix: None,
                            server_mtime_unix: Some(s.mtime_unix),
                        });
                    }
                }
            }

            // Keep output stable.
            items.sort_by(|a, b| a.path.cmp(&b.path));

            println!(
                "{}",
                serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?
            );
        }

        Command::Plugin { command } => match command {
            PluginCommand::List => {
                #[derive(Debug, serde::Serialize)]
                struct PluginInfo {
                    name: String,
                    path: String,
                }

                let plugins = discover_plugins().map_err(|e| format!("plugin discovery: {e}"))?;
                let out: Vec<PluginInfo> = plugins
                    .into_iter()
                    .map(|(name, path)| PluginInfo {
                        name,
                        path: path.display().to_string(),
                    })
                    .collect();
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?
                );
            }

            PluginCommand::Run {
                name,
                json,
                timeout_secs,
                raw,
            } => {
                // Validate input JSON early so users get a clear error.
                let parsed: serde_json::Value =
                    serde_json::from_str(&json).map_err(|e| format!("invalid --json: {e}"))?;
                let json = serde_json::to_string(&parsed).map_err(|e| e.to_string())?;

                let exe = resolve_plugin(&name).ok_or_else(|| {
                    format!("plugin not found: {name} (expected executable: filedock-{name})")
                })?;

                let (stdout, stderr) = run_plugin(&exe, &json, timeout_secs).await?;

                if !stderr.trim().is_empty() {
                    eprintln!("{stderr}");
                }

                if raw {
                    print!("{stdout}");
                    if !stdout.ends_with('\n') {
                        println!();
                    }
                    return Ok(());
                }

                // Best-effort: pretty print JSON if stdout looks like JSON, else print raw.
                match serde_json::from_str::<serde_json::Value>(&stdout) {
                    Ok(v) => println!(
                        "{}",
                        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?
                    ),
                    Err(_) => {
                        print!("{stdout}");
                        if !stdout.ends_with('\n') {
                            println!();
                        }
                    }
                }
            }
        },
    }

    Ok(())
}

fn plugin_dirs() -> Vec<std::path::PathBuf> {
    let mut out = Vec::<std::path::PathBuf>::new();

    // Optional explicit plugin dirs.
    if let Ok(s) = std::env::var("FILEDOCK_PLUGIN_DIRS") {
        for p in s.split(':') {
            let p = p.trim();
            if p.is_empty() {
                continue;
            }
            out.push(std::path::PathBuf::from(p));
        }
    } else if let Ok(s) = std::env::var("FILEDOCK_PLUGIN_DIR") {
        let p = s.trim();
        if !p.is_empty() {
            out.push(std::path::PathBuf::from(p));
        }
    }

    // Repo-local convenience (works when running from the repo root).
    out.push(std::path::PathBuf::from("./plugins/bin"));

    // PATH dirs.
    if let Some(path) = std::env::var_os("PATH") {
        out.extend(std::env::split_paths(&path));
    }

    out
}

fn is_executable(path: &std::path::Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }

    #[cfg(not(unix))]
    {
        // Best-effort for Windows: accept common executable extensions.
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        matches!(ext.as_str(), "exe" | "cmd" | "bat")
    }
}

fn normalize_plugin_filename(name: &str) -> String {
    #[cfg(windows)]
    {
        // On Windows, we might see `filedock-foo.exe`.
        name.trim_end_matches(".exe")
            .trim_end_matches(".cmd")
            .trim_end_matches(".bat")
            .to_string()
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

fn discover_plugins() -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let mut found: HashMap<String, std::path::PathBuf> = HashMap::new();

    for dir in plugin_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in rd {
            let ent = match ent {
                Ok(e) => e,
                Err(_) => continue,
            };
            let file_name = ent.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if !file_name.starts_with("filedock-") {
                continue;
            }
            let file_name = normalize_plugin_filename(file_name);
            let Some(name) = file_name.strip_prefix("filedock-") else {
                continue;
            };
            if name.trim().is_empty() {
                continue;
            }

            let p = ent.path();
            if !is_executable(&p) {
                continue;
            }
            found.entry(name.to_string()).or_insert(p);
        }
    }

    let mut out: Vec<(String, std::path::PathBuf)> = found.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn resolve_plugin(name: &str) -> Option<std::path::PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    if let Ok(list) = discover_plugins() {
        for (n, p) in list {
            if n == name {
                return Some(p);
            }
        }
    }
    None
}

async fn run_plugin(
    exe: &std::path::PathBuf,
    stdin_json: &str,
    timeout_secs: u64,
) -> Result<(String, String), String> {
    use tokio::process::Command;
    use tokio::time::timeout;

    let mut child = Command::new(exe)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", exe.display()))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_json.as_bytes())
            .await
            .map_err(|e| format!("write plugin stdin: {e}"))?;
    }

    let output = timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| format!("plugin timed out after {timeout_secs}s"))?
        .map_err(|e| format!("wait plugin: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "plugin exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    Ok((stdout, stderr))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_excludes(patterns: &[String]) -> Result<GlobSet, String> {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let g = Glob::new(p).map_err(|e| format!("invalid exclude glob '{p}': {e}"))?;
        b.add(g);
    }
    b.build()
        .map_err(|e| format!("failed to build exclude set: {e}"))
}

fn load_ignore_patterns(root: &Path, ignore_file: Option<PathBuf>) -> Result<Vec<String>, String> {
    let p = match ignore_file {
        Some(p) => {
            if p.is_absolute() {
                p
            } else {
                root.join(p)
            }
        }
        None => root.join(".filedockignore"),
    };

    let content = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read ignore file {}: {e}", p.display())),
    };

    let mut out = Vec::<String>::new();
    for line in content.lines() {
        let s = line.trim();
        if s.is_empty() || s.starts_with('#') {
            continue;
        }
        // Keep raw glob text; validation happens when building the GlobSet.
        out.push(s.to_string());
        if out.len() > 10_000 {
            return Err(format!(
                "ignore file too large (>10000 patterns): {}",
                p.display()
            ));
        }
    }

    Ok(out)
}

async fn chunk_presence(
    client: &reqwest::Client,
    server: &str,
    hashes: Vec<String>,
) -> Result<ChunkPresenceResponse, String> {
    let presence_url = format!("{}/v1/chunks/presence", server.trim_end_matches('/'));
    let mut missing = Vec::new();

    for batch in hashes.chunks(PRESENCE_BATCH) {
        let pres_req = ChunkPresenceRequest {
            hashes: batch.to_vec(),
        };
        let resp: ChunkPresenceResponse = client
            .post(&presence_url)
            .json(&pres_req)
            .send()
            .await
            .map_err(|e| format!("presence request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("presence response: {e}"))?
            .json()
            .await
            .map_err(|e| format!("presence decode: {e}"))?;
        missing.extend(resp.missing);
    }

    Ok(ChunkPresenceResponse { missing })
}

async fn put_chunk(
    client: &reqwest::Client,
    server: &str,
    hash: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    let put_url = format!("{}/v1/chunks/{}", server.trim_end_matches('/'), hash);
    // Retry with backoff on transient failures.
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let resp = client.put(put_url.clone()).body(data.clone()).send().await;

        match resp {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => {
                if attempt >= 4 {
                    return Err(format!("upload failed: {}", r.status()));
                }
            }
            Err(e) => {
                if attempt >= 4 {
                    return Err(format!("upload request: {e}"));
                }
            }
        }

        // 250ms, 500ms, 1000ms (+ jitter)
        let base_ms = 250u64.saturating_mul(1u64 << (attempt - 1));
        let jitter: u64 = rand::random::<u8>() as u64;
        tokio::time::sleep(std::time::Duration::from_millis(base_ms + jitter)).await;
    }
}

async fn get_bytes_with_retry(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
) -> Result<bytes::Bytes, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let resp = client.get(url).query(query).send().await;
        match resp {
            Ok(r) if r.status().is_success() => {
                return r.bytes().await.map_err(|e| format!("read bytes: {e}"));
            }
            Ok(r) => {
                if attempt >= 4 {
                    return Err(format!("download failed: {}", r.status()));
                }
            }
            Err(e) => {
                if attempt >= 4 {
                    return Err(format!("download request: {e}"));
                }
            }
        }

        let base_ms = 250u64.saturating_mul(1u64 << (attempt - 1));
        let jitter: u64 = rand::random::<u8>() as u64;
        tokio::time::sleep(std::time::Duration::from_millis(base_ms + jitter)).await;
    }
}

const DEFAULT_CHUNK_SIZE: usize = 4 * 1024 * 1024;

async fn compute_chunks_for_file(path: &PathBuf) -> Result<Vec<ChunkRef>, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open file: {e}"))?;

    let mut out = Vec::<ChunkRef>::new();
    let mut buf = vec![0u8; DEFAULT_CHUNK_SIZE];

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("read file: {e}"))?;
        if n == 0 {
            break;
        }

        let hash = blake3::hash(&buf[..n]).to_hex().to_string();
        if !is_valid_chunk_hash(&hash) {
            return Err(format!("invalid chunk hash for file: {}", path.display()));
        }
        out.push(ChunkRef {
            hash,
            size: n as u64,
        });
    }

    Ok(out)
}

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
