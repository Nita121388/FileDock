use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfigExport {
    /// Public base URL clients should use, e.g. https://files.example.com.
    pub server_base_url: String,
    /// Optional server token (present when FILEDOCK_TOKEN is set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Optional device auth (if pre-provisioned).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_token: Option<String>,
    pub api_version: String,
    pub generated_unix: i64,
}

/// MVP assumes BLAKE3 hashes encoded as 64 hex characters (32 bytes).
pub fn is_valid_chunk_hash(s: &str) -> bool {
    if s.len() != 64 {
        return false;
    }
    s.as_bytes().iter().all(|b| b.is_ascii_hexdigit())
}

/// Manifest paths are stored as relative POSIX paths (no leading slash).
pub fn is_valid_rel_path(p: &str) -> bool {
    if p.is_empty() {
        return false;
    }
    if p.starts_with('/') || p.starts_with('\\') {
        return false;
    }
    // Disallow parent traversal. (We keep this strict for MVP.)
    !p.split('/').any(|seg| seg == ".." || seg.is_empty())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub os: String,
    /// Optional last-seen timestamp (server set on heartbeat).
    pub last_seen_unix: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRegisterRequest {
    pub device_name: String,
    pub os: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRegisterResponse {
    pub device_id: String,
    /// MVP: returned once at registration time.
    /// Not yet used for request auth (server may still be protected by FILEDOCK_TOKEN).
    pub device_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceHeartbeatRequest {
    /// Agent/app version string (free-form).
    pub agent_version: String,
    /// Optional status string (free-form).
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceHeartbeatResponse {
    pub device_id: String,
    pub last_seen_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkPresenceRequest {
    pub hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkPresenceResponse {
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkGcRequest {
    /// If true, compute what would be deleted but do not delete anything.
    #[serde(default)]
    pub dry_run: bool,

    /// Maximum number of chunks to delete in one request.
    pub max_delete: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkGcResponse {
    pub dry_run: bool,
    pub total_chunks: u64,
    pub referenced_chunks: u64,
    pub unreferenced_chunks: u64,
    pub deleted_chunks: u64,
    pub deleted_chunk_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotCreateRequest {
    pub device_name: String,
    /// Optional stable id (from device registration).
    /// When omitted, server relies on device_name only.
    pub device_id: Option<String>,
    pub root_path: String,
    /// Optional free-form note (shown in history).
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotCreateResponse {
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub snapshot_id: String,
    pub device_name: String,
    pub device_id: Option<String>,
    pub root_path: String,
    pub created_unix: i64,
    /// Optional free-form note (shown in history).
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDeleteResponse {
    pub snapshot_id: String,
    pub deleted_meta: bool,
    pub deleted_manifest: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPruneRequest {
    /// Optional filter: only prune snapshots for this device_id.
    pub device_id: Option<String>,
    /// Optional filter: only prune snapshots for this device_name.
    pub device_name: Option<String>,

    /// Keep the newest N snapshots (per device group).
    pub keep_last: Option<u32>,
    /// Keep snapshots newer than N days (per device group).
    pub keep_days: Option<u32>,
    /// Keep the newest snapshot from each of the newest N UTC calendar days (per device group).
    pub keep_daily: Option<u32>,
    /// Keep the newest snapshot from each of the newest N ISO weeks in UTC (per device group).
    pub keep_weekly: Option<u32>,

    /// If true, compute what would be deleted but do not delete anything.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotPruneResponse {
    pub dry_run: bool,
    pub examined: u64,
    pub matched: u64,
    pub groups: u64,
    pub deleted: u64,
    pub deleted_snapshot_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFileEntry {
    /// Relative path from the snapshot root (POSIX style).
    pub path: String,
    pub size: u64,
    /// Seconds since UNIX epoch (UTC).
    pub mtime_unix: i64,
    /// For MVP we started with a single chunk hash per file.
    /// Kept for backward-compatibility; new uploads should prefer `chunks`.
    pub chunk_hash: Option<String>,

    /// Optional multi-chunk representation (preferred).
    pub chunks: Option<Vec<ChunkRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub snapshot_id: String,
    pub created_unix: i64,
    pub files: Vec<ManifestFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRef {
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeEntry {
    /// Name of the child (not a full path).
    pub name: String,
    pub kind: String, // "file" | "dir"

    // File-only fields (present when kind == "file").
    pub size: Option<u64>,
    pub mtime_unix: Option<i64>,
    pub chunk_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeResponse {
    /// Directory path queried ("" means root).
    pub path: String,
    pub entries: Vec<TreeEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_hash_validation() {
        assert!(!is_valid_chunk_hash(""));
        assert!(!is_valid_chunk_hash("abc"));
        assert!(is_valid_chunk_hash(&"a".repeat(64)));
        assert!(is_valid_chunk_hash(&"ABCDEF0123456789".repeat(4)));
        assert!(!is_valid_chunk_hash(&"g".repeat(64))); // non-hex
    }

    #[test]
    fn rel_path_validation() {
        assert!(!is_valid_rel_path(""));
        assert!(!is_valid_rel_path("/abs"));
        assert!(!is_valid_rel_path("../x"));
        assert!(!is_valid_rel_path("a//b"));
        assert!(is_valid_rel_path("a"));
        assert!(is_valid_rel_path("a/b/c.txt"));
    }
}
