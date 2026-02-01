use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "v1";

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
pub struct SnapshotCreateRequest {
    pub device_name: String,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotCreateResponse {
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub snapshot_id: String,
    pub device_name: String,
    pub root_path: String,
    pub created_unix: i64,
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
