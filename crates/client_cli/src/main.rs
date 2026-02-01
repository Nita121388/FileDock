use clap::{Parser, Subcommand};
use filedock_protocol::{
    is_valid_chunk_hash, ChunkPresenceRequest, ChunkPresenceResponse, HealthResponse,
    ChunkRef, SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest, ManifestFileEntry,
    TreeResponse, SnapshotMeta,
};
use futures_util::stream::{self, StreamExt};
use globset::{Glob, GlobSet, GlobSetBuilder};
use std::path::PathBuf;
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

        /// Number of files to upload in parallel.
        #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
        concurrency: usize,

        /// Exclude glob patterns (matched against relative POSIX paths).
        /// Example: --exclude \"**/node_modules/**\" --exclude \"**/.git/**\"
        #[arg(long)]
        exclude: Vec<String>,
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
            concurrency,
            exclude,
        } => {
            let client = build_client()?;

            let root = folder
                .canonicalize()
                .map_err(|e| format!("canonicalize folder: {e}"))?;

            let exclude_set = build_excludes(&exclude)?;

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
                                uploaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                    + 1;
                            let done_bytes = uploaded_bytes
                                .fetch_add(plan.size, std::sync::atomic::Ordering::Relaxed)
                                + plan.size;
                            let done_skipped =
                                skipped_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                                    + 1;
                            if done_files % 25 == 0 || done_files == total_files {
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

                        let data = tokio::fs::read(&plan.abs_path)
                            .await
                            .map_err(|e| format!("read file: {e}"))?;

                        let mut offset = 0usize;
                        for c in &plan.chunks {
                            let end = offset + c.size as usize;
                            if missing.contains(&c.hash) {
                                put_chunk(&client, &server_base, &c.hash, data[offset..end].to_vec())
                                    .await?;
                            }
                            offset = end;
                        }

                        let done_files = uploaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        let done_bytes = uploaded_bytes.fetch_add(plan.size, std::sync::atomic::Ordering::Relaxed) + plan.size;
                        if done_files % 25 == 0 || done_files == total_files {
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
        }

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
            println!("{}", serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?);
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
                        let out_path = out_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
                        let url = format!(
                            "{}/v1/snapshots/{}/file",
                            server_base,
                            snapshot_id
                        );
                        let bytes = get_bytes_with_retry(&client, &url, &[("path", rel_path.as_str())]).await?;

                        if let Some(parent) = out_path.parent() {
                            tokio::fs::create_dir_all(parent)
                                .await
                                .map_err(|e| format!("mkdir: {e}"))?;
                        }
                        tokio::fs::write(&out_path, &bytes)
                            .await
                            .map_err(|e| format!("write out: {e}"))?;

                        let done = downloaded_files.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                        if done % 25 == 0 || done == total_files {
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
    }

    Ok(())
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
    let put_url = format!(
        "{}/v1/chunks/{}",
        server.trim_end_matches('/'),
        hash
    );
    // Retry with backoff on transient failures.
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let resp = client
            .put(put_url.clone())
            .body(data.clone())
            .send()
            .await;

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
                return r
                    .bytes()
                    .await
                    .map_err(|e| format!("read bytes: {e}"));
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
