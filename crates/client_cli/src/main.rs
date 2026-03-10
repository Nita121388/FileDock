use clap::{Parser, Subcommand, ValueEnum};
use filedock_protocol::{
    is_valid_chunk_hash, is_valid_rel_path, ChunkGcRequest, ChunkGcResponse, ChunkPresenceRequest,
    ChunkPresenceResponse, ChunkRef, DeviceHeartbeatRequest, DeviceHeartbeatResponse, DeviceInfo,
    DeviceRegisterRequest, DeviceRegisterResponse, HealthResponse, ManifestFileEntry,
    ServerConfigExport, SnapshotCreateRequest, SnapshotCreateResponse, SnapshotDeleteResponse,
    SnapshotManifest, SnapshotMeta, SnapshotPruneRequest, SnapshotPruneResponse, TreeResponse,
};
use futures_util::stream::{self, StreamExt};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::{
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use walkdir::WalkDir;

const PRESENCE_BATCH: usize = 1000;
const DEFAULT_CONCURRENCY: usize = 4;
const TOKEN_HEADER: &str = "x-filedock-token";
const DEVICE_ID_HEADER: &str = "x-filedock-device-id";
const DEVICE_TOKEN_HEADER: &str = "x-filedock-device-token";

#[derive(Debug, Clone, Default)]
struct AuthConfig {
    token: Option<String>,
    device_id: Option<String>,
    device_token: Option<String>,
}

fn trim_nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn current_auth_from_env() -> AuthConfig {
    AuthConfig {
        token: trim_nonempty(std::env::var("FILEDOCK_TOKEN").ok()),
        device_id: trim_nonempty(std::env::var("FILEDOCK_DEVICE_ID").ok()),
        device_token: trim_nonempty(std::env::var("FILEDOCK_DEVICE_TOKEN").ok()),
    }
}

fn build_client_with_auth(auth: &AuthConfig) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();

    if let Some(token) = auth.token.as_deref() {
        let name = reqwest::header::HeaderName::from_static(TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(token)
            .map_err(|e| format!("invalid FILEDOCK_TOKEN: {e}"))?;
        headers.insert(name, value);
    }

    if let Some(device_id) = auth.device_id.as_deref() {
        let name = reqwest::header::HeaderName::from_static(DEVICE_ID_HEADER);
        let value = reqwest::header::HeaderValue::from_str(device_id)
            .map_err(|e| format!("invalid FILEDOCK_DEVICE_ID: {e}"))?;
        headers.insert(name, value);
    }

    if let Some(device_token) = auth.device_token.as_deref() {
        let name = reqwest::header::HeaderName::from_static(DEVICE_TOKEN_HEADER);
        let value = reqwest::header::HeaderValue::from_str(device_token)
            .map_err(|e| format!("invalid FILEDOCK_DEVICE_TOKEN: {e}"))?;
        headers.insert(name, value);
    }

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

fn build_client() -> Result<reqwest::Client, String> {
    build_client_with_auth(&current_auth_from_env())
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

async fn fetch_devices(client: &reqwest::Client, server: &str) -> Result<Vec<DeviceInfo>, String> {
    let url = format!("{}/v1/devices", server.trim_end_matches('/'));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("devices request: {e}"))?;
    let resp = ensure_success_response(resp, "devices response").await?;
    resp.json()
        .await
        .map_err(|e| format!("devices decode: {e}"))
}

async fn fetch_snapshots(
    client: &reqwest::Client,
    server: &str,
) -> Result<Vec<SnapshotMeta>, String> {
    let url = format!("{}/v1/snapshots", server.trim_end_matches('/'));
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("snapshots request: {e}"))?;
    let resp = ensure_success_response(resp, "snapshots response").await?;
    resp.json()
        .await
        .map_err(|e| format!("snapshots decode: {e}"))
}

async fn register_device_impl(
    client: &reqwest::Client,
    server: &str,
    device_name: &str,
    os: &str,
) -> Result<DeviceRegisterResponse, String> {
    let url = format!("{}/v1/auth/device/register", server.trim_end_matches('/'));
    let req = DeviceRegisterRequest {
        device_name: device_name.to_string(),
        os: os.to_string(),
    };
    let resp = client
        .post(url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("device register request: {e}"))?;
    let resp = ensure_success_response(resp, "device register response").await?;
    resp.json()
        .await
        .map_err(|e| format!("device register decode: {e}"))
}

async fn read_inline_or_file(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty input".to_string());
    }
    if trimmed.starts_with('{') {
        return Ok(trimmed.to_string());
    }

    let path = PathBuf::from(trimmed);
    if path.exists() {
        return tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("read {}: {e}", path.display()));
    }

    Ok(trimmed.to_string())
}

async fn load_server_config_input(raw: &str) -> Result<ServerConfigExport, String> {
    let text = read_inline_or_file(raw).await?;
    serde_json::from_str(&text).map_err(|e| format!("parse server config JSON: {e}"))
}

fn validate_profile_name(profile: &str) -> Result<(), String> {
    if profile.is_empty() {
        return Err("profile required".to_string());
    }
    if profile
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Ok(());
    }
    Err("profile may only contain ASCII letters, digits, '-', '_' and '.'".to_string())
}

fn current_platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn default_device_name() -> Option<String> {
    trim_nonempty(std::env::var("FILEDOCK_DEVICE_NAME").ok())
        .or_else(|| trim_nonempty(std::env::var("HOSTNAME").ok()))
        .or_else(|| trim_nonempty(std::env::var("COMPUTERNAME").ok()))
}

fn home_dir_from_env(home: Option<String>, userprofile: Option<String>) -> Option<PathBuf> {
    trim_nonempty(home)
        .map(PathBuf::from)
        .or_else(|| trim_nonempty(userprofile).map(PathBuf::from))
}

fn default_config_root_from_env(
    os: &str,
    home: Option<String>,
    xdg_config_home: Option<String>,
    appdata: Option<String>,
    userprofile: Option<String>,
) -> Result<PathBuf, String> {
    match os {
        "windows" => trim_nonempty(appdata)
            .map(PathBuf::from)
            .or_else(|| home_dir_from_env(home, userprofile).map(|p| p.join("AppData/Roaming")))
            .map(|p| p.join("FileDock"))
            .ok_or_else(|| {
                "APPDATA or USERPROFILE required to resolve FileDock config dir".to_string()
            }),
        "macos" => home_dir_from_env(home, userprofile)
            .map(|p| p.join("Library/Application Support/FileDock"))
            .ok_or_else(|| "HOME required to resolve FileDock config dir".to_string()),
        _ => Ok(trim_nonempty(xdg_config_home)
            .map(PathBuf::from)
            .or_else(|| home_dir_from_env(home, userprofile).map(|p| p.join(".config")))
            .ok_or_else(|| {
                "XDG_CONFIG_HOME or HOME required to resolve FileDock config dir".to_string()
            })?
            .join("filedock")),
    }
}

fn default_state_root_from_env(
    os: &str,
    home: Option<String>,
    xdg_state_home: Option<String>,
    localappdata: Option<String>,
    userprofile: Option<String>,
) -> Result<PathBuf, String> {
    match os {
        "windows" => trim_nonempty(localappdata)
            .map(PathBuf::from)
            .or_else(|| home_dir_from_env(home, userprofile).map(|p| p.join("AppData/Local")))
            .map(|p| p.join("FileDock"))
            .ok_or_else(|| {
                "LOCALAPPDATA or USERPROFILE required to resolve FileDock state dir".to_string()
            }),
        "macos" => home_dir_from_env(home, userprofile)
            .map(|p| p.join("Library/Application Support/FileDock"))
            .ok_or_else(|| "HOME required to resolve FileDock state dir".to_string()),
        _ => Ok(trim_nonempty(xdg_state_home)
            .map(PathBuf::from)
            .or_else(|| home_dir_from_env(home, userprofile).map(|p| p.join(".local/state")))
            .ok_or_else(|| {
                "XDG_STATE_HOME or HOME required to resolve FileDock state dir".to_string()
            })?
            .join("filedock")),
    }
}

fn default_config_root() -> Result<PathBuf, String> {
    default_config_root_from_env(
        current_platform_name(),
        std::env::var("HOME").ok(),
        std::env::var("XDG_CONFIG_HOME").ok(),
        std::env::var("APPDATA").ok(),
        std::env::var("USERPROFILE").ok(),
    )
}

fn default_state_root() -> Result<PathBuf, String> {
    default_state_root_from_env(
        current_platform_name(),
        std::env::var("HOME").ok(),
        std::env::var("XDG_STATE_HOME").ok(),
        std::env::var("LOCALAPPDATA").ok(),
        std::env::var("USERPROFILE").ok(),
    )
}

fn agent_profiles_dir() -> Result<PathBuf, String> {
    Ok(default_config_root()?.join("agents"))
}

fn agent_profile_path(profile: &str) -> Result<PathBuf, String> {
    validate_profile_name(profile)?;
    Ok(agent_profiles_dir()?.join(format!("{profile}.toml")))
}

fn agent_state_path(profile: &str) -> Result<PathBuf, String> {
    validate_profile_name(profile)?;
    Ok(default_state_root()?
        .join("agents")
        .join(format!("{profile}.json")))
}

fn systemd_unit_name(profile: &str) -> String {
    format!("filedock-agent-{profile}.service")
}

fn systemd_timer_name(profile: &str) -> String {
    format!("filedock-agent-{profile}.timer")
}

fn launchd_label(profile: &str) -> String {
    format!("com.filedock.agent.{profile}")
}

fn windows_task_name(profile: &str) -> String {
    format!("FileDock Agent {profile}")
}

fn linux_systemd_user_unit_path(profile: &str) -> Result<PathBuf, String> {
    let base = trim_nonempty(std::env::var("XDG_CONFIG_HOME").ok())
        .map(PathBuf::from)
        .or_else(|| {
            home_dir_from_env(
                std::env::var("HOME").ok(),
                std::env::var("USERPROFILE").ok(),
            )
            .map(|p| p.join(".config"))
        })
        .ok_or_else(|| {
            "XDG_CONFIG_HOME or HOME required to resolve systemd user dir".to_string()
        })?;
    Ok(base.join("systemd/user").join(systemd_unit_name(profile)))
}

fn linux_systemd_user_timer_path(profile: &str) -> Result<PathBuf, String> {
    let base = trim_nonempty(std::env::var("XDG_CONFIG_HOME").ok())
        .map(PathBuf::from)
        .or_else(|| {
            home_dir_from_env(
                std::env::var("HOME").ok(),
                std::env::var("USERPROFILE").ok(),
            )
            .map(|p| p.join(".config"))
        })
        .ok_or_else(|| {
            "XDG_CONFIG_HOME or HOME required to resolve systemd user dir".to_string()
        })?;
    Ok(base.join("systemd/user").join(systemd_timer_name(profile)))
}

fn macos_launch_agent_path(profile: &str) -> Result<PathBuf, String> {
    let home = home_dir_from_env(
        std::env::var("HOME").ok(),
        std::env::var("USERPROFILE").ok(),
    )
    .ok_or_else(|| "HOME required to resolve LaunchAgents dir".to_string())?;
    Ok(home
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", launchd_label(profile))))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn render_systemd_user_unit(profile: &str, exe: &Path, config: &Path) -> String {
    format!(
        "[Unit]
Description=FileDock agent ({profile})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart={} agent --config {}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
",
        exe.display(),
        config.display(),
    )
}

fn render_systemd_user_oneshot_unit(profile: &str, exe: &Path, config: &Path) -> String {
    format!(
        "[Unit]
Description=FileDock agent run-once ({profile})
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart={} agent run-once --config {}
",
        exe.display(),
        config.display(),
    )
}

fn render_systemd_user_timer(profile: &str, interval_secs: u64) -> String {
    format!(
        "[Unit]
Description=FileDock agent timer ({profile})

[Timer]
OnBootSec=2m
OnUnitActiveSec={interval_secs}s
Persistent=true

[Install]
WantedBy=timers.target
"
    )
}

fn render_launchd_plist(profile: &str, exe: &Path, config: &Path) -> String {
    let label = xml_escape(&launchd_label(profile));
    let exe = xml_escape(&exe.display().to_string());
    let config = xml_escape(&config.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>{exe}</string>
      <string>agent</string>
      <string>--config</string>
      <string>{config}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
"#
    )
}

fn render_launchd_plist_scheduled(
    profile: &str,
    exe: &Path,
    config: &Path,
    interval_secs: u64,
) -> String {
    let label = xml_escape(&launchd_label(profile));
    let exe = xml_escape(&exe.display().to_string());
    let config = xml_escape(&config.display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>{exe}</string>
      <string>agent</string>
      <string>run-once</string>
      <string>--config</string>
      <string>{config}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>{interval_secs}</integer>
  </dict>
</plist>
"#
    )
}

#[derive(Debug, Serialize)]
struct ProcessProbe {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn run_process(program: &str, args: &[&str]) -> Result<ProcessProbe, String> {
    let output = ProcessCommand::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("run {program}: {e}"))?;
    Ok(ProcessProbe {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
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

        /// If set, also respect `.gitignore` (gitignore-style) patterns in the folder root.
        #[arg(long)]
        respect_gitignore: bool,
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

        /// If set, also respect `.gitignore` (gitignore-style) patterns in the folder root.
        #[arg(long)]
        respect_gitignore: bool,

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

        /// Keep the newest snapshot from each of the newest N UTC calendar days.
        #[arg(long)]
        keep_daily: Option<u32>,

        /// Keep the newest snapshot from each of the newest N ISO weeks in UTC.
        #[arg(long)]
        keep_weekly: Option<u32>,

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

    /// Device lifecycle helpers.
    Device {
        #[command(subcommand)]
        command: DeviceCommand,
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

    /// Run or manage the FileDock agent.
    Agent {
        /// Config file path.
        #[arg(long)]
        config: Option<PathBuf>,

        #[command(subcommand)]
        command: Option<AgentCommand>,
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

        /// Exclude glob patterns (matched against relative POSIX paths).
        /// Example: --exclude \"**/node_modules/**\" --exclude \"**/.git/**\"
        #[arg(long)]
        exclude: Vec<String>,

        /// Optional ignore file (one glob per line). If omitted, `.filedockignore` in the folder root is used if present.
        #[arg(long)]
        ignore_file: Option<PathBuf>,

        /// If set, also respect `.gitignore` (gitignore-style) patterns in the folder root.
        #[arg(long)]
        respect_gitignore: bool,

        /// If set, include ignored paths in the JSON output.
        #[arg(long)]
        include_ignored: bool,

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
enum DeviceCommand {
    /// Register a device and return device credentials.
    Register {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Device name to register.
        #[arg(long)]
        device_name: String,

        /// Override the device OS sent to the server.
        #[arg(long)]
        os: Option<String>,

        /// Optional bootstrap server token. If omitted, uses FILEDOCK_TOKEN.
        #[arg(long)]
        token: Option<String>,
    },

    /// Send a device heartbeat.
    Heartbeat {
        /// Server base URL, e.g. http://127.0.0.1:8787
        #[arg(long)]
        server: String,

        /// Device id (if omitted, uses FILEDOCK_DEVICE_ID).
        #[arg(long)]
        device_id: Option<String>,

        /// Optional device token override.
        #[arg(long)]
        device_token: Option<String>,

        /// Optional status string.
        #[arg(long)]
        status: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum AgentInstallMode {
    /// Keep a long-running agent process alive (schedule is owned by `interval_secs` in the profile).
    Daemon,
    /// Use OS-native schedulers to periodically run `filedock agent run-once ...` and exit.
    Scheduled,
}

#[derive(Subcommand, Debug)]
enum AgentCommand {
    /// Run a simple device agent from a config file.
    Run {
        /// Config file path.
        #[arg(long)]
        config: PathBuf,
    },

    /// Run exactly one snapshot from a config file and exit.
    RunOnce {
        /// Config file path.
        #[arg(long)]
        config: PathBuf,
    },

    /// Create or update a named agent profile.
    Init {
        /// Profile name.
        #[arg(long)]
        profile: String,

        /// Root folder to back up.
        #[arg(long)]
        folder: PathBuf,

        /// Server base URL, e.g. http://127.0.0.1:8787.
        #[arg(long)]
        server: Option<String>,

        /// Optional device name; defaults to FILEDOCK_DEVICE_NAME / HOSTNAME / COMPUTERNAME / profile.
        #[arg(long)]
        device_name: Option<String>,

        /// Optional note stored in snapshot metadata.
        #[arg(long)]
        note: Option<String>,

        /// Snapshot interval (seconds).
        #[arg(long, default_value_t = 900)]
        interval_secs: u64,

        /// Upload concurrency (files in parallel).
        #[arg(long, default_value_t = DEFAULT_CONCURRENCY)]
        concurrency: usize,

        /// Exclude glob patterns (matched against relative POSIX paths).
        #[arg(long)]
        exclude: Vec<String>,

        /// Optional ignore file (one glob per line).
        #[arg(long)]
        ignore_file: Option<PathBuf>,

        /// If set, also respect `.gitignore` (gitignore-style) patterns in the folder root.
        #[arg(long)]
        respect_gitignore: bool,

        /// If set, do not seed the default exclude list (e.g. `.git`, `node_modules`) when no ignore rules are provided.
        #[arg(long)]
        no_default_excludes: bool,

        /// Heartbeat interval (seconds, 0 disables).
        #[arg(long, default_value_t = 300)]
        heartbeat_secs: u64,

        /// Optional free-form heartbeat status string.
        #[arg(long)]
        heartbeat_status: Option<String>,

        /// Optional imported server config JSON or a path to a JSON file.
        #[arg(long)]
        import_json: Option<String>,

        /// Optional bootstrap server token override.
        #[arg(long)]
        token: Option<String>,

        /// Optional device id override.
        #[arg(long)]
        device_id: Option<String>,

        /// Optional device token override.
        #[arg(long)]
        device_token: Option<String>,

        /// Override the device OS used during auto-registration.
        #[arg(long)]
        os: Option<String>,

        /// Skip automatic device registration.
        #[arg(long)]
        no_register: bool,

        /// Keep the bootstrap server token in the saved profile.
        #[arg(long)]
        keep_bootstrap_token: bool,
    },

    /// Install and start the current platform service for a profile.
    Install {
        /// Profile name.
        #[arg(long)]
        profile: String,

        /// Render the service definition without writing or starting it.
        #[arg(long)]
        dry_run: bool,

        /// Installation mode (`daemon` keeps a long-running process alive; `scheduled` uses OS timers).
        #[arg(long, value_enum, default_value_t = AgentInstallMode::Daemon)]
        mode: AgentInstallMode,
    },

    /// Show local/service/server status for a profile.
    Status {
        /// Profile name.
        #[arg(long)]
        profile: String,
    },

    /// Uninstall the current platform service for a profile.
    Uninstall {
        /// Profile name.
        #[arg(long)]
        profile: String,

        /// Also remove the saved profile TOML.
        #[arg(long)]
        delete_config: bool,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
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

    /// If true, also respect `.gitignore` (gitignore-style) patterns in the folder root.
    #[serde(default)]
    respect_gitignore: bool,

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

fn default_agent_excludes() -> Vec<String> {
    // Keep this small and unsurprising; users can always edit the generated TOML later.
    vec!["**/.git/**".to_string(), "**/node_modules/**".to_string()]
}

fn apply_default_excludes_if_needed(
    exclude: &mut Vec<String>,
    ignore_file: &Option<PathBuf>,
    no_default_excludes: bool,
) -> bool {
    if no_default_excludes {
        return false;
    }
    if !exclude.is_empty() || ignore_file.is_some() {
        return false;
    }

    *exclude = default_agent_excludes();
    true
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

fn auth_from_agent_config(cfg: &AgentConfig) -> AuthConfig {
    AuthConfig {
        token: trim_nonempty(cfg.token.clone()),
        device_id: trim_nonempty(cfg.device_id.clone()),
        device_token: trim_nonempty(cfg.device_token.clone()),
    }
}

fn auth_mode_label(auth: &AuthConfig) -> &'static str {
    if auth.device_id.is_some() && auth.device_token.is_some() {
        "device"
    } else if auth.token.is_some() {
        "server_token"
    } else {
        "open"
    }
}

async fn send_heartbeat_with_auth(
    auth: &AuthConfig,
    server: &str,
    device_id: Option<String>,
    status: Option<String>,
) -> Result<DeviceHeartbeatResponse, String> {
    let client = build_client_with_auth(auth)?;
    let dev_id = trim_nonempty(device_id).or_else(|| auth.device_id.clone());
    let dev_id =
        dev_id.ok_or_else(|| "device_id required (or set FILEDOCK_DEVICE_ID)".to_string())?;
    let url = format!(
        "{}/v1/devices/{}/heartbeat",
        server.trim_end_matches('/'),
        dev_id
    );
    let req = DeviceHeartbeatRequest {
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        status,
    };
    let resp = client
        .post(url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("heartbeat request: {e}"))?;
    let resp = ensure_success_response(resp, "heartbeat response").await?;
    resp.json()
        .await
        .map_err(|e| format!("heartbeat decode: {e}"))
}

async fn send_heartbeat_impl(server: &str, status: Option<String>) -> Result<(), String> {
    send_heartbeat_with_auth(&current_auth_from_env(), server, None, status)
        .await
        .map(|_| ())
}

async fn load_agent_config(config: &Path) -> Result<AgentConfig, String> {
    let raw = tokio::fs::read_to_string(config)
        .await
        .map_err(|e| format!("read config {}: {e}", config.display()))?;
    toml::from_str(&raw).map_err(|e| format!("parse config {}: {e}", config.display()))
}

async fn run_agent_once_from_config_path(config: &Path) -> Result<(), String> {
    let cfg = load_agent_config(config).await?;

    apply_agent_env(&cfg);

    eprintln!(
        "agent(run-once): server={} device_name={} folder={} concurrency={} heartbeat={}s",
        cfg.server,
        cfg.device_name,
        cfg.folder.display(),
        cfg.concurrency,
        cfg.heartbeat_secs
    );

    let heartbeat_enabled = cfg.heartbeat_secs > 0;

    if heartbeat_enabled {
        let st = cfg
            .heartbeat_status
            .clone()
            .or_else(|| Some("online".to_string()));
        if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
            eprintln!("heartbeat: {e}");
        }
    }

    let snap = push_folder_impl(
        cfg.server.clone(),
        cfg.device_name.clone(),
        cfg.folder.clone(),
        cfg.note.clone(),
        cfg.concurrency,
        cfg.exclude.clone(),
        cfg.ignore_file.clone(),
        cfg.respect_gitignore,
    )
    .await?;

    eprintln!("agent(run-once): completed snapshot: {snap}");

    if heartbeat_enabled {
        let st = cfg
            .heartbeat_status
            .clone()
            .map(|s| format!("{s} (snapshot {snap})"));
        let st = st.or_else(|| Some(format!("snapshot {snap}")));
        if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
            eprintln!("heartbeat: {e}");
        }
    }

    Ok(())
}

async fn run_agent_from_config_path(config: &Path) -> Result<(), String> {
    let cfg = load_agent_config(config).await?;

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

    if heartbeat_enabled {
        let st = cfg
            .heartbeat_status
            .clone()
            .or_else(|| Some("online".to_string()));
        if let Err(e) = send_heartbeat_impl(&cfg.server, st).await {
            eprintln!("heartbeat: {e}");
        }
    }

    if cfg.interval_secs == 0 {
        let snap = push_folder_impl(
            cfg.server.clone(),
            cfg.device_name.clone(),
            cfg.folder.clone(),
            cfg.note.clone(),
            cfg.concurrency,
            cfg.exclude.clone(),
            cfg.ignore_file.clone(),
            cfg.respect_gitignore,
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
                        cfg.respect_gitignore,
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
    respect_gitignore: bool,
) -> Result<String, String> {
    let client = build_client()?;

    let root = folder
        .canonicalize()
        .map_err(|e| format!("canonicalize folder: {e}"))?;

    let mut exclude_patterns = Vec::<String>::new();
    exclude_patterns.extend(load_ignore_patterns(&root, ignore_file)?);
    exclude_patterns.extend(exclude);
    let exclude_set = build_excludes(&exclude_patterns)?;
    let gitignore = load_root_gitignore(&root, respect_gitignore)?;

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

    let mut it = WalkDir::new(&root).follow_links(false).into_iter();
    while let Some(entry) = it.next() {
        let entry = entry.map_err(|e| format!("walkdir: {e}"))?;
        let ft = entry.file_type();

        let abs_path = entry.path().to_path_buf();
        let rel = abs_path
            .strip_prefix(&root)
            .map_err(|e| format!("strip prefix: {e}"))?;
        let rel_str = rel
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");

        if rel_str.is_empty() {
            continue;
        }

        if ft.is_dir() {
            // Prune ignored directories so we don't spend time walking huge trees that won't be
            // uploaded anyway (node_modules/.git/etc).
            if is_ignored_path(&exclude_set, gitignore.as_ref(), rel, &rel_str, true) {
                it.skip_current_dir();
            }
            continue;
        }

        if !ft.is_file() {
            continue;
        }

        if is_ignored_path(&exclude_set, gitignore.as_ref(), rel, &rel_str, false) {
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
    let put_resp = client
        .put(put_url)
        .json(&manifest)
        .send()
        .await
        .map_err(|e| format!("put manifest request: {e}"))?;
    ensure_success_response(put_resp, "put manifest response").await?;

    println!("manifest uploaded: {snapshot_id}");

    Ok(snapshot_id)
}

#[derive(Debug, Serialize)]
struct AgentInitSummary {
    profile: String,
    config_path: String,
    state_path: String,
    server: String,
    device_name: String,
    folder: String,
    exclude: Vec<String>,
    ignore_file: Option<String>,
    respect_gitignore: bool,
    default_excludes_applied: bool,
    auth_mode: String,
    device_registered: bool,
    device_id: Option<String>,
    kept_bootstrap_token: bool,
}

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
struct AgentServiceStatus {
    manager: String,
    name: String,
    path: Option<String>,
    installed: bool,
    enabled: Option<bool>,
    running: Option<bool>,
    note: Option<String>,
}

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
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

#[derive(Debug, Serialize)]
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

fn describe_probe_error(label: &str, probe: &ProcessProbe) -> String {
    let detail = if !probe.stderr.is_empty() {
        probe.stderr.clone()
    } else if !probe.stdout.is_empty() {
        probe.stdout.clone()
    } else {
        "command failed".to_string()
    };
    format!("{label}: {detail}")
}

async fn install_agent_service(
    profile: &str,
    dry_run: bool,
    mode: AgentInstallMode,
) -> Result<AgentInstallSummary, String> {
    validate_profile_name(profile)?;
    let config_path = agent_profile_path(profile)?;
    if !config_path.exists() {
        return Err(format!("missing agent profile: {}", config_path.display()));
    }

    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let scheduled_interval_secs = if matches!(mode, AgentInstallMode::Scheduled) {
        let cfg = load_agent_config(&config_path).await?;
        if cfg.interval_secs == 0 {
            return Err(
                "scheduled mode requires interval_secs > 0 in the saved profile".to_string(),
            );
        }
        Some(cfg.interval_secs)
    } else {
        None
    };
    let platform = current_platform_name();
    match platform {
        "macos" => {
            let plist_path = macos_launch_agent_path(profile)?;
            let mut note_parts: Vec<String> = Vec::new();
            let content = match mode {
                AgentInstallMode::Daemon => render_launchd_plist(profile, &exe, &config_path),
                AgentInstallMode::Scheduled => {
                    let interval_secs = scheduled_interval_secs.ok_or_else(|| {
                        "internal error: missing scheduled interval for scheduled install"
                            .to_string()
                    })?;
                    note_parts.push(format!(
                        "Scheduled mode: launchd runs `agent run-once` every {interval_secs}s."
                    ));
                    render_launchd_plist_scheduled(profile, &exe, &config_path, interval_secs)
                }
            };
            if dry_run {
                note_parts.push("Dry run only; no files were written.".to_string());
                return Ok(AgentInstallSummary {
                    profile: profile.to_string(),
                    config_path: config_path.display().to_string(),
                    service_manager: "launchd".to_string(),
                    service_name: launchd_label(profile),
                    service_path: Some(plist_path.display().to_string()),
                    dry_run: true,
                    installed: false,
                    enabled: None,
                    running: None,
                    note: Some(note_parts.join(" ")),
                    preview: Some(content),
                });
            }
            if let Some(parent) = plist_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            tokio::fs::write(&plist_path, content)
                .await
                .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
            let _ = run_process(
                "launchctl",
                &["unload", plist_path.to_string_lossy().as_ref()],
            );
            let load = run_process(
                "launchctl",
                &["load", "-w", plist_path.to_string_lossy().as_ref()],
            )?;
            if !load.ok {
                return Err(describe_probe_error("launchctl load", &load));
            }
            let listed = run_process("launchctl", &["list", launchd_label(profile).as_str()]).ok();
            Ok(AgentInstallSummary {
                profile: profile.to_string(),
                config_path: config_path.display().to_string(),
                service_manager: "launchd".to_string(),
                service_name: launchd_label(profile),
                service_path: Some(plist_path.display().to_string()),
                dry_run: false,
                installed: true,
                enabled: Some(true),
                running: listed.as_ref().map(|p| p.ok),
                note: if note_parts.is_empty() {
                    None
                } else {
                    Some(note_parts.join(" "))
                },
                preview: None,
            })
        }
        "windows" => {
            let task_name = windows_task_name(profile);
            let mut note_parts: Vec<String> = Vec::new();

            match mode {
                AgentInstallMode::Daemon => {
                    let command = format!(
                        "\"{}\" agent --config \"{}\"",
                        exe.display(),
                        config_path.display()
                    );
                    let preview = format!(
                        "schtasks /Create /F /SC ONLOGON /TN \"{}\" /TR {}",
                        task_name, command
                    );
                    if dry_run {
                        return Ok(AgentInstallSummary {
                            profile: profile.to_string(),
                            config_path: config_path.display().to_string(),
                            service_manager: "task_scheduler".to_string(),
                            service_name: task_name,
                            service_path: None,
                            dry_run: true,
                            installed: false,
                            enabled: None,
                            running: None,
                            note: Some("Dry run only; no scheduled task was created.".to_string()),
                            preview: Some(preview),
                        });
                    }

                    let create = run_process(
                        "schtasks",
                        &[
                            "/Create", "/F", "/SC", "ONLOGON", "/TN", &task_name, "/TR", &command,
                        ],
                    )?;
                    if !create.ok {
                        return Err(describe_probe_error("schtasks /Create", &create));
                    }
                    Ok(AgentInstallSummary {
                        profile: profile.to_string(),
                        config_path: config_path.display().to_string(),
                        service_manager: "task_scheduler".to_string(),
                        service_name: task_name,
                        service_path: None,
                        dry_run: false,
                        installed: true,
                        enabled: Some(true),
                        running: None,
                        note: Some("The task starts the long-running agent at user logon; backup cadence stays in the profile TOML.".to_string()),
                        preview: None,
                    })
                }
                AgentInstallMode::Scheduled => {
                    let interval_secs = scheduled_interval_secs.ok_or_else(|| {
                        "internal error: missing scheduled interval for scheduled install"
                            .to_string()
                    })?;
                    let interval_minutes = (interval_secs / 60).max(1);
                    if interval_minutes > 1439 {
                        return Err(format!(
                            "Windows scheduled mode supports up to 1439 minutes; profile interval_secs={interval_secs} maps to {interval_minutes} minutes"
                        ));
                    }
                    if interval_secs % 60 != 0 {
                        note_parts.push(format!(
                            "Windows Task Scheduler uses whole minutes; interval_secs={interval_secs} is rounded down to {interval_minutes} minutes."
                        ));
                    }

                    let mo = interval_minutes.to_string();
                    let command = format!(
                        "\"{}\" agent run-once --config \"{}\"",
                        exe.display(),
                        config_path.display()
                    );
                    let preview = format!(
                        "schtasks /Create /F /SC MINUTE /MO {} /ST 00:00 /TN \"{}\" /TR {}",
                        interval_minutes, task_name, command
                    );
                    if dry_run {
                        note_parts.push("Dry run only; no scheduled task was created.".to_string());
                        return Ok(AgentInstallSummary {
                            profile: profile.to_string(),
                            config_path: config_path.display().to_string(),
                            service_manager: "task_scheduler".to_string(),
                            service_name: task_name,
                            service_path: None,
                            dry_run: true,
                            installed: false,
                            enabled: None,
                            running: None,
                            note: Some(note_parts.join(" ")),
                            preview: Some(preview),
                        });
                    }

                    let args: Vec<&str> = vec![
                        "/Create", "/F", "/SC", "MINUTE", "/MO", &mo, "/ST", "00:00", "/TN",
                        &task_name, "/TR", &command,
                    ];
                    let create = run_process("schtasks", &args)?;
                    if !create.ok {
                        return Err(describe_probe_error("schtasks /Create", &create));
                    }
                    note_parts.push(format!(
                        "Scheduled mode: the task runs `agent run-once` every {interval_minutes} minutes (profile interval_secs={interval_secs})."
                    ));
                    note_parts.push(
                        "Note: without additional credentials, tasks typically run only when the user is logged on."
                            .to_string(),
                    );
                    Ok(AgentInstallSummary {
                        profile: profile.to_string(),
                        config_path: config_path.display().to_string(),
                        service_manager: "task_scheduler".to_string(),
                        service_name: task_name,
                        service_path: None,
                        dry_run: false,
                        installed: true,
                        enabled: Some(true),
                        running: None,
                        note: Some(note_parts.join(" ")),
                        preview: None,
                    })
                }
            }
        }
        _ => {
            let unit_name = systemd_unit_name(profile);
            let unit_path = linux_systemd_user_unit_path(profile)?;
            let timer_name = systemd_timer_name(profile);
            let timer_path = linux_systemd_user_timer_path(profile)?;

            match mode {
                AgentInstallMode::Daemon => {
                    let content = render_systemd_user_unit(profile, &exe, &config_path);
                    if dry_run {
                        return Ok(AgentInstallSummary {
                            profile: profile.to_string(),
                            config_path: config_path.display().to_string(),
                            service_manager: "systemd-user".to_string(),
                            service_name: unit_name,
                            service_path: Some(unit_path.display().to_string()),
                            dry_run: true,
                            installed: false,
                            enabled: None,
                            running: None,
                            note: Some("Dry run only; no unit file was written.".to_string()),
                            preview: Some(content),
                        });
                    }

                    // Switching from scheduled mode: disable + remove the timer if present.
                    let _ = run_process("systemctl", &["--user", "disable", "--now", &timer_name]);
                    if timer_path.exists() {
                        tokio::fs::remove_file(&timer_path)
                            .await
                            .map_err(|e| format!("remove {}: {e}", timer_path.display()))?;
                    }

                    if let Some(parent) = unit_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                    }
                    tokio::fs::write(&unit_path, content)
                        .await
                        .map_err(|e| format!("write {}: {e}", unit_path.display()))?;
                    let reload = run_process("systemctl", &["--user", "daemon-reload"])?;
                    if !reload.ok {
                        return Err(describe_probe_error(
                            "systemctl --user daemon-reload",
                            &reload,
                        ));
                    }
                    let enable =
                        run_process("systemctl", &["--user", "enable", "--now", &unit_name])?;
                    if !enable.ok {
                        return Err(describe_probe_error(
                            "systemctl --user enable --now",
                            &enable,
                        ));
                    }
                    let enabled =
                        run_process("systemctl", &["--user", "is-enabled", &unit_name]).ok();
                    let active =
                        run_process("systemctl", &["--user", "is-active", &unit_name]).ok();
                    Ok(AgentInstallSummary {
                        profile: profile.to_string(),
                        config_path: config_path.display().to_string(),
                        service_manager: "systemd-user".to_string(),
                        service_name: unit_name,
                        service_path: Some(unit_path.display().to_string()),
                        dry_run: false,
                        installed: true,
                        enabled: enabled.as_ref().map(|p| p.ok && p.stdout == "enabled"),
                        running: active.as_ref().map(|p| p.ok && p.stdout == "active"),
                        note: None,
                        preview: None,
                    })
                }
                AgentInstallMode::Scheduled => {
                    let interval_secs = scheduled_interval_secs.ok_or_else(|| {
                        "internal error: missing scheduled interval for scheduled install"
                            .to_string()
                    })?;
                    let service_content =
                        render_systemd_user_oneshot_unit(profile, &exe, &config_path);
                    let timer_content = render_systemd_user_timer(profile, interval_secs);
                    let preview = format!(
                        "# {}\n{}\n# {}\n{}",
                        unit_path.display(),
                        service_content,
                        timer_path.display(),
                        timer_content
                    );
                    if dry_run {
                        return Ok(AgentInstallSummary {
                            profile: profile.to_string(),
                            config_path: config_path.display().to_string(),
                            service_manager: "systemd-user".to_string(),
                            service_name: timer_name,
                            service_path: Some(timer_path.display().to_string()),
                            dry_run: true,
                            installed: false,
                            enabled: None,
                            running: None,
                            note: Some("Dry run only; no unit files were written.".to_string()),
                            preview: Some(preview),
                        });
                    }

                    if let Some(parent) = unit_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                    }

                    // Switching from daemon mode: disable the long-running service before installing the timer.
                    let _ = run_process("systemctl", &["--user", "disable", "--now", &unit_name]);
                    let _ = run_process("systemctl", &["--user", "disable", "--now", &timer_name]);

                    tokio::fs::write(&unit_path, service_content)
                        .await
                        .map_err(|e| format!("write {}: {e}", unit_path.display()))?;
                    tokio::fs::write(&timer_path, timer_content)
                        .await
                        .map_err(|e| format!("write {}: {e}", timer_path.display()))?;

                    let reload = run_process("systemctl", &["--user", "daemon-reload"])?;
                    if !reload.ok {
                        return Err(describe_probe_error(
                            "systemctl --user daemon-reload",
                            &reload,
                        ));
                    }

                    let enable =
                        run_process("systemctl", &["--user", "enable", "--now", &timer_name])?;
                    if !enable.ok {
                        return Err(describe_probe_error(
                            "systemctl --user enable --now",
                            &enable,
                        ));
                    }

                    let enabled =
                        run_process("systemctl", &["--user", "is-enabled", &timer_name]).ok();
                    let active =
                        run_process("systemctl", &["--user", "is-active", &timer_name]).ok();
                    Ok(AgentInstallSummary {
                        profile: profile.to_string(),
                        config_path: config_path.display().to_string(),
                        service_manager: "systemd-user".to_string(),
                        service_name: timer_name,
                        service_path: Some(timer_path.display().to_string()),
                        dry_run: false,
                        installed: true,
                        enabled: enabled.as_ref().map(|p| p.ok && p.stdout == "enabled"),
                        running: active.as_ref().map(|p| p.ok && p.stdout == "active"),
                        note: Some(format!(
                            "Scheduled mode: systemd timer runs `agent run-once` every {interval_secs}s."
                        )),
                        preview: None,
                    })
                }
            }
        }
    }
}

async fn uninstall_agent_service(
    profile: &str,
    delete_config: bool,
) -> Result<AgentUninstallSummary, String> {
    validate_profile_name(profile)?;
    let config_path = agent_profile_path(profile)?;
    let platform = current_platform_name();
    let mut note_parts: Vec<String> = Vec::new();
    let mut removed_service = false;
    let (service_manager, service_name, service_path) = match platform {
        "macos" => {
            let path = macos_launch_agent_path(profile)?;
            let path_string = path.display().to_string();
            let _ = run_process("launchctl", &["unload", path_string.as_str()]);
            if path.exists() {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| format!("remove {}: {e}", path.display()))?;
                removed_service = true;
            } else {
                note_parts.push("launchd plist not found".to_string());
            }
            (
                "launchd".to_string(),
                launchd_label(profile),
                Some(path_string),
            )
        }
        "windows" => {
            let task_name = windows_task_name(profile);
            match run_process("schtasks", &["/Delete", "/TN", &task_name, "/F"]) {
                Ok(probe) if probe.ok => removed_service = true,
                Ok(probe) => note_parts.push(describe_probe_error("schtasks /Delete", &probe)),
                Err(e) => note_parts.push(e),
            }
            ("task_scheduler".to_string(), task_name, None)
        }
        _ => {
            let unit_name = systemd_unit_name(profile);
            let unit_path = linux_systemd_user_unit_path(profile)?;
            let timer_name = systemd_timer_name(profile);
            let timer_path = linux_systemd_user_timer_path(profile)?;

            let had_timer = timer_path.exists();
            let had_unit = unit_path.exists();

            // Disable both timer + service (if present). This keeps uninstall idempotent across modes.
            let _ = run_process("systemctl", &["--user", "disable", "--now", &timer_name]);
            let _ = run_process("systemctl", &["--user", "disable", "--now", &unit_name]);

            if had_timer {
                tokio::fs::remove_file(&timer_path)
                    .await
                    .map_err(|e| format!("remove {}: {e}", timer_path.display()))?;
                removed_service = true;
            }
            if unit_path.exists() {
                tokio::fs::remove_file(&unit_path)
                    .await
                    .map_err(|e| format!("remove {}: {e}", unit_path.display()))?;
                removed_service = true;
            }
            if !had_unit {
                note_parts.push("systemd unit not found".to_string());
            }
            if !had_timer && !had_unit {
                note_parts.push("systemd timer not found".to_string());
            }
            let _ = run_process("systemctl", &["--user", "daemon-reload"]);
            let (service_name, service_path) = if had_timer {
                (timer_name, Some(timer_path.display().to_string()))
            } else {
                (unit_name, Some(unit_path.display().to_string()))
            };
            ("systemd-user".to_string(), service_name, service_path)
        }
    };

    let removed_config = if delete_config && config_path.exists() {
        tokio::fs::remove_file(&config_path)
            .await
            .map_err(|e| format!("remove {}: {e}", config_path.display()))?;
        true
    } else {
        false
    };

    Ok(AgentUninstallSummary {
        profile: profile.to_string(),
        config_path: config_path.display().to_string(),
        service_manager,
        service_name,
        service_path,
        removed_service,
        removed_config,
        note: if note_parts.is_empty() {
            None
        } else {
            Some(note_parts.join("; "))
        },
    })
}

fn probe_agent_service(profile: &str) -> Result<AgentServiceStatus, String> {
    validate_profile_name(profile)?;
    match current_platform_name() {
        "macos" => {
            let plist_path = macos_launch_agent_path(profile)?;
            let installed = plist_path.exists();
            let mut note_parts: Vec<String> = Vec::new();
            if installed {
                if let Ok(raw) = std::fs::read_to_string(&plist_path) {
                    if raw.contains("<key>StartInterval</key>") {
                        note_parts.push("scheduled mode (StartInterval)".to_string());
                    }
                }
            }
            let running = if installed {
                match run_process("launchctl", &["list", launchd_label(profile).as_str()]) {
                    Ok(probe) => {
                        if !probe.ok {
                            note_parts.push(describe_probe_error("launchctl list", &probe));
                        }
                        Some(probe.ok)
                    }
                    Err(e) => {
                        note_parts.push(e);
                        None
                    }
                }
            } else {
                None
            };
            Ok(AgentServiceStatus {
                manager: "launchd".to_string(),
                name: launchd_label(profile),
                path: Some(plist_path.display().to_string()),
                installed,
                enabled: Some(installed),
                running,
                note: if note_parts.is_empty() {
                    None
                } else {
                    Some(note_parts.join("; "))
                },
            })
        }
        "windows" => {
            let task_name = windows_task_name(profile);
            let query = run_process(
                "schtasks",
                &["/Query", "/TN", &task_name, "/FO", "LIST", "/V"],
            );
            let (installed, note) = match query {
                Ok(probe) if probe.ok => (true, None),
                Ok(probe) => (false, Some(describe_probe_error("schtasks /Query", &probe))),
                Err(e) => (false, Some(e)),
            };
            Ok(AgentServiceStatus {
                manager: "task_scheduler".to_string(),
                name: task_name,
                path: None,
                installed,
                enabled: Some(installed),
                running: None,
                note,
            })
        }
        _ => {
            let unit_name = systemd_unit_name(profile);
            let unit_path = linux_systemd_user_unit_path(profile)?;
            let timer_name = systemd_timer_name(profile);
            let timer_path = linux_systemd_user_timer_path(profile)?;

            let timer_installed = timer_path.exists();
            let unit_installed = unit_path.exists();

            if timer_installed {
                let mut note_parts: Vec<String> =
                    vec!["scheduled mode (systemd timer)".to_string()];
                if !unit_installed {
                    note_parts.push("service unit missing".to_string());
                }

                let enabled = match run_process("systemctl", &["--user", "is-enabled", &timer_name])
                {
                    Ok(probe) => {
                        if !probe.ok {
                            note_parts
                                .push(describe_probe_error("systemctl --user is-enabled", &probe));
                        }
                        Some(probe.ok && probe.stdout == "enabled")
                    }
                    Err(e) => {
                        note_parts.push(e);
                        None
                    }
                };

                let running = match run_process("systemctl", &["--user", "is-active", &timer_name])
                {
                    Ok(probe) => {
                        if !probe.ok {
                            note_parts
                                .push(describe_probe_error("systemctl --user is-active", &probe));
                        }
                        Some(probe.ok && probe.stdout == "active")
                    }
                    Err(e) => {
                        note_parts.push(e);
                        None
                    }
                };

                return Ok(AgentServiceStatus {
                    manager: "systemd-user".to_string(),
                    name: timer_name,
                    path: Some(timer_path.display().to_string()),
                    installed: true,
                    enabled,
                    running,
                    note: Some(note_parts.join("; ")),
                });
            }

            let installed = unit_installed;
            let mut note_parts: Vec<String> = Vec::new();
            if installed {
                if let Ok(raw) = std::fs::read_to_string(&unit_path) {
                    if raw.contains("Type=oneshot") || raw.contains("agent run-once") {
                        note_parts.push("oneshot unit (run-once)".to_string());
                    }
                }
            }

            let enabled = if installed {
                match run_process("systemctl", &["--user", "is-enabled", &unit_name]) {
                    Ok(probe) => {
                        if !probe.ok {
                            note_parts
                                .push(describe_probe_error("systemctl --user is-enabled", &probe));
                        }
                        Some(probe.ok && probe.stdout == "enabled")
                    }
                    Err(e) => {
                        note_parts.push(e);
                        None
                    }
                }
            } else {
                None
            };

            let running = if installed {
                match run_process("systemctl", &["--user", "is-active", &unit_name]) {
                    Ok(probe) => {
                        if !probe.ok {
                            note_parts
                                .push(describe_probe_error("systemctl --user is-active", &probe));
                        }
                        Some(probe.ok && probe.stdout == "active")
                    }
                    Err(e) => {
                        note_parts.push(e);
                        None
                    }
                }
            } else {
                None
            };

            Ok(AgentServiceStatus {
                manager: "systemd-user".to_string(),
                name: unit_name,
                path: Some(unit_path.display().to_string()),
                installed,
                enabled,
                running,
                note: if note_parts.is_empty() {
                    None
                } else {
                    Some(note_parts.join("; "))
                },
            })
        }
    }
}

async fn probe_agent_status(profile: &str) -> Result<AgentStatusSummary, String> {
    validate_profile_name(profile)?;
    let config_path = agent_profile_path(profile)?;
    let state_path = agent_state_path(profile)?;
    let config_exists = config_path.exists();
    let state_exists = state_path.exists();
    let service = probe_agent_service(profile)?;

    if !config_exists {
        return Ok(AgentStatusSummary {
            profile: profile.to_string(),
            config_path: config_path.display().to_string(),
            config_exists,
            state_path: state_path.display().to_string(),
            state_exists,
            server: None,
            folder: None,
            device_name: None,
            auth_mode: None,
            service,
            server_status: None,
        });
    }

    let cfg = load_agent_config(&config_path).await?;
    let auth = auth_from_agent_config(&cfg);
    let server_status = match build_client_with_auth(&auth) {
        Ok(client) => {
            let devices = fetch_devices(&client, &cfg.server).await;
            let snapshots = fetch_snapshots(&client, &cfg.server).await;
            match (devices, snapshots) {
                (Ok(devices), Ok(snapshots)) => {
                    let matched_device = auth
                        .device_id
                        .as_ref()
                        .and_then(|id| devices.iter().find(|d| d.id == *id))
                        .or_else(|| devices.iter().find(|d| d.name == cfg.device_name));
                    let matching_snapshots: Vec<&SnapshotMeta> = snapshots
                        .iter()
                        .filter(|s| {
                            if let Some(device_id) = auth.device_id.as_ref() {
                                s.device_id.as_deref() == Some(device_id.as_str())
                                    || s.device_name == cfg.device_name
                            } else {
                                s.device_name == cfg.device_name
                            }
                        })
                        .collect();
                    let latest = matching_snapshots
                        .iter()
                        .max_by_key(|s| s.created_unix)
                        .copied();
                    Some(AgentServerStatus {
                        ok: true,
                        auth_mode: auth_mode_label(&auth).to_string(),
                        device_id: auth
                            .device_id
                            .clone()
                            .or_else(|| matched_device.map(|d| d.id.clone())),
                        last_seen_unix: matched_device.and_then(|d| d.last_seen_unix),
                        snapshot_count: Some(matching_snapshots.len()),
                        latest_snapshot_id: latest.map(|s| s.snapshot_id.clone()),
                        latest_snapshot_created_unix: latest.map(|s| s.created_unix),
                        error: None,
                    })
                }
                (Err(e), _) | (_, Err(e)) => Some(AgentServerStatus {
                    ok: false,
                    auth_mode: auth_mode_label(&auth).to_string(),
                    device_id: auth.device_id.clone(),
                    last_seen_unix: None,
                    snapshot_count: None,
                    latest_snapshot_id: None,
                    latest_snapshot_created_unix: None,
                    error: Some(e),
                }),
            }
        }
        Err(e) => Some(AgentServerStatus {
            ok: false,
            auth_mode: auth_mode_label(&auth).to_string(),
            device_id: auth.device_id.clone(),
            last_seen_unix: None,
            snapshot_count: None,
            latest_snapshot_id: None,
            latest_snapshot_created_unix: None,
            error: Some(e),
        }),
    };

    Ok(AgentStatusSummary {
        profile: profile.to_string(),
        config_path: config_path.display().to_string(),
        config_exists,
        state_path: state_path.display().to_string(),
        state_exists,
        server: Some(cfg.server.clone()),
        folder: Some(cfg.folder.display().to_string()),
        device_name: Some(cfg.device_name.clone()),
        auth_mode: Some(auth_mode_label(&auth).to_string()),
        service,
        server_status,
    })
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
            respect_gitignore,
        } => {
            let _ = push_folder_impl(
                server,
                device,
                folder,
                note,
                concurrency,
                exclude,
                ignore_file,
                respect_gitignore,
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
            respect_gitignore,
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
                respect_gitignore,
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
            keep_daily,
            keep_weekly,
            dry_run,
        } => {
            let client = build_client()?;
            let url = format!("{}/v1/snapshots/prune", server.trim_end_matches('/'));
            let req = SnapshotPruneRequest {
                device_id,
                device_name,
                keep_last,
                keep_days,
                keep_daily,
                keep_weekly,
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

        Command::Device { command } => match command {
            DeviceCommand::Register {
                server,
                device_name,
                os,
                token,
            } => {
                let env_auth = current_auth_from_env();
                let auth = AuthConfig {
                    token: trim_nonempty(token).or(env_auth.token),
                    device_id: None,
                    device_token: None,
                };
                let client = build_client_with_auth(&auth)?;
                let resp = register_device_impl(
                    &client,
                    &server,
                    &device_name,
                    os.as_deref().unwrap_or(current_platform_name()),
                )
                .await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
                );
            }
            DeviceCommand::Heartbeat {
                server,
                device_id,
                device_token,
                status,
            } => {
                let mut auth = current_auth_from_env();
                auth.device_token = trim_nonempty(device_token).or(auth.device_token);
                let resp = send_heartbeat_with_auth(&auth, &server, device_id, status).await?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
                );
            }
        },

        Command::DeviceHeartbeat {
            server,
            device_id,
            status,
        } => {
            let resp =
                send_heartbeat_with_auth(&current_auth_from_env(), &server, device_id, status)
                    .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&resp).map_err(|e| e.to_string())?
            );
        }

        Command::Agent { config, command } => {
            if config.is_some() && command.is_some() {
                return Err(
                    "use either `filedock agent --config ...` or `filedock agent <subcommand>`"
                        .to_string(),
                );
            }

            match command {
                Some(AgentCommand::Run { config }) => {
                    run_agent_from_config_path(&config).await?;
                }
                Some(AgentCommand::RunOnce { config }) => {
                    run_agent_once_from_config_path(&config).await?;
                }
                Some(AgentCommand::Init {
                    profile,
                    folder,
                    server,
                    device_name,
                    note,
                    interval_secs,
                    concurrency,
                    exclude,
                    ignore_file,
                    respect_gitignore,
                    no_default_excludes,
                    heartbeat_secs,
                    heartbeat_status,
                    import_json,
                    token,
                    device_id,
                    device_token,
                    os,
                    no_register,
                    keep_bootstrap_token,
                }) => {
                    validate_profile_name(&profile)?;
                    let imported = if let Some(raw) = import_json {
                        Some(load_server_config_input(&raw).await?)
                    } else {
                        None
                    };

                    let server = trim_nonempty(server)
                        .or_else(|| imported.as_ref().map(|cfg| cfg.server_base_url.clone()))
                        .ok_or_else(|| {
                            "--server required (or provide --import-json)".to_string()
                        })?;
                    let server = server.trim().trim_end_matches('/').to_string();
                    let folder = folder
                        .canonicalize()
                        .map_err(|e| format!("canonicalize folder: {e}"))?;
                    let device_name = trim_nonempty(device_name)
                        .or_else(default_device_name)
                        .unwrap_or_else(|| profile.clone());

                    let mut auth = AuthConfig {
                        token: trim_nonempty(token)
                            .or_else(|| imported.as_ref().and_then(|cfg| cfg.token.clone())),
                        device_id: trim_nonempty(device_id)
                            .or_else(|| imported.as_ref().and_then(|cfg| cfg.device_id.clone())),
                        device_token: trim_nonempty(device_token)
                            .or_else(|| imported.as_ref().and_then(|cfg| cfg.device_token.clone())),
                    };

                    if auth.device_id.is_some() ^ auth.device_token.is_some() {
                        return Err(
                            "device_id and device_token must be provided together".to_string()
                        );
                    }

                    let mut device_registered = false;
                    if auth.device_id.is_none() && auth.device_token.is_none() && !no_register {
                        let register_auth = AuthConfig {
                            token: auth.token.clone(),
                            device_id: None,
                            device_token: None,
                        };
                        let client = build_client_with_auth(&register_auth)?;
                        let resp = register_device_impl(
                            &client,
                            &server,
                            &device_name,
                            os.as_deref().unwrap_or(current_platform_name()),
                        )
                        .await?;
                        auth.device_id = Some(resp.device_id);
                        auth.device_token = Some(resp.device_token);
                        device_registered = true;
                    }

                    if auth.device_id.is_some()
                        && auth.device_token.is_some()
                        && !keep_bootstrap_token
                    {
                        auth.token = None;
                    }

                    let mut cfg = AgentConfig {
                        server: server.clone(),
                        device_name: device_name.clone(),
                        folder: folder.clone(),
                        note,
                        interval_secs,
                        concurrency,
                        exclude,
                        ignore_file,
                        respect_gitignore,
                        token: auth.token.clone(),
                        device_id: auth.device_id.clone(),
                        device_token: auth.device_token.clone(),
                        heartbeat_secs,
                        heartbeat_status,
                    };
                    let default_excludes_applied = apply_default_excludes_if_needed(
                        &mut cfg.exclude,
                        &cfg.ignore_file,
                        no_default_excludes,
                    );

                    let config_path = agent_profile_path(&profile)?;
                    if let Some(parent) = config_path.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                    }
                    let rendered = toml::to_string_pretty(&cfg)
                        .map_err(|e| format!("render agent config: {e}"))?;
                    tokio::fs::write(&config_path, rendered)
                        .await
                        .map_err(|e| format!("write {}: {e}", config_path.display()))?;

                    let state_path = agent_state_path(&profile)?;
                    let summary = AgentInitSummary {
                        profile,
                        config_path: config_path.display().to_string(),
                        state_path: state_path.display().to_string(),
                        server,
                        device_name,
                        folder: folder.display().to_string(),
                        exclude: cfg.exclude.clone(),
                        ignore_file: cfg.ignore_file.as_ref().map(|p| p.display().to_string()),
                        respect_gitignore: cfg.respect_gitignore,
                        default_excludes_applied,
                        auth_mode: auth_mode_label(&auth).to_string(),
                        device_registered,
                        device_id: auth.device_id,
                        kept_bootstrap_token: keep_bootstrap_token && cfg.token.is_some(),
                    };
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
                    );
                }
                Some(AgentCommand::Install {
                    profile,
                    dry_run,
                    mode,
                }) => {
                    let summary = install_agent_service(&profile, dry_run, mode).await?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
                    );
                }
                Some(AgentCommand::Status { profile }) => {
                    let summary = probe_agent_status(&profile).await?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
                    );
                }
                Some(AgentCommand::Uninstall {
                    profile,
                    delete_config,
                }) => {
                    let summary = uninstall_agent_service(&profile, delete_config).await?;
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?
                    );
                }
                None => {
                    let config = config.ok_or_else(|| {
                        "use `filedock agent --config <path>` or `filedock agent <subcommand>`"
                            .to_string()
                    })?;
                    run_agent_from_config_path(&config).await?;
                }
            }
        }

        Command::Status {
            server,
            snapshot,
            latest,
            device_name,
            folder,
            exclude,
            ignore_file,
            respect_gitignore,
            include_ignored,
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

            // Mirror the same ignore inputs as `push-folder`:
            // - `.filedockignore` in the folder root (default)
            // - optional `--ignore-file`
            // - optional `--exclude` globs
            let mut exclude_patterns = Vec::<String>::new();
            exclude_patterns.extend(load_ignore_patterns(&root, ignore_file)?);
            exclude_patterns.extend(exclude);
            let exclude_set = build_excludes(&exclude_patterns)?;
            let gitignore = load_root_gitignore(&root, respect_gitignore)?;

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
                let rel = Path::new(&p);
                if is_ignored_path(&exclude_set, gitignore.as_ref(), rel, &p, false) {
                    items.push(StatusItem {
                        path: p,
                        status: "ignored".to_string(),
                        reason: Some("matched ignore rules".to_string()),
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
                let mut it = WalkDir::new(&root).follow_links(false).into_iter();
                while let Some(entry) = it.next() {
                    let entry = entry.map_err(|e| format!("walkdir: {e}"))?;
                    let ft = entry.file_type();

                    let abs_path = entry.path().to_path_buf();
                    let rel = abs_path
                        .strip_prefix(&root)
                        .map_err(|e| format!("strip prefix: {e}"))?;
                    let rel_str = rel
                        .iter()
                        .map(|s| s.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");

                    if rel_str.is_empty() {
                        continue;
                    }

                    if ft.is_dir() {
                        // Prune ignored directories to keep status checks fast on large trees
                        // (node_modules/.git/etc).
                        let ignore_dir =
                            is_ignored_path(&exclude_set, gitignore.as_ref(), rel, &rel_str, true);
                        if ignore_dir {
                            if include_ignored {
                                items.push(StatusItem {
                                    path: rel_str,
                                    status: "ignored".to_string(),
                                    reason: Some("matched ignore rules (dir)".to_string()),
                                    local_size: None,
                                    server_size: None,
                                    local_mtime_unix: None,
                                    server_mtime_unix: None,
                                });
                            }
                            it.skip_current_dir();
                        }
                        continue;
                    }

                    if !ft.is_file() {
                        continue;
                    }

                    if is_ignored_path(&exclude_set, gitignore.as_ref(), rel, &rel_str, false) {
                        if include_ignored {
                            items.push(StatusItem {
                                path: rel_str,
                                status: "ignored".to_string(),
                                reason: Some("matched ignore rules".to_string()),
                                local_size: None,
                                server_size: None,
                                local_mtime_unix: None,
                                server_mtime_unix: None,
                            });
                        }
                        continue;
                    }

                    items.push(check_one(rel_str, abs_path, &by_path, verify).await?);
                }

                // Also report files that exist in the snapshot but are missing locally.
                for rel_path in by_path.keys() {
                    let rel = Path::new(rel_path);
                    if is_ignored_path(&exclude_set, gitignore.as_ref(), rel, rel_path, false) {
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

fn load_root_gitignore(root: &Path, enabled: bool) -> Result<Option<Gitignore>, String> {
    if !enabled {
        return Ok(None);
    }

    let p = root.join(".gitignore");
    match std::fs::metadata(&p) {
        Ok(m) => {
            if !m.is_file() {
                return Ok(None);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("stat gitignore {}: {e}", p.display())),
    }

    let mut b = GitignoreBuilder::new(root);
    b.add(p);
    b.build()
        .map(Some)
        .map_err(|e| format!("parse .gitignore: {e}"))
}

fn is_ignored_by_globs(exclude_set: &GlobSet, rel_str: &str, is_dir: bool) -> bool {
    if exclude_set.is_match(rel_str) {
        return true;
    }
    if is_dir {
        // Probe a synthetic child so patterns like `**/node_modules/**` match directories too.
        let probe = format!("{rel_str}/_");
        if exclude_set.is_match(&probe) {
            return true;
        }
    }
    false
}

fn is_ignored_path(
    exclude_set: &GlobSet,
    gitignore: Option<&Gitignore>,
    rel: &Path,
    rel_str: &str,
    is_dir: bool,
) -> bool {
    if is_ignored_by_globs(exclude_set, rel_str, is_dir) {
        return true;
    }

    let Some(gi) = gitignore else {
        return false;
    };

    gi.matched_path_or_any_parents(rel, is_dir).is_ignore()
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

#[cfg(test)]
mod tests {
    use super::{
        apply_default_excludes_if_needed, build_excludes, default_config_root_from_env,
        is_ignored_path, load_root_gitignore, render_launchd_plist_scheduled,
        render_systemd_user_oneshot_unit, render_systemd_user_timer, render_systemd_user_unit,
        summarize_http_body, validate_profile_name,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn summarize_http_body_compacts_whitespace() {
        assert_eq!(
            summarize_http_body(
                "  hello
	world  "
            ),
            "hello world"
        );
    }

    #[test]
    fn summarize_http_body_truncates_long_messages() {
        let input = "x".repeat(300);
        let output = summarize_http_body(&input);
        assert_eq!(output.chars().count(), 241);
        assert!(output.ends_with('…'));
    }

    #[test]
    fn validate_profile_name_rejects_path_separators() {
        assert!(validate_profile_name("good-name_01").is_ok());
        assert!(validate_profile_name("bad/name").is_err());
    }

    #[test]
    fn linux_config_root_uses_xdg_config_home() {
        let root = default_config_root_from_env(
            "linux",
            Some("/home/nita".to_string()),
            Some("/tmp/xdg-config".to_string()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(root, Path::new("/tmp/xdg-config/filedock"));
    }

    #[test]
    fn windows_config_root_uses_appdata() {
        let root = default_config_root_from_env(
            "windows",
            None,
            None,
            Some(r"C:\Users\Nita\AppData\Roaming".to_string()),
            None,
        )
        .unwrap();
        assert_eq!(
            root,
            Path::new(r"C:\Users\Nita\AppData\Roaming").join("FileDock")
        );
    }

    #[test]
    fn render_systemd_unit_mentions_profile_and_config() {
        let unit = render_systemd_user_unit(
            "laptop",
            Path::new("/usr/local/bin/filedock"),
            Path::new("/home/nita/.config/filedock/agents/laptop.toml"),
        );
        assert!(unit.contains("FileDock agent (laptop)"));
        assert!(unit.contains(
            "ExecStart=/usr/local/bin/filedock agent --config /home/nita/.config/filedock/agents/laptop.toml"
        ));
        assert!(unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn render_systemd_oneshot_unit_mentions_run_once() {
        let unit = render_systemd_user_oneshot_unit(
            "laptop",
            Path::new("/usr/local/bin/filedock"),
            Path::new("/home/nita/.config/filedock/agents/laptop.toml"),
        );
        assert!(unit.contains("Type=oneshot"));
        assert!(unit.contains(
            "ExecStart=/usr/local/bin/filedock agent run-once --config /home/nita/.config/filedock/agents/laptop.toml"
        ));
    }

    #[test]
    fn render_systemd_timer_mentions_interval_and_timers_target() {
        let timer = render_systemd_user_timer("laptop", 900);
        assert!(timer.contains("OnUnitActiveSec=900s"));
        assert!(timer.contains("WantedBy=timers.target"));
    }

    #[test]
    fn render_launchd_plist_scheduled_mentions_start_interval_and_run_once() {
        let plist = render_launchd_plist_scheduled(
            "laptop",
            Path::new("/Applications/FileDock/filedock"),
            Path::new("/Users/nita/.config/filedock/agents/laptop.toml"),
            900,
        );
        assert!(plist.contains("<key>StartInterval</key>"));
        assert!(plist.contains("<integer>900</integer>"));
        assert!(plist.contains("<string>run-once</string>"));
    }

    #[test]
    fn default_excludes_applied_when_empty_and_not_disabled() {
        let mut exclude = Vec::<String>::new();
        let ignore_file = None;
        let applied = apply_default_excludes_if_needed(&mut exclude, &ignore_file, false);
        assert!(applied);
        assert_eq!(exclude, vec!["**/.git/**", "**/node_modules/**"]);
    }

    #[test]
    fn default_excludes_not_applied_when_disabled() {
        let mut exclude = Vec::<String>::new();
        let ignore_file = None;
        let applied = apply_default_excludes_if_needed(&mut exclude, &ignore_file, true);
        assert!(!applied);
        assert!(exclude.is_empty());
    }

    #[test]
    fn default_excludes_not_applied_when_user_provides_exclude() {
        let mut exclude = vec!["**/tmp/**".to_string()];
        let ignore_file = None;
        let applied = apply_default_excludes_if_needed(&mut exclude, &ignore_file, false);
        assert!(!applied);
        assert_eq!(exclude, vec!["**/tmp/**"]);
    }

    #[test]
    fn default_excludes_not_applied_when_ignore_file_is_set() {
        let mut exclude = Vec::<String>::new();
        let ignore_file = Some(PathBuf::from(".filedockignore"));
        let applied = apply_default_excludes_if_needed(&mut exclude, &ignore_file, false);
        assert!(!applied);
        assert!(exclude.is_empty());
    }

    fn mk_tmp_dir(prefix: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "filedock_test_{}_{}",
            prefix,
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn load_root_gitignore_is_none_when_disabled_or_missing() {
        let root = mk_tmp_dir("gitignore_missing");
        assert!(load_root_gitignore(&root, false).unwrap().is_none());
        assert!(load_root_gitignore(&root, true).unwrap().is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn gitignore_ignores_directories_and_files() {
        let root = mk_tmp_dir("gitignore_rules");
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n!keep.log\n").unwrap();

        let gi = load_root_gitignore(&root, true).unwrap().unwrap();
        let exclude_set = build_excludes(&Vec::<String>::new()).unwrap();

        assert!(is_ignored_path(
            &exclude_set,
            Some(&gi),
            Path::new("target"),
            "target",
            true
        ));
        assert!(is_ignored_path(
            &exclude_set,
            Some(&gi),
            Path::new("target/app.bin"),
            "target/app.bin",
            false
        ));

        assert!(is_ignored_path(
            &exclude_set,
            Some(&gi),
            Path::new("debug.log"),
            "debug.log",
            false
        ));
        assert!(!is_ignored_path(
            &exclude_set,
            Some(&gi),
            Path::new("keep.log"),
            "keep.log",
            false
        ));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
