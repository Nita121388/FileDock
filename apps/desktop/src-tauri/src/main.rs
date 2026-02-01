#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use filedock_protocol::{is_valid_rel_path, SnapshotManifest};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const TOKEN_HEADER: &str = "x-filedock-token";
const DEVICE_ID_HEADER: &str = "x-filedock-device-id";
const DEVICE_TOKEN_HEADER: &str = "x-filedock-device-token";

#[derive(Debug, Clone, Deserialize)]
struct RestoreSnapshotRequest {
    server_base_url: String,
    token: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,
    snapshot_id: String,
    dest_dir: String,
    #[serde(default = "default_concurrency")]
    concurrency: usize,
}

fn default_concurrency() -> usize {
    4
}

#[derive(Debug, Clone, Serialize)]
struct RestoreSnapshotProgress {
    snapshot_id: String,
    path: String,
    done_files: u64,
    total_files: u64,
    done_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct RestoreSnapshotResponse {
    snapshot_id: String,
    dest_dir: String,
    total_files: u64,
    total_bytes: u64,
}

fn build_client(req: &RestoreSnapshotRequest) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();

    if let Some(tok) = req.token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(tok)
            .map_err(|e| format!("invalid token: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(id) = req.device_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let name = reqwest::header::HeaderName::from_static(DEVICE_ID_HEADER);
        let value = reqwest::header::HeaderValue::from_str(id)
            .map_err(|e| format!("invalid device_id: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(tok) = req.device_token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let name = reqwest::header::HeaderName::from_static(DEVICE_TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(tok)
            .map_err(|e| format!("invalid device_token: {e}"))?;
        headers.insert(name, value);
    }

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

fn rel_posix_to_platform_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !is_valid_rel_path(rel) {
        return Err("invalid rel path".to_string());
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        out.push(seg);
    }
    Ok(out)
}

async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir: {e}"))?;
    }

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download response: {e}"))?;

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create file: {e}"))?;

    let mut written = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("download stream: {e}"))?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("write file: {e}"))?;
        written = written.saturating_add(chunk.len() as u64);
    }

    Ok(written)
}

#[tauri::command]
async fn restore_snapshot_to_folder(
    app: AppHandle,
    req: RestoreSnapshotRequest,
) -> Result<RestoreSnapshotResponse, String> {
    if req.server_base_url.trim().is_empty() {
        return Err("server_base_url required".to_string());
    }
    if req.snapshot_id.trim().is_empty() {
        return Err("snapshot_id required".to_string());
    }
    if req.dest_dir.trim().is_empty() {
        return Err("dest_dir required".to_string());
    }

    let client = build_client(&req)?;
    let base = req.server_base_url.trim_end_matches('/').to_string();

    // Load manifest.
    let manifest_url = format!("{}/v1/snapshots/{}/manifest", base, req.snapshot_id);
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
    let total_bytes = manifest.files.iter().map(|f| f.size).sum::<u64>();

    let dest_root = PathBuf::from(req.dest_dir.clone());
    tokio::fs::create_dir_all(&dest_root)
        .await
        .map_err(|e| format!("mkdir dest: {e}"))?;

    // Download files concurrently. We emit progress after each file completes.
    let mut done_files = 0u64;
    let mut done_bytes = 0u64;

    let files = manifest.files;
    let mut tasks = futures_util::stream::iter(files.into_iter().map(|f| {
        let client = client.clone();
        let base = base.clone();
        let snapshot_id = req.snapshot_id.clone();
        let dest_root = dest_root.clone();
        async move {
            let out_path = rel_posix_to_platform_path(&dest_root, &f.path)?;
            let url = format!(
                "{}/v1/snapshots/{}/file?path={}",
                base,
                snapshot_id,
                urlencoding::encode(&f.path)
            );
            let bytes = if f.size == 0 {
                // Create empty file.
                if let Some(parent) = out_path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("mkdir: {e}"))?;
                }
                tokio::fs::write(&out_path, &[])
                    .await
                    .map_err(|e| format!("write empty file: {e}"))?;
                0u64
            } else {
                download_to_file(&client, &url, &out_path).await?
            };
            Ok::<(String, u64), String>((f.path, bytes))
        }
    }))
    .buffer_unordered(req.concurrency.max(1));

    while let Some(res) = tasks.next().await {
        let (path, bytes) = res?;
        done_files = done_files.saturating_add(1);
        done_bytes = done_bytes.saturating_add(bytes);

        let _ = app.emit_all(
            "filedock_restore_progress",
            RestoreSnapshotProgress {
                snapshot_id: req.snapshot_id.clone(),
                path,
                done_files,
                total_files,
                done_bytes,
                total_bytes,
            },
        );
    }

    Ok(RestoreSnapshotResponse {
        snapshot_id: req.snapshot_id,
        dest_dir: req.dest_dir,
        total_files,
        total_bytes,
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![restore_snapshot_to_folder])
        .run(tauri::generate_context!())
        .expect("error while running filedock desktop");
}
