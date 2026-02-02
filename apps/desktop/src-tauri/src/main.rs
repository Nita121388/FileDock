#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use filedock_protocol::{
    is_valid_rel_path, ChunkPresenceRequest, ChunkPresenceResponse, ChunkRef, ManifestFileEntry,
    SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, State};
use urlencoding::encode;

const TOKEN_HEADER: &str = "x-filedock-token";
const DEVICE_ID_HEADER: &str = "x-filedock-device-id";
const DEVICE_TOKEN_HEADER: &str = "x-filedock-device-token";
const RESTORE_EVENT: &str = "filedock_restore_progress";
const CHUNK_SIZE: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct RestoreManager {
    // snapshot_id -> cancellation flag
    cancel: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
struct PluginRunManager {
    // run_id -> cancellation flag
    cancel: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct CopySnapshotFileToSftpRequest {
    run_id: String,
    server_base_url: String,
    token: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,
    snapshot_id: String,
    path: String,
    sftp_conn: serde_json::Value,
    remote_path: String,
    runner: Option<RunnerConfig>,
    #[serde(default)]
    mkdirs: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct ImportSftpFileToSnapshotRequest {
    run_id: String,
    server_base_url: String,
    token: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,

    dst_device_name: String,
    dst_device_id: Option<String>,
    dst_base_snapshot_id: Option<String>,
    dst_path: String,
    conflict_policy: Option<String>, // "overwrite" | "skip" | "rename"

    sftp_conn: serde_json::Value,
    remote_path: String,
    runner: Option<RunnerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
struct RunnerConfig {
    filedock_path: Option<String>,
    plugin_dirs: Option<String>,
    timeout_secs: Option<u64>,
}

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

async fn download_to_file_with_retry(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<u64, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let res = download_to_file(client, url, dest).await;
        match res {
            Ok(n) => return Ok(n),
            Err(e) => {
                // Best-effort retry on transient failures (network, 5xx-ish messages).
                // We only have string errors here; keep it simple.
                let retryable = e.contains("download request:")
                    || e.contains("download stream:")
                    || e.contains("download response: 5")
                    || e.contains("download response: 429")
                    || e.contains("download response: 408");
                if attempt >= 3 || !retryable {
                    return Err(e);
                }
            }
        }

        // 250ms, 500ms (+ jitter)
        let base_ms = 250u64.saturating_mul(1u64 << (attempt - 1));
        let jitter: u64 = rand::random::<u8>() as u64;
        tokio::time::sleep(Duration::from_millis(base_ms + jitter)).await;
    }
}

async fn chunk_file(path: &Path) -> Result<Vec<ChunkRef>, String> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("open file: {e}"))?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut out = Vec::<ChunkRef>::new();
    loop {
        let n = tokio::io::AsyncReadExt::read(&mut f, &mut buf)
            .await
            .map_err(|e| format!("read file: {e}"))?;
        if n == 0 {
            break;
        }
        let hash = blake3::hash(&buf[..n]).to_hex().to_string();
        out.push(ChunkRef {
            hash,
            size: n as u64,
        });
    }
    Ok(out)
}

async fn presence_missing(
    client: &reqwest::Client,
    base: &str,
    hashes: &[String],
) -> Result<std::collections::HashSet<String>, String> {
    let mut missing = std::collections::HashSet::<String>::new();
    let url = format!("{}/v1/chunks/presence", base.trim_end_matches('/'));
    for batch in hashes.chunks(1000) {
        let req = ChunkPresenceRequest {
            hashes: batch.to_vec(),
        };
        let resp: ChunkPresenceResponse = client
            .post(&url)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("presence request: {e}"))?
            .error_for_status()
            .map_err(|e| format!("presence response: {e}"))?
            .json()
            .await
            .map_err(|e| format!("presence decode: {e}"))?;
        for h in resp.missing {
            missing.insert(h);
        }
    }
    Ok(missing)
}

fn unique_path(existing: &std::collections::HashSet<String>, desired: &str) -> String {
    if !existing.contains(desired) {
        return desired.to_string();
    }
    let dot = desired.rfind('.');
    let (base, ext) = match dot {
        Some(i) if i > 0 => (&desired[..i], &desired[i..]),
        _ => (desired, ""),
    };
    for i in 2..1000 {
        let cand = format!("{base} ({i}){ext}");
        if !existing.contains(&cand) {
            return cand;
        }
    }
    desired.to_string()
}

#[tauri::command]
fn cancel_restore_snapshot(state: State<RestoreManager>, snapshot_id: String) -> Result<bool, String> {
    let id = snapshot_id.trim();
    if id.is_empty() {
        return Err("snapshot_id required".to_string());
    }
    let mut m = state
        .cancel
        .lock()
        .map_err(|_| "restore manager lock poisoned".to_string())?;
    if let Some(flag) = m.get(id) {
        flag.store(true, Ordering::Relaxed);
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
async fn restore_snapshot_to_folder(
    app: AppHandle,
    state: State<RestoreManager>,
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

    // Register cancellation flag for this restore.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut m = state
            .cancel
            .lock()
            .map_err(|_| "restore manager lock poisoned".to_string())?;
        m.insert(req.snapshot_id.clone(), cancel_flag.clone());
    }
    struct Cleanup<'a> {
        state: &'a RestoreManager,
        snapshot_id: String,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Ok(mut m) = self.state.cancel.lock() {
                m.remove(&self.snapshot_id);
            }
        }
    }
    let _cleanup = Cleanup {
        state: &state,
        snapshot_id: req.snapshot_id.clone(),
    };

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

    // Download files concurrently. MVP cancellation stops scheduling new files; in-flight file downloads finish.
    let mut done_files = 0u64;
    let mut done_bytes = 0u64;

    let files = Arc::new(manifest.files);
    let next = Arc::new(AtomicUsize::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<(String, u64), String>>(req.concurrency.max(1) * 2);
    let mut handles = Vec::new();

    for _ in 0..req.concurrency.max(1) {
        let client = client.clone();
        let base = base.clone();
        let snapshot_id = req.snapshot_id.clone();
        let dest_root = dest_root.clone();
        let files = files.clone();
        let next = next.clone();
        let tx = tx.clone();
        let cancel = cancel_flag.clone();

        handles.push(tokio::spawn(async move {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= files.len() {
                    return;
                }
                let f = &files[i];
                let out_path = match rel_posix_to_platform_path(&dest_root, &f.path) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                };

                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                let url = format!(
                    "{}/v1/snapshots/{}/file?path={}",
                    base,
                    snapshot_id,
                    urlencoding::encode(&f.path)
                );

                let bytes = if f.size == 0 {
                    if let Some(parent) = out_path.parent() {
                        if let Err(e) = tokio::fs::create_dir_all(parent).await {
                            let _ = tx.send(Err(format!("mkdir: {e}"))).await;
                            return;
                        }
                    }
                    if let Err(e) = tokio::fs::write(&out_path, &[]).await {
                        let _ = tx.send(Err(format!("write empty file: {e}"))).await;
                        return;
                    }
                    0u64
                } else {
                    match download_to_file_with_retry(&client, &url, &out_path).await {
                        Ok(n) => n,
                        Err(e) => {
                            let _ = tx.send(Err(e)).await;
                            return;
                        }
                    }
                };

                if tx.send(Ok((f.path.clone(), bytes))).await.is_err() {
                    return;
                }
            }
        }));
    }
    drop(tx);

    while let Some(msg) = rx.recv().await {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }
        match msg {
            Ok((path, bytes)) => {
                done_files = done_files.saturating_add(1);
                done_bytes = done_bytes.saturating_add(bytes);
                let _ = app.emit_all(
                    RESTORE_EVENT,
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
            Err(e) => {
                cancel_flag.store(true, Ordering::Relaxed);
                for h in handles {
                    let _ = h.await;
                }
                return Err(e);
            }
        }
    }

    if cancel_flag.load(Ordering::Relaxed) {
        for h in handles {
            let _ = h.await;
        }
        return Err("cancelled".to_string());
    }

    for h in handles {
        let _ = h.await;
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
        .manage(RestoreManager::default())
        .manage(PluginRunManager::default())
        .invoke_handler(tauri::generate_handler![
            restore_snapshot_to_folder,
            cancel_restore_snapshot,
            run_filedock_plugin,
            cancel_filedock_plugin_run,
            copy_snapshot_file_to_sftp,
            import_sftp_file_to_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running filedock desktop");
}

#[derive(Debug, serde::Deserialize)]
struct RunFiledockPluginRequest {
    name: String,
    json: String,
    timeout_secs: Option<u64>,
    filedock_path: Option<String>,
    plugin_dirs: Option<Vec<String>>,
    run_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct RunFiledockPluginResponse {
    stdout: String,
    stderr: String,
}

#[tauri::command]
fn cancel_filedock_plugin_run(state: State<PluginRunManager>, run_id: String) -> Result<bool, String> {
    let id = run_id.trim();
    if id.is_empty() {
        return Err("runId required".to_string());
    }

    let mut m = state
        .cancel
        .lock()
        .map_err(|_| "plugin run manager lock poisoned".to_string())?;
    if let Some(flag) = m.get(id) {
        flag.store(true, Ordering::Relaxed);
        return Ok(true);
    }
    Ok(false)
}

fn build_http_client(
    token: Option<&str>,
    device_id: Option<&str>,
    device_token: Option<&str>,
) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();

    if let Some(tok) = token.map(str::trim).filter(|s| !s.is_empty()) {
        let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(tok)
            .map_err(|e| format!("invalid token: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(id) = device_id.map(str::trim).filter(|s| !s.is_empty()) {
        let name = reqwest::header::HeaderName::from_static(DEVICE_ID_HEADER);
        let value = reqwest::header::HeaderValue::from_str(id)
            .map_err(|e| format!("invalid device_id: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(tok) = device_token.map(str::trim).filter(|s| !s.is_empty()) {
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

async fn wait_cancel(flag: Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
}

#[tauri::command]
async fn copy_snapshot_file_to_sftp(
    state: State<PluginRunManager>,
    req: CopySnapshotFileToSftpRequest,
) -> Result<(), String> {
    let run_id = req.run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("run_id required".to_string());
    }
    if req.server_base_url.trim().is_empty() {
        return Err("server_base_url required".to_string());
    }
    if req.snapshot_id.trim().is_empty() {
        return Err("snapshot_id required".to_string());
    }
    if req.path.trim().is_empty() {
        return Err("path required".to_string());
    }
    if req.remote_path.trim().is_empty() {
        return Err("remote_path required".to_string());
    }

    let cancel_flag = {
        let flag = Arc::new(AtomicBool::new(false));
        let mut m = state
            .cancel
            .lock()
            .map_err(|_| "plugin run manager lock poisoned".to_string())?;
        m.insert(run_id.clone(), flag.clone());
        flag
    };

    struct Cleanup<'a> {
        state: &'a PluginRunManager,
        run_id: String,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Ok(mut m) = self.state.cancel.lock() {
                m.remove(&self.run_id);
            }
        }
    }
    let _cleanup = Cleanup {
        state: &state,
        run_id: run_id.clone(),
    };

    let client = build_http_client(
        req.token.as_deref(),
        req.device_id.as_deref(),
        req.device_token.as_deref(),
    )?;

    let base = req.server_base_url.trim_end_matches('/').to_string();
    let url = format!(
        "{}/v1/snapshots/{}/file?path={}",
        base,
        encode(req.snapshot_id.trim()),
        encode(req.path.trim())
    );

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download response: {e}"))?;

    // Write to a temp file so the SFTP plugin can read it by path.
    let mut tmp = std::env::temp_dir();
    let suffix = rand::random::<u64>();
    tmp.push(format!("filedock_{run_id}_{suffix}.tmp"));
    let tmp_str = tmp.to_string_lossy().to_string();

    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create temp file: {e}"))?;

    let mut stream = resp.bytes_stream();
    loop {
        tokio::select! {
            _ = wait_cancel(cancel_flag.clone()) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err("canceled".to_string());
            }
            item = stream.next() => {
                match item {
                    None => break,
                    Some(Ok(bytes)) => {
                        tokio::io::AsyncWriteExt::write_all(&mut file, &bytes)
                            .await
                            .map_err(|e| format!("write temp file: {e}"))?;
                    }
                    Some(Err(e)) => {
                        let _ = tokio::fs::remove_file(&tmp).await;
                        return Err(format!("download stream: {e}"));
                    }
                }
            }
        }
    }

    // Build the plugin payload.
    let payload = serde_json::json!({
        "op": "upload",
        "conn": req.sftp_conn,
        "args": {
            "local_path": tmp_str,
            "remote_path": req.remote_path,
            "mkdirs": req.mkdirs,
        }
    });
    let json = serde_json::to_string(&payload).map_err(|e| format!("encode plugin json: {e}"))?;

    let runner = req.runner.unwrap_or(RunnerConfig {
        filedock_path: None,
        plugin_dirs: None,
        timeout_secs: None,
    });
    let (filedock, filedock_dir) = resolve_filedock_path(runner.filedock_path.as_deref());
    let timeout_secs = runner.timeout_secs.unwrap_or(600).max(1);

    let mut cmd = tokio::process::Command::new(filedock);
    cmd.arg("plugin")
        .arg("run")
        .arg("--name")
        .arg("sftp")
        .arg("--json")
        .arg(&json)
        .arg("--raw")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    if let Some(dirs) = runner.plugin_dirs.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dirs);
    } else if let Some(dir) = filedock_dir {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dir.to_string_lossy().to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn filedock: {e}"))?;
    let output = tokio::select! {
        res = child.wait_with_output() => {
            res.map_err(|e| format!("wait filedock: {e}"))?
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("plugin timed out after {timeout_secs}s"));
        }
        _ = wait_cancel(cancel_flag.clone()) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("canceled".to_string());
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let _ = tokio::fs::remove_file(&tmp).await;

    if !output.status.success() {
        return Err(format!("plugin failed: {} {}", output.status, stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn import_sftp_file_to_snapshot(
    state: State<PluginRunManager>,
    req: ImportSftpFileToSnapshotRequest,
) -> Result<(), String> {
    let run_id = req.run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("run_id required".to_string());
    }
    if req.server_base_url.trim().is_empty() {
        return Err("server_base_url required".to_string());
    }
    if req.dst_device_name.trim().is_empty() {
        return Err("dst_device_name required".to_string());
    }
    let dst_path = req.dst_path.trim().to_string();
    if dst_path.is_empty() {
        return Err("dst_path required".to_string());
    }
    if !is_valid_rel_path(&dst_path) {
        return Err("dst_path must be a relative POSIX path (no leading slash, no ..)".to_string());
    }
    if req.remote_path.trim().is_empty() {
        return Err("remote_path required".to_string());
    }

    let cancel_flag = {
        let flag = Arc::new(AtomicBool::new(false));
        let mut m = state
            .cancel
            .lock()
            .map_err(|_| "plugin run manager lock poisoned".to_string())?;
        m.insert(run_id.clone(), flag.clone());
        flag
    };

    struct Cleanup<'a> {
        state: &'a PluginRunManager,
        run_id: String,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Ok(mut m) = self.state.cancel.lock() {
                m.remove(&self.run_id);
            }
        }
    }
    let _cleanup = Cleanup {
        state: &state,
        run_id: run_id.clone(),
    };

    // Download remote SFTP file to a temp file (so we can chunk+upload it).
    let mut tmp = std::env::temp_dir();
    let suffix = rand::random::<u64>();
    tmp.push(format!("filedock_sftp_import_{run_id}_{suffix}.tmp"));
    let tmp_str = tmp.to_string_lossy().to_string();

    let runner = req.runner.clone().unwrap_or(RunnerConfig {
        filedock_path: None,
        plugin_dirs: None,
        timeout_secs: None,
    });
    let (filedock, filedock_dir) = resolve_filedock_path(runner.filedock_path.as_deref());
    let timeout_secs = runner.timeout_secs.unwrap_or(900).max(1);

    let payload = serde_json::json!({
        "op": "download",
        "conn": req.sftp_conn,
        "args": {
            "remote_path": req.remote_path,
            "local_path": tmp_str,
        }
    });
    let json = serde_json::to_string(&payload).map_err(|e| format!("encode plugin json: {e}"))?;

    let mut cmd = tokio::process::Command::new(filedock);
    cmd.arg("plugin")
        .arg("run")
        .arg("--name")
        .arg("sftp")
        .arg("--json")
        .arg(&json)
        .arg("--raw")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    if let Some(dirs) = runner.plugin_dirs.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dirs);
    } else if let Some(dir) = filedock_dir {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dir.to_string_lossy().to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn filedock: {e}"))?;
    let output = tokio::select! {
        res = child.wait_with_output() => {
            res.map_err(|e| format!("wait filedock: {e}"))?
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("plugin timed out after {timeout_secs}s"));
        }
        _ = wait_cancel(cancel_flag.clone()) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("canceled".to_string());
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(format!("plugin failed: {} {}", output.status, stderr.trim()));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err("canceled".to_string());
    }

    // Chunk+upload to the destination server.
    let client = build_http_client(
        req.token.as_deref(),
        req.device_id.as_deref(),
        req.device_token.as_deref(),
    )?;
    let base = req.server_base_url.trim_end_matches('/').to_string();

    let chunks = chunk_file(&tmp).await?;
    let hashes = chunks.iter().map(|c| c.hash.clone()).collect::<Vec<_>>();
    let missing = presence_missing(&client, &base, &hashes).await?;

    if !missing.is_empty() {
        let mut f = tokio::fs::File::open(&tmp)
            .await
            .map_err(|e| format!("open temp file: {e}"))?;

        for c in &chunks {
            if cancel_flag.load(Ordering::Relaxed) {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err("canceled".to_string());
            }
            let mut buf = vec![0u8; c.size as usize];
            tokio::io::AsyncReadExt::read_exact(&mut f, &mut buf)
                .await
                .map_err(|e| format!("read temp file: {e}"))?;

            if missing.contains(&c.hash) {
                let url = format!("{}/v1/chunks/{}", base, encode(&c.hash));
                client
                    .put(url)
                    .body(buf)
                    .send()
                    .await
                    .map_err(|e| format!("upload chunk request: {e}"))?
                    .error_for_status()
                    .map_err(|e| format!("upload chunk response: {e}"))?;
            }
        }
    }

    // Base manifest (optional).
    let mut file_map = std::collections::HashMap::<String, ManifestFileEntry>::new();
    if let Some(base_id) = req
        .dst_base_snapshot_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let url = format!("{}/v1/snapshots/{}/manifest", base, encode(base_id));
        if let Ok(resp) = client.get(url).send().await {
            if let Ok(resp) = resp.error_for_status() {
                if let Ok(m) = resp.json::<SnapshotManifest>().await {
                    for f in m.files {
                        if f.path.trim().is_empty() {
                            continue;
                        }
                        // Normalize to chunks-only form (server accepts both, but we want stable manifests).
                        let chunks = if let Some(chunks) = f.chunks.clone() {
                            Some(chunks)
                        } else if let Some(h) = f.chunk_hash.as_deref() {
                            Some(vec![ChunkRef {
                                hash: h.to_string(),
                                size: f.size,
                            }])
                        } else {
                            Some(vec![])
                        };
                        file_map.insert(
                            f.path.clone(),
                            ManifestFileEntry {
                                path: f.path,
                                size: f.size,
                                mtime_unix: f.mtime_unix,
                                chunk_hash: None,
                                chunks,
                            },
                        );
                    }
                }
            }
        }
    }

    let policy = req.conflict_policy.as_deref().unwrap_or("overwrite");
    let mut existing = std::collections::HashSet::<String>::new();
    for k in file_map.keys() {
        existing.insert(k.to_string());
    }

    let final_path = if existing.contains(&dst_path) {
        match policy {
            "skip" => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Ok(());
            }
            "rename" => unique_path(&existing, &dst_path),
            _ => dst_path.clone(), // overwrite
        }
    } else {
        dst_path.clone()
    };

    // Create destination snapshot and write manifest.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("time: {e}"))?
        .as_secs() as i64;
    let create_url = format!("{}/v1/snapshots", base);
    let create_req = SnapshotCreateRequest {
        device_name: req.dst_device_name.trim().to_string(),
        device_id: req
            .dst_device_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        root_path: format!("(sftp import: {})", final_path),
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

    file_map.insert(
        final_path.clone(),
        ManifestFileEntry {
            path: final_path,
            size: tokio::fs::metadata(&tmp)
                .await
                .map_err(|e| format!("stat temp file: {e}"))?
                .len(),
            mtime_unix: now,
            chunk_hash: None,
            chunks: Some(chunks),
        },
    );

    let mut files = file_map.into_values().collect::<Vec<_>>();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let manifest = SnapshotManifest {
        snapshot_id: create_resp.snapshot_id.clone(),
        created_unix: now,
        files,
    };

    let manifest_url = format!(
        "{}/v1/snapshots/{}/manifest",
        base,
        encode(&create_resp.snapshot_id)
    );
    client
        .put(manifest_url)
        .json(&manifest)
        .send()
        .await
        .map_err(|e| format!("manifest request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("manifest response: {e}"))?;

    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(())
}

fn resolve_filedock_path(explicit: Option<&str>) -> (String, Option<PathBuf>) {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        return (p.to_string(), pb.parent().map(Path::to_path_buf));
    }

    // For packaged apps, prefer a sidecar binary next to the main executable.
    // Fall back to "filedock" on PATH.
    let exe = tauri::process::current_binary().ok();
    let exe_dir = exe.as_deref().and_then(|p| p.parent()).map(Path::to_path_buf);
    if let Some(dir) = exe_dir {
        let mut candidates = vec![dir.join("filedock")];
        if cfg!(windows) {
            candidates.push(dir.join("filedock.exe"));
        }

        // Also accept any file matching filedock-<triple> in the same dir (best-effort).
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if name.starts_with("filedock-") {
                    candidates.push(p);
                }
            }
        }

        for c in candidates {
            if c.is_file() {
                return (c.to_string_lossy().to_string(), c.parent().map(Path::to_path_buf));
            }
        }
    }

    ("filedock".to_string(), None)
}

#[tauri::command]
async fn run_filedock_plugin(
    state: State<PluginRunManager>,
    req: RunFiledockPluginRequest,
) -> Result<RunFiledockPluginResponse, String> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err("name required".to_string());
    }

    // Validate JSON early so the UI gets clean errors.
    let _: serde_json::Value =
        serde_json::from_str(&req.json).map_err(|e| format!("invalid json: {e}"))?;

    let (filedock, filedock_dir) = resolve_filedock_path(req.filedock_path.as_deref());

    let timeout_secs = req.timeout_secs.unwrap_or(30).max(1);
    let run_id = req
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let cancel_flag = if let Some(id) = run_id.as_deref() {
        let flag = Arc::new(AtomicBool::new(false));
        let mut m = state
            .cancel
            .lock()
            .map_err(|_| "plugin run manager lock poisoned".to_string())?;
        m.insert(id.to_string(), flag.clone());
        Some(flag)
    } else {
        None
    };

    struct Cleanup<'a> {
        state: &'a PluginRunManager,
        run_id: Option<String>,
    }
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            if let Some(id) = self.run_id.as_deref() {
                if let Ok(mut m) = self.state.cancel.lock() {
                    m.remove(id);
                }
            }
        }
    }
    let _cleanup = Cleanup {
        state: &state,
        run_id: run_id.clone(),
    };

    let mut cmd = tokio::process::Command::new(filedock);
    cmd.arg("plugin")
        .arg("run")
        .arg("--name")
        .arg(&name)
        .arg("--json")
        .arg(&req.json)
        .arg("--raw")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(dirs) = req.plugin_dirs.as_ref() {
        let joined = dirs
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(":");
        if !joined.is_empty() {
            cmd.env("FILEDOCK_PLUGIN_DIRS", joined);
        }
    } else if let Some(dir) = filedock_dir {
        // Default to the filedock sidecar directory so plugins (e.g. filedock-sftp) can live alongside it.
        cmd.env("FILEDOCK_PLUGIN_DIRS", dir.to_string_lossy().to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn filedock: {e}"))?;
    let output = tokio::select! {
        res = child.wait_with_output() => {
            res.map_err(|e| format!("wait filedock: {e}"))?
        }
        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {
            let _ = child.kill().await;
            return Err(format!("plugin timed out after {timeout_secs}s"));
        }
        _ = async {
            if let Some(flag) = cancel_flag.as_ref() {
                loop {
                    if flag.load(Ordering::Relaxed) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                }
            } else {
                futures_util::future::pending::<()>().await;
            }
        } => {
            let _ = child.kill().await;
            return Err("canceled".to_string());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("plugin failed: {} {}", output.status, stderr.trim()));
    }

    Ok(RunFiledockPluginResponse { stdout, stderr })
}
