#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use filedock_protocol::{
    is_valid_rel_path, ChunkPresenceRequest, ChunkPresenceResponse, ChunkRef, ManifestFileEntry,
    SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest,
};
use futures_util::StreamExt;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use urlencoding::encode;

const TOKEN_HEADER: &str = "x-filedock-token";
const DEVICE_ID_HEADER: &str = "x-filedock-device-id";
const DEVICE_TOKEN_HEADER: &str = "x-filedock-device-token";
const RESTORE_EVENT: &str = "filedock_restore_progress";
const IMPORT_EVENT: &str = "filedock_import_progress";
const TERMINAL_OUTPUT_EVENT: &str = "filedock_terminal_output";
const TERMINAL_EXIT_EVENT: &str = "filedock_terminal_exit";
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

struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Default)]
struct TerminalManager {
    sessions: Arc<std::sync::Mutex<HashMap<String, TerminalSession>>>,
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
    #[serde(default)]
    dst_root_path: Option<String>,
    dst_path: String,
    conflict_policy: Option<String>, // "overwrite" | "skip" | "rename"
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    delete_remote: bool,

    sftp_conn: serde_json::Value,
    remote_path: String,
    runner: Option<RunnerConfig>,
}

#[derive(Debug, Clone, Deserialize)]
struct TerminalStartRequest {
    kind: String, // "local" | "ssh"
    cols: Option<u16>,
    rows: Option<u16>,
    cwd: Option<String>,
    conn: Option<TerminalSshConn>,
}

#[derive(Debug, Serialize)]
struct TerminalStartResponse {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TerminalSshConn {
    host: String,
    port: u16,
    user: String,
    auth: TerminalSshAuth,
    known_hosts: TerminalKnownHosts,
    #[serde(default)]
    base_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TerminalSshAuth {
    password: String,
    key_path: String,
    agent: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TerminalKnownHosts {
    policy: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalExitPayload {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PushFolderSnapshotRequest {
    server_base_url: String,
    token: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,
    device_name: String,
    folder: String,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    concurrency: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
struct PushFolderSnapshotResponse {
    snapshot_id: Option<String>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentInitRequest {
    profile: String,
    folder: String,
    server_base_url: String,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    interval_secs: Option<u64>,
    #[serde(default)]
    heartbeat_secs: Option<u64>,
    #[serde(default)]
    keep_bootstrap_token: bool,
    #[serde(default)]
    no_default_excludes: bool,
    #[serde(default)]
    respect_gitignore: bool,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    device_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentInstallMode {
    Daemon,
    Scheduled,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentInstallRequest {
    profile: String,
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    mode: Option<AgentInstallMode>,
}

#[derive(Debug, Clone, Deserialize)]
struct AgentUninstallRequest {
    profile: String,
    #[serde(default)]
    delete_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentInitSummary {
    profile: String,
    config_path: String,
    state_path: String,
    server: String,
    device_name: String,
    folder: String,
    #[serde(default)]
    exclude: Vec<String>,
    #[serde(default)]
    ignore_file: Option<String>,
    #[serde(default)]
    respect_gitignore: bool,
    #[serde(default)]
    default_excludes_applied: bool,
    auth_mode: String,
    device_registered: bool,
    device_id: Option<String>,
    kept_bootstrap_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentInstallSummary {
    profile: String,
    config_path: String,
    service_manager: String,
    service_name: String,
    service_path: Option<String>,
    dry_run: bool,
    installed: bool,
    enabled: Option<bool>,
    running: Option<bool>,
    note: Option<String>,
    preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentServiceStatus {
    manager: String,
    name: String,
    path: Option<String>,
    installed: bool,
    enabled: Option<bool>,
    running: Option<bool>,
    note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentServerStatus {
    ok: bool,
    auth_mode: String,
    device_id: Option<String>,
    last_seen_unix: Option<i64>,
    snapshot_count: Option<usize>,
    latest_snapshot_id: Option<String>,
    latest_snapshot_created_unix: Option<i64>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentStatusSummary {
    profile: String,
    config_path: String,
    config_exists: bool,
    state_path: String,
    state_exists: bool,
    server: Option<String>,
    folder: Option<String>,
    device_name: Option<String>,
    auth_mode: Option<String>,
    service: AgentServiceStatus,
    server_status: Option<AgentServerStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentUninstallSummary {
    profile: String,
    config_path: String,
    service_manager: String,
    service_name: String,
    service_path: Option<String>,
    removed_service: bool,
    removed_config: bool,
    note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RunnerConfig {
    filedock_path: Option<String>,
    plugin_dirs: Option<String>,
    timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct SftpPluginError {
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SftpPluginResponse {
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<SftpPluginError>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct SftpStatResponse {
    kind: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    mtime_unix: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
struct SftpListEntry {
    name: String,
    kind: String, // file | dir | other
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    mtime_unix: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct SftpListResponse {
    entries: Vec<SftpListEntry>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RestoreConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

fn default_restore_conflict_policy() -> RestoreConflictPolicy {
    RestoreConflictPolicy::Overwrite
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
    #[serde(default = "default_restore_conflict_policy")]
    conflict_policy: RestoreConflictPolicy,
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

#[derive(Debug, Clone, Serialize)]
struct ImportSftpProgress {
    run_id: String,
    phase: String,
    done_bytes: Option<u64>,
    total_bytes: Option<u64>,
    pct: Option<u32>,
}

fn build_client(req: &RestoreSnapshotRequest) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();

    if let Some(tok) = req
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(tok)
            .map_err(|e| format!("invalid token: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(id) = req
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let name = reqwest::header::HeaderName::from_static(DEVICE_ID_HEADER);
        let value = reqwest::header::HeaderValue::from_str(id)
            .map_err(|e| format!("invalid device_id: {e}"))?;
        headers.insert(name, value);
    }
    if let Some(tok) = req
        .device_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
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

async fn download_to_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<u64, String> {
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

async fn path_exists(path: &Path) -> Result<bool, String> {
    match tokio::fs::metadata(path).await {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("stat {}: {e}", path.display())),
    }
}

async fn unique_restore_path(original: &Path, snapshot_id: &str) -> Result<PathBuf, String> {
    let parent = original
        .parent()
        .ok_or_else(|| "dest path must have a parent".to_string())?;
    let file_name = original
        .file_name()
        .ok_or_else(|| "dest path must have a file name".to_string())?
        .to_string_lossy()
        .to_string();

    let snap: String = snapshot_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let snap = if snap.is_empty() {
        "snap"
    } else {
        snap.as_str()
    };

    let dot = file_name.rfind('.');
    let (stem, ext) = match dot {
        Some(i) if i > 0 => (&file_name[..i], &file_name[i..]),
        _ => (file_name.as_str(), ""),
    };

    for i in 1..1000u32 {
        let suffix = if i == 1 {
            format!(" (restore {snap})")
        } else {
            format!(" (restore {snap}-{i})")
        };
        let cand = parent.join(format!("{stem}{suffix}{ext}"));
        if !path_exists(&cand).await? {
            return Ok(cand);
        }
    }

    Err("unable to pick a unique restore destination (too many conflicts)".to_string())
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

fn emit_import(
    app: &AppHandle,
    run_id: &str,
    phase: &str,
    done_bytes: Option<u64>,
    total_bytes: Option<u64>,
    pct: Option<u32>,
) {
    let _ = app.emit(
        IMPORT_EVENT,
        ImportSftpProgress {
            run_id: run_id.to_string(),
            phase: phase.to_string(),
            done_bytes,
            total_bytes,
            pct,
        },
    );
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

fn join_posix(a: &str, b: &str) -> String {
    let aa = a.trim_end_matches('/');
    let bb = b.trim_start_matches('/');
    if aa.is_empty() {
        if bb.is_empty() {
            return "/".to_string();
        }
        return format!("/{bb}");
    }
    if bb.is_empty() {
        return aa.to_string();
    }
    format!("{aa}/{bb}")
}

fn rel_from_root(root: &str, full: &str) -> Option<String> {
    let r = if root == "/" {
        ""
    } else {
        root.trim_end_matches('/')
    };
    let f = if full == "/" {
        ""
    } else {
        full.trim_end_matches('/')
    };
    if r.is_empty() {
        return Some(f.trim_start_matches('/').to_string());
    }
    if f == r {
        return Some(String::new());
    }
    if !f.starts_with(r) {
        return None;
    }
    Some(f[r.len()..].trim_start_matches('/').to_string())
}

#[derive(Debug, Serialize)]
struct LocalDirEntry {
    name: String,
    path: String,
    kind: String, // "file" | "dir"
    size: u64,
    mtime_unix: Option<u64>,
}

#[tauri::command]
fn list_local_dir(path: String) -> Result<Vec<LocalDirEntry>, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("path required".to_string());
    }
    let dir = PathBuf::from(raw);
    let meta = std::fs::metadata(&dir).map_err(|e| format!("metadata: {e}"))?;
    if !meta.is_dir() {
        return Err("not a directory".to_string());
    }

    let mut entries = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    for item in rd {
        let entry = item.map_err(|e| format!("read_dir item: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().map_err(|e| format!("metadata: {e}"))?;
        let kind = if meta.is_dir() { "dir" } else { "file" };
        let mtime_unix = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        entries.push(LocalDirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
            size: meta.len(),
            mtime_unix,
        });
    }

    Ok(entries)
}

#[tauri::command]
fn local_rename(path: String, new_name: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("path required".to_string());
    }
    let name = new_name.trim();
    if name.is_empty() {
        return Err("new_name required".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("invalid name".to_string());
    }

    let from = PathBuf::from(raw);
    let parent = from
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    let to = parent.join(name);
    std::fs::rename(&from, &to).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[tauri::command]
fn local_move(from: String, to: String) -> Result<(), String> {
    let src = from.trim();
    let dst = to.trim();
    if src.is_empty() {
        return Err("from required".to_string());
    }
    if dst.is_empty() {
        return Err("to required".to_string());
    }
    std::fs::rename(src, dst).map_err(|e| format!("move: {e}"))?;
    Ok(())
}

#[tauri::command]
fn local_delete(path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("path required".to_string());
    }
    let meta = std::fs::metadata(raw).map_err(|e| format!("metadata: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(raw).map_err(|e| format!("remove_dir_all: {e}"))?;
    } else {
        std::fs::remove_file(raw).map_err(|e| format!("remove_file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn local_copy(from: String, to: String) -> Result<(), String> {
    let src = from.trim();
    let dst = to.trim();
    if src.is_empty() {
        return Err("from required".to_string());
    }
    if dst.is_empty() {
        return Err("to required".to_string());
    }
    let meta = std::fs::metadata(src).map_err(|e| format!("metadata: {e}"))?;
    if !meta.is_file() {
        return Err("copy only supports files".to_string());
    }
    if let Some(parent) = Path::new(dst).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdirs: {e}"))?;
        }
    }
    std::fs::copy(src, dst).map_err(|e| format!("copy: {e}"))?;
    Ok(())
}

fn next_terminal_id() -> String {
    static TERMINAL_SEQ: AtomicUsize = AtomicUsize::new(1);
    let n = TERMINAL_SEQ.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("term_{now}_{n}")
}

fn default_shell_command() -> CommandBuilder {
    if cfg!(windows) {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        CommandBuilder::new(shell)
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
}

fn resolve_local_cwd(raw: Option<String>) -> Option<PathBuf> {
    let trimmed = raw.unwrap_or_default();
    if trimmed.trim().is_empty() {
        return default_home_dir();
    }
    let pb = PathBuf::from(trimmed);
    if pb.is_dir() {
        return Some(pb);
    }
    default_home_dir()
}

fn default_home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    None
}

#[tauri::command]
fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalManager>,
    req: TerminalStartRequest,
) -> Result<TerminalStartResponse, String> {
    let cols = req.cols.unwrap_or(80).max(1);
    let rows = req.rows.unwrap_or(24).max(1);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open pty: {e}"))?;

    let mut cmd = if req.kind.trim() == "ssh" {
        let conn = req
            .conn
            .as_ref()
            .ok_or_else(|| "conn required for ssh".to_string())?;
        let config = serde_json::json!({
            "conn": conn,
            "cwd": req.cwd.clone().unwrap_or_default(),
            "cols": cols,
            "rows": rows,
            "term": "xterm-256color"
        });
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&config).map_err(|e| format!("encode ssh config: {e}"))?);
        let exe = resolve_sidecar_path("filedock-ssh");
        let mut cmd = CommandBuilder::new(exe);
        // `CommandBuilder::arg` mutates in-place and returns `()`, so don't chain it.
        cmd.arg("--config-b64");
        cmd.arg(encoded);
        cmd
    } else {
        let mut cmd = default_shell_command();
        if let Some(cwd) = resolve_local_cwd(req.cwd.clone()) {
            cmd.cwd(cwd);
        }
        cmd
    };

    cmd.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn terminal: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let session_id = next_terminal_id();
    let sessions = state.sessions.clone();
    {
        let mut m = sessions
            .lock()
            .map_err(|_| "terminal manager lock poisoned".to_string())?;
        m.insert(
            session_id.clone(),
            TerminalSession {
                writer,
                master: pair.master,
                child,
            },
        );
    }

    let app_handle = app.clone();
    let session_for_thread = session_id.clone();
    std::thread::spawn(move || {
        let mut rdr = reader;
        let mut buf = [0u8; 8192];
        loop {
            match rdr.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(
                        TERMINAL_OUTPUT_EVENT,
                        TerminalOutputPayload {
                            session_id: session_for_thread.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(
            TERMINAL_EXIT_EVENT,
            TerminalExitPayload {
                session_id: session_for_thread.clone(),
            },
        );
        if let Ok(mut m) = sessions.lock() {
            m.remove(&session_for_thread);
        }
    });

    Ok(TerminalStartResponse { session_id })
}

#[tauri::command]
fn terminal_write(
    state: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut m = state
        .sessions
        .lock()
        .map_err(|_| "terminal manager lock poisoned".to_string())?;
    let sess = m
        .get_mut(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("terminal write: {e}"))?;
    sess.writer
        .flush()
        .map_err(|e| format!("terminal flush: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let m = state
        .sessions
        .lock()
        .map_err(|_| "terminal manager lock poisoned".to_string())?;
    let sess = m
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    sess.master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("terminal resize: {e}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_close(state: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    let mut m = state
        .sessions
        .lock()
        .map_err(|_| "terminal manager lock poisoned".to_string())?;
    if let Some(mut sess) = m.remove(&session_id) {
        let _ = sess.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn cancel_restore_snapshot(
    state: State<'_, RestoreManager>,
    snapshot_id: String,
) -> Result<bool, String> {
    let id = snapshot_id.trim();
    if id.is_empty() {
        return Err("snapshot_id required".to_string());
    }
    let m = state
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
    state: State<'_, RestoreManager>,
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
    let conflict_policy = req.conflict_policy;
    let (tx, mut rx) =
        tokio::sync::mpsc::channel::<Result<(String, u64), String>>(req.concurrency.max(1) * 2);
    let mut handles = Vec::new();

    for _ in 0..req.concurrency.max(1) {
        let client = client.clone();
        let base = base.clone();
        let snapshot_id = req.snapshot_id.clone();
        let dest_root = dest_root.clone();
        let files = files.clone();
        let next = next.clone();
        let conflict_policy = conflict_policy;
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
                let mut out_path = match rel_posix_to_platform_path(&dest_root, &f.path) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        return;
                    }
                };

                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                match conflict_policy {
                    RestoreConflictPolicy::Overwrite => {}
                    RestoreConflictPolicy::Skip => match path_exists(&out_path).await {
                        Ok(true) => {
                            if tx.send(Ok((f.path.clone(), f.size))).await.is_err() {
                                return;
                            }
                            continue;
                        }
                        Ok(false) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e)).await;
                            return;
                        }
                    },
                    RestoreConflictPolicy::Rename => match path_exists(&out_path).await {
                        Ok(true) => match unique_restore_path(&out_path, &snapshot_id).await {
                            Ok(p) => out_path = p,
                            Err(e) => {
                                let _ = tx.send(Err(e)).await;
                                return;
                            }
                        },
                        Ok(false) => {}
                        Err(e) => {
                            let _ = tx.send(Err(e)).await;
                            return;
                        }
                    },
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
                let _ = app.emit(
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
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            restore_snapshot_to_folder,
            cancel_restore_snapshot,
            list_local_dir,
            local_rename,
            local_move,
            local_delete,
            local_copy,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_close,
            agent_init,
            agent_install,
            agent_uninstall,
            agent_status,
            run_filedock_plugin,
            cancel_filedock_plugin_run,
            copy_snapshot_file_to_sftp,
            import_sftp_file_to_snapshot,
            push_folder_snapshot
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
fn cancel_filedock_plugin_run(
    state: State<'_, PluginRunManager>,
    run_id: String,
) -> Result<bool, String> {
    let id = run_id.trim();
    if id.is_empty() {
        return Err("runId required".to_string());
    }

    let m = state
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

fn summarize_http_body(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let max_chars = 240;
    let truncated: String = compact.chars().take(max_chars).collect();
    if compact.chars().count() > max_chars {
        format!("{truncated}…")
    } else {
        truncated
    }
}

async fn ensure_success_response(
    resp: reqwest::Response,
    label: &str,
) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }

    let body = resp.text().await.unwrap_or_default();
    let body = summarize_http_body(body.trim());
    if body.is_empty() {
        Err(format!("{label}: HTTP {status}"))
    } else {
        Err(format!("{label}: HTTP {status} - {body}"))
    }
}

async fn wait_cancel(flag: Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
}

async fn push_file_snapshot(
    req: &PushFolderSnapshotRequest,
    path: &Path,
) -> Result<PushFolderSnapshotResponse, String> {
    let server = req.server_base_url.trim_end_matches('/');
    let device = req.device_name.trim();
    let client = build_http_client(
        req.token.as_deref(),
        req.device_id.as_deref(),
        req.device_token.as_deref(),
    )?;

    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "file name required".to_string())?
        .to_string();
    let root_path = path.to_string_lossy().to_string();
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let create_req = SnapshotCreateRequest {
        device_name: device.to_string(),
        device_id: req
            .device_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        root_path,
        note,
    };
    let create_url = format!("{}/v1/snapshots", server);
    let create_resp = client
        .post(create_url)
        .json(&create_req)
        .send()
        .await
        .map_err(|e| format!("create snapshot request: {e}"))?;
    let create_resp: SnapshotCreateResponse =
        ensure_success_response(create_resp, "create snapshot response")
            .await?
            .json()
            .await
            .map_err(|e| format!("create snapshot decode: {e}"))?;
    let snapshot_id = create_resp.snapshot_id.clone();

    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("stat file: {e}"))?;
    let size = meta.len();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("time: {e}"))?
        .as_secs() as i64;
    let mtime_unix = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(now);

    let chunks = chunk_file(path).await?;
    let hashes = chunks.iter().map(|c| c.hash.clone()).collect::<Vec<_>>();
    let missing = presence_missing(&client, server, &hashes).await?;

    if !missing.is_empty() {
        let mut f = tokio::fs::File::open(path)
            .await
            .map_err(|e| format!("open file: {e}"))?;
        for c in &chunks {
            let mut buf = vec![0u8; c.size as usize];
            tokio::io::AsyncReadExt::read_exact(&mut f, &mut buf)
                .await
                .map_err(|e| format!("read file: {e}"))?;
            if missing.contains(&c.hash) {
                let url = format!("{}/v1/chunks/{}", server, encode(&c.hash));
                let upload_resp = client
                    .put(url)
                    .body(buf)
                    .send()
                    .await
                    .map_err(|e| format!("upload chunk request: {e}"))?;
                ensure_success_response(upload_resp, "upload chunk response").await?;
            }
        }
    }

    let manifest = SnapshotManifest {
        snapshot_id: snapshot_id.clone(),
        created_unix: now,
        files: vec![ManifestFileEntry {
            path: file_name,
            size,
            mtime_unix,
            chunk_hash: None,
            chunks: Some(chunks),
        }],
    };

    let manifest_url = format!("{}/v1/snapshots/{}/manifest", server, encode(&snapshot_id));
    let manifest_resp = client
        .put(manifest_url)
        .json(&manifest)
        .send()
        .await
        .map_err(|e| format!("manifest request: {e}"))?;
    ensure_success_response(manifest_resp, "manifest response").await?;

    Ok(PushFolderSnapshotResponse {
        snapshot_id: Some(snapshot_id.clone()),
        stdout: format!("snapshot: {snapshot_id}"),
        stderr: String::new(),
    })
}

#[cfg(windows)]
fn apply_no_window(cmd: &mut tokio::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_cmd: &mut tokio::process::Command) {}

#[derive(Debug, Clone)]
struct SftpFileRef {
    remote_path: String,
    rel_path: String,
}

#[derive(Debug, Clone)]
struct SftpTree {
    files: Vec<SftpFileRef>,
    dirs: Vec<String>,
}

async fn run_sftp_plugin(
    filedock: &str,
    filedock_dir: Option<&PathBuf>,
    runner: &RunnerConfig,
    timeout_secs: u64,
    cancel_flag: &Arc<AtomicBool>,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let json = serde_json::to_string(&payload).map_err(|e| format!("encode plugin json: {e}"))?;
    let mut cmd = tokio::process::Command::new(filedock);
    apply_no_window(&mut cmd);
    cmd.arg("plugin")
        .arg("run")
        .arg("--name")
        .arg("sftp")
        .arg("--json")
        .arg(&json)
        .arg("--raw")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(dirs) = runner
        .plugin_dirs
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dirs);
    } else if let Some(dir) = filedock_dir {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dir.to_string_lossy().to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn filedock: {e}"))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let status = tokio::select! {
        res = child.wait() => res.map_err(|e| format!("wait filedock: {e}"))?,
        _ = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs)) => {
            let _ = child.kill().await;
            return Err(format!("plugin timed out after {timeout_secs}s"));
        }
        _ = wait_cancel(cancel_flag.clone()) => {
            let _ = child.kill().await;
            return Err("canceled".to_string());
        }
    };
    let mut stdout_buf = Vec::new();
    if let Some(mut s) = stdout_pipe {
        tokio::io::AsyncReadExt::read_to_end(&mut s, &mut stdout_buf)
            .await
            .map_err(|e| format!("read filedock stdout: {e}"))?;
    }
    let mut stderr_buf = Vec::new();
    if let Some(mut s) = stderr_pipe {
        tokio::io::AsyncReadExt::read_to_end(&mut s, &mut stderr_buf)
            .await
            .map_err(|e| format!("read filedock stderr: {e}"))?;
    }
    let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
    if !status.success() {
        return Err(format!("plugin failed: {} {}", status, stderr.trim()));
    }
    let parsed: SftpPluginResponse =
        serde_json::from_str(stdout.trim()).map_err(|e| format!("decode plugin output: {e}"))?;
    if !parsed.ok {
        let msg = parsed
            .error
            .as_ref()
            .map(|e| e.message.clone())
            .unwrap_or_else(|| "plugin error".to_string());
        return Err(msg);
    }
    Ok(parsed.data.unwrap_or(serde_json::Value::Null))
}

async fn sftp_stat(
    filedock: &str,
    filedock_dir: Option<&PathBuf>,
    runner: &RunnerConfig,
    timeout_secs: u64,
    cancel_flag: &Arc<AtomicBool>,
    conn: &serde_json::Value,
    path: &str,
) -> Result<SftpStatResponse, String> {
    let payload = serde_json::json!({
        "op": "stat",
        "conn": conn,
        "args": { "path": path }
    });
    let data = run_sftp_plugin(
        filedock,
        filedock_dir,
        runner,
        timeout_secs,
        cancel_flag,
        payload,
    )
    .await?;
    serde_json::from_value(data).map_err(|e| format!("decode sftp stat: {e}"))
}

async fn sftp_list(
    filedock: &str,
    filedock_dir: Option<&PathBuf>,
    runner: &RunnerConfig,
    timeout_secs: u64,
    cancel_flag: &Arc<AtomicBool>,
    conn: &serde_json::Value,
    path: &str,
) -> Result<Vec<SftpListEntry>, String> {
    let payload = serde_json::json!({
        "op": "list",
        "conn": conn,
        "args": { "path": path }
    });
    let data = run_sftp_plugin(
        filedock,
        filedock_dir,
        runner,
        timeout_secs,
        cancel_flag,
        payload,
    )
    .await?;
    let resp: SftpListResponse =
        serde_json::from_value(data).map_err(|e| format!("decode sftp list: {e}"))?;
    Ok(resp.entries)
}

async fn collect_sftp_tree(
    filedock: &str,
    filedock_dir: Option<&PathBuf>,
    runner: &RunnerConfig,
    timeout_secs: u64,
    cancel_flag: &Arc<AtomicBool>,
    conn: &serde_json::Value,
    root: &str,
) -> Result<SftpTree, String> {
    let mut files: Vec<SftpFileRef> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    let mut stack: Vec<String> = Vec::new();

    let root_norm = if root == "/" {
        "/".to_string()
    } else {
        root.trim_end_matches('/').to_string()
    };
    stack.push(root_norm.clone());
    dirs.push(root_norm.clone());

    while let Some(dir) = stack.pop() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("canceled".to_string());
        }
        let entries = sftp_list(
            filedock,
            filedock_dir,
            runner,
            timeout_secs,
            cancel_flag,
            conn,
            &dir,
        )
        .await?;

        for ent in entries {
            if ent.name == "." || ent.name == ".." {
                continue;
            }
            let child = join_posix(&dir, &ent.name);
            if ent.kind == "dir" {
                dirs.push(child.clone());
                stack.push(child);
            } else {
                let rel = rel_from_root(&root_norm, &child)
                    .ok_or_else(|| format!("failed to resolve relative path: {child}"))?;
                if rel.is_empty() {
                    continue;
                }
                files.push(SftpFileRef {
                    remote_path: child,
                    rel_path: rel,
                });
            }
        }
    }

    Ok(SftpTree { files, dirs })
}

async fn sftp_rm(
    filedock: &str,
    filedock_dir: Option<&PathBuf>,
    runner: &RunnerConfig,
    timeout_secs: u64,
    cancel_flag: &Arc<AtomicBool>,
    conn: &serde_json::Value,
    path: &str,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "op": "rm",
        "conn": conn,
        "args": { "path": path, "recursive": false }
    });
    let _ = run_sftp_plugin(
        filedock,
        filedock_dir,
        runner,
        timeout_secs,
        cancel_flag,
        payload,
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn copy_snapshot_file_to_sftp(
    state: State<'_, PluginRunManager>,
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
    apply_no_window(&mut cmd);
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

    if let Some(dirs) = runner
        .plugin_dirs
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dirs);
    } else if let Some(dir) = filedock_dir.as_ref() {
        cmd.env("FILEDOCK_PLUGIN_DIRS", dir.to_string_lossy().to_string());
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn filedock: {e}"))?;
    let stderr_pipe = child.stderr.take();
    let status = tokio::select! {
        res = child.wait() => res.map_err(|e| format!("wait filedock: {e}"))?,
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
    let mut stderr_buf = Vec::new();
    if let Some(mut s) = stderr_pipe {
        tokio::io::AsyncReadExt::read_to_end(&mut s, &mut stderr_buf)
            .await
            .map_err(|e| format!("read filedock stderr: {e}"))?;
    }
    let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
    let _ = tokio::fs::remove_file(&tmp).await;

    if !status.success() {
        return Err(format!("plugin failed: {} {}", status, stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn import_sftp_file_to_snapshot(
    app: AppHandle,
    state: State<'_, PluginRunManager>,
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
    let remote_raw = req.remote_path.trim();
    if remote_raw.is_empty() {
        return Err("remote_path required".to_string());
    }
    let mut remote_path = remote_raw.to_string();
    if remote_path.len() > 1 {
        remote_path = remote_path.trim_end_matches('/').to_string();
    }
    let sftp_conn = req.sftp_conn.clone();

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

    let runner = req.runner.clone().unwrap_or(RunnerConfig {
        filedock_path: None,
        plugin_dirs: None,
        timeout_secs: None,
    });
    let (filedock, filedock_dir) = resolve_filedock_path(runner.filedock_path.as_deref());
    let timeout_secs = runner.timeout_secs.unwrap_or(900).max(1);

    let stat = sftp_stat(
        &filedock,
        filedock_dir.as_ref(),
        &runner,
        timeout_secs,
        &cancel_flag,
        &sftp_conn,
        &remote_path,
    )
    .await?;
    let is_dir = stat.kind == "dir";
    let tree = if is_dir {
        emit_import(&app, &run_id, "sftp list", None, None, None);
        collect_sftp_tree(
            &filedock,
            filedock_dir.as_ref(),
            &runner,
            timeout_secs,
            &cancel_flag,
            &sftp_conn,
            &remote_path,
        )
        .await?
    } else {
        SftpTree {
            files: vec![SftpFileRef {
                remote_path: remote_path.clone(),
                rel_path: String::new(),
            }],
            dirs: Vec::new(),
        }
    };

    // Chunk+upload to the destination server.
    let client = build_http_client(
        req.token.as_deref(),
        req.device_id.as_deref(),
        req.device_token.as_deref(),
    )?;
    let base = req.server_base_url.trim_end_matches('/').to_string();

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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("time: {e}"))?
        .as_secs() as i64;

    let total_files = tree.files.len().max(1);
    let mut added = 0usize;
    let mut root_hint = dst_path.clone();

    for (idx, f) in tree.files.iter().enumerate() {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("canceled".to_string());
        }

        let desired_path = if f.rel_path.is_empty() {
            dst_path.clone()
        } else {
            join_posix(&dst_path, &f.rel_path)
        };
        let mut final_path = desired_path.clone();
        if existing.contains(&final_path) {
            match policy {
                "skip" => {
                    continue;
                }
                "rename" => final_path = unique_path(&existing, &final_path),
                _ => {}
            }
        }

        let phase_prefix = format!("{}/{}", idx + 1, total_files);
        emit_import(
            &app,
            &run_id,
            &format!("sftp download {phase_prefix}"),
            None,
            None,
            None,
        );

        let mut tmp = std::env::temp_dir();
        let suffix = rand::random::<u64>();
        tmp.push(format!("filedock_sftp_import_{run_id}_{suffix}.tmp"));
        let tmp_str = tmp.to_string_lossy().to_string();

        let payload = serde_json::json!({
            "op": "download",
            "conn": sftp_conn.clone(),
            "args": {
                "remote_path": f.remote_path.clone(),
                "local_path": tmp_str,
            }
        });
        let _ = run_sftp_plugin(
            &filedock,
            filedock_dir.as_ref(),
            &runner,
            timeout_secs,
            &cancel_flag,
            payload,
        )
        .await?;

        if cancel_flag.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err("canceled".to_string());
        }
        emit_import(
            &app,
            &run_id,
            &format!("sftp download done {phase_prefix}"),
            None,
            None,
            None,
        );

        let total_bytes = tokio::fs::metadata(&tmp)
            .await
            .map_err(|e| format!("stat temp file: {e}"))?
            .len();

        emit_import(
            &app,
            &run_id,
            &format!("hashing {phase_prefix}"),
            Some(0),
            Some(total_bytes),
            Some(0),
        );
        let chunks = chunk_file(&tmp).await?;
        emit_import(
            &app,
            &run_id,
            &format!("hashing done {phase_prefix}"),
            Some(total_bytes),
            Some(total_bytes),
            Some(100),
        );
        let hashes = chunks.iter().map(|c| c.hash.clone()).collect::<Vec<_>>();
        emit_import(
            &app,
            &run_id,
            &format!("checking chunks {phase_prefix}"),
            None,
            None,
            None,
        );
        let missing = presence_missing(&client, &base, &hashes).await?;

        if !missing.is_empty() {
            let mut ftmp = tokio::fs::File::open(&tmp)
                .await
                .map_err(|e| format!("open temp file: {e}"))?;

            let missing_total_bytes = chunks
                .iter()
                .filter(|c| missing.contains(&c.hash))
                .map(|c| c.size)
                .sum::<u64>();
            let missing_total_chunks =
                chunks.iter().filter(|c| missing.contains(&c.hash)).count() as u64;
            let mut missing_done_bytes = 0u64;
            let mut missing_done_chunks = 0u64;
            emit_import(
                &app,
                &run_id,
                &format!(
                    "uploading chunks {phase_prefix} (0/{})",
                    missing_total_chunks
                ),
                Some(0),
                Some(missing_total_bytes),
                Some(0),
            );

            for c in &chunks {
                if cancel_flag.load(Ordering::Relaxed) {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err("canceled".to_string());
                }
                let mut buf = vec![0u8; c.size as usize];
                tokio::io::AsyncReadExt::read_exact(&mut ftmp, &mut buf)
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

                    missing_done_bytes = missing_done_bytes.saturating_add(c.size);
                    missing_done_chunks = missing_done_chunks.saturating_add(1);
                    let pct = if missing_total_bytes > 0 {
                        Some(
                            ((missing_done_bytes.saturating_mul(100)) / missing_total_bytes) as u32,
                        )
                    } else {
                        Some(100)
                    };
                    emit_import(
                        &app,
                        &run_id,
                        &format!(
                            "uploading chunks {phase_prefix} ({}/{})",
                            missing_done_chunks, missing_total_chunks
                        ),
                        Some(missing_done_bytes),
                        Some(missing_total_bytes),
                        pct,
                    );
                }
            }
        }

        file_map.insert(
            final_path.clone(),
            ManifestFileEntry {
                path: final_path.clone(),
                size: total_bytes,
                mtime_unix: now,
                chunk_hash: None,
                chunks: Some(chunks),
            },
        );
        existing.insert(final_path.clone());
        added += 1;
        if !is_dir {
            root_hint = final_path;
        }

        let _ = tokio::fs::remove_file(&tmp).await;
    }

    if added == 0 && !tree.files.is_empty() {
        return Ok(());
    }

    // Create destination snapshot and write manifest.
    emit_import(&app, &run_id, "finalizing snapshot", None, None, None);
    let create_url = format!("{}/v1/snapshots", base);
    let root_path = req
        .dst_root_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("(sftp import: {})", root_hint));
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let create_req = SnapshotCreateRequest {
        device_name: req.dst_device_name.trim().to_string(),
        device_id: req
            .dst_device_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        root_path,
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

    if req.delete_remote {
        emit_import(&app, &run_id, "deleting remote", None, None, None);
        if is_dir {
            for f in &tree.files {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("canceled".to_string());
                }
                sftp_rm(
                    &filedock,
                    filedock_dir.as_ref(),
                    &runner,
                    timeout_secs,
                    &cancel_flag,
                    &sftp_conn,
                    &f.remote_path,
                )
                .await?;
            }
            let mut dirs = tree.dirs.clone();
            dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
            for d in dirs {
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err("canceled".to_string());
                }
                sftp_rm(
                    &filedock,
                    filedock_dir.as_ref(),
                    &runner,
                    timeout_secs,
                    &cancel_flag,
                    &sftp_conn,
                    &d,
                )
                .await?;
            }
        } else {
            sftp_rm(
                &filedock,
                filedock_dir.as_ref(),
                &runner,
                timeout_secs,
                &cancel_flag,
                &sftp_conn,
                &remote_path,
            )
            .await?;
        }
    }

    emit_import(&app, &run_id, "done", None, None, Some(100));
    Ok(())
}

fn trim_option(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

async fn run_filedock_json<T: DeserializeOwned>(args: Vec<String>) -> Result<T, String> {
    let (filedock, _) = resolve_filedock_path(None);
    let mut cmd = tokio::process::Command::new(filedock);
    apply_no_window(&mut cmd);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("run filedock: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        return Err(format!(
            "filedock command failed: {}{}{}",
            output.status,
            if detail.is_empty() { "" } else { " - " },
            detail
        ));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("decode filedock JSON: {e}; stdout={}", stdout.trim()))
}

#[tauri::command]
async fn agent_init(req: AgentInitRequest) -> Result<AgentInitSummary, String> {
    let profile = req.profile.trim();
    if profile.is_empty() {
        return Err("profile required".to_string());
    }
    let folder = req.folder.trim();
    if folder.is_empty() {
        return Err("folder required".to_string());
    }
    let server = req.server_base_url.trim();
    if server.is_empty() {
        return Err("server_base_url required".to_string());
    }

    let device_id = trim_option(req.device_id.as_deref());
    let device_token = trim_option(req.device_token.as_deref());
    if device_id.is_some() ^ device_token.is_some() {
        return Err("device_id and device_token must be provided together".to_string());
    }

    let mut args = vec![
        "agent".to_string(),
        "init".to_string(),
        "--profile".to_string(),
        profile.to_string(),
        "--folder".to_string(),
        folder.to_string(),
        "--server".to_string(),
        server.to_string(),
        "--interval-secs".to_string(),
        req.interval_secs.unwrap_or(900).max(1).to_string(),
        "--heartbeat-secs".to_string(),
        req.heartbeat_secs.unwrap_or(300).to_string(),
    ];

    if let Some(device_name) = trim_option(req.device_name.as_deref()) {
        args.push("--device-name".to_string());
        args.push(device_name.to_string());
    }
    if let Some(token) = trim_option(req.token.as_deref()) {
        args.push("--token".to_string());
        args.push(token.to_string());
    }
    if let Some(id) = device_id {
        args.push("--device-id".to_string());
        args.push(id.to_string());
    }
    if let Some(token) = device_token {
        args.push("--device-token".to_string());
        args.push(token.to_string());
    }
    if req.keep_bootstrap_token {
        args.push("--keep-bootstrap-token".to_string());
    }
    if req.no_default_excludes {
        args.push("--no-default-excludes".to_string());
    }
    if req.respect_gitignore {
        args.push("--respect-gitignore".to_string());
    }

    run_filedock_json(args).await
}

#[tauri::command]
async fn agent_install(req: AgentInstallRequest) -> Result<AgentInstallSummary, String> {
    let profile = req.profile.trim();
    if profile.is_empty() {
        return Err("profile required".to_string());
    }

    let mut args = vec![
        "agent".to_string(),
        "install".to_string(),
        "--profile".to_string(),
        profile.to_string(),
    ];
    if req.dry_run {
        args.push("--dry-run".to_string());
    }
    if matches!(req.mode, Some(AgentInstallMode::Scheduled)) {
        // Only pass `--mode scheduled` so older CLI builds keep working in default (daemon) mode.
        args.push("--mode".to_string());
        args.push("scheduled".to_string());
    }

    run_filedock_json(args).await
}

#[tauri::command]
async fn agent_status(profile: String) -> Result<AgentStatusSummary, String> {
    let profile = profile.trim();
    if profile.is_empty() {
        return Err("profile required".to_string());
    }

    run_filedock_json(vec![
        "agent".to_string(),
        "status".to_string(),
        "--profile".to_string(),
        profile.to_string(),
    ])
    .await
}

#[tauri::command]
async fn agent_uninstall(req: AgentUninstallRequest) -> Result<AgentUninstallSummary, String> {
    let profile = req.profile.trim();
    if profile.is_empty() {
        return Err("profile required".to_string());
    }

    let mut args = vec![
        "agent".to_string(),
        "uninstall".to_string(),
        "--profile".to_string(),
        profile.to_string(),
    ];
    if req.delete_config {
        args.push("--delete-config".to_string());
    }

    run_filedock_json(args).await
}

#[tauri::command]
async fn push_folder_snapshot(
    req: PushFolderSnapshotRequest,
) -> Result<PushFolderSnapshotResponse, String> {
    let server = req.server_base_url.trim();
    if server.is_empty() {
        return Err("server_base_url required".to_string());
    }
    let device = req.device_name.trim();
    if device.is_empty() {
        return Err("device_name required".to_string());
    }
    let folder = req.folder.trim();
    if folder.is_empty() {
        return Err("folder required".to_string());
    }

    let path = PathBuf::from(folder);
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("metadata: {e}"))?;
    if meta.is_file() {
        return push_file_snapshot(&req, &path).await;
    }
    if !meta.is_dir() {
        return Err("path must be a file or directory".to_string());
    }

    let (filedock, _) = resolve_filedock_path(None);
    let mut cmd = tokio::process::Command::new(filedock);
    apply_no_window(&mut cmd);
    cmd.arg("push-folder")
        .arg("--server")
        .arg(server)
        .arg("--device")
        .arg(device)
        .arg("--folder")
        .arg(folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(note) = req.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        cmd.arg("--note").arg(note);
    }
    if let Some(c) = req.concurrency.filter(|c| *c > 0) {
        cmd.arg("--concurrency").arg(c.to_string());
    }

    if let Some(tok) = req
        .token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("FILEDOCK_TOKEN", tok);
    }
    if let Some(id) = req
        .device_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("FILEDOCK_DEVICE_ID", id);
    }
    if let Some(tok) = req
        .device_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cmd.env("FILEDOCK_DEVICE_TOKEN", tok);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("run filedock: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!(
            "push-folder failed: {} {}",
            output.status,
            stderr.trim()
        ));
    }

    let snapshot_id = stdout
        .lines()
        .find_map(|l| l.strip_prefix("snapshot: ").map(|s| s.trim().to_string()));

    Ok(PushFolderSnapshotResponse {
        snapshot_id,
        stdout,
        stderr,
    })
}

fn resolve_filedock_path(explicit: Option<&str>) -> (String, Option<PathBuf>) {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        return (p.to_string(), pb.parent().map(Path::to_path_buf));
    }

    // For packaged apps, prefer a sidecar binary next to the main executable.
    // Fall back to "filedock" on PATH.
    let exe = tauri::process::current_binary(&tauri::Env::default()).ok();
    let exe_dir = exe
        .as_deref()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf);
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
                return (
                    c.to_string_lossy().to_string(),
                    c.parent().map(Path::to_path_buf),
                );
            }
        }
    }

    ("filedock".to_string(), None)
}

fn resolve_sidecar_path(name: &str) -> String {
    let exe = tauri::process::current_binary(&tauri::Env::default()).ok();
    let exe_dir = exe
        .as_deref()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf);
    if let Some(dir) = exe_dir {
        let mut candidates = vec![dir.join(name)];
        if cfg!(windows) {
            candidates.push(dir.join(format!("{name}.exe")));
        }
        if let Ok(rd) = std::fs::read_dir(&dir) {
            let prefix = format!("{name}-");
            for e in rd.flatten() {
                let p = e.path();
                let file_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if file_name.starts_with(&prefix) {
                    candidates.push(p);
                }
            }
        }

        for c in candidates {
            if c.is_file() {
                return c.to_string_lossy().to_string();
            }
        }
    }

    name.to_string()
}

#[tauri::command]
async fn run_filedock_plugin(
    state: State<'_, PluginRunManager>,
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
    apply_no_window(&mut cmd);
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
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let status = tokio::select! {
        res = child.wait() => res.map_err(|e| format!("wait filedock: {e}"))?,
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
    let mut stdout_buf = Vec::new();
    if let Some(mut s) = stdout_pipe {
        tokio::io::AsyncReadExt::read_to_end(&mut s, &mut stdout_buf)
            .await
            .map_err(|e| format!("read filedock stdout: {e}"))?;
    }
    let mut stderr_buf = Vec::new();
    if let Some(mut s) = stderr_pipe {
        tokio::io::AsyncReadExt::read_to_end(&mut s, &mut stderr_buf)
            .await
            .map_err(|e| format!("read filedock stderr: {e}"))?;
    }

    let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
    let stderr = String::from_utf8_lossy(&stderr_buf).to_string();
    if !status.success() {
        return Err(format!("plugin failed: {} {}", status, stderr.trim()));
    }

    Ok(RunFiledockPluginResponse { stdout, stderr })
}

#[cfg(test)]
mod tests {
    use super::summarize_http_body;

    #[test]
    fn summarize_http_body_compacts_whitespace() {
        assert_eq!(summarize_http_body("  hello\n\tworld  "), "hello world");
    }

    #[test]
    fn summarize_http_body_truncates_long_messages() {
        let input = "x".repeat(300);
        let output = summarize_http_body(&input);
        assert_eq!(output.chars().count(), 241);
        assert!(output.ends_with('…'));
    }
}
