use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "v1";

/// MVP assumes BLAKE3 hashes encoded as 64 hex characters (32 bytes).
pub fn is_valid_chunk_hash(s: &str) -> bool {
    if s.len() != 64 {
        return false;
    }
    s.as_bytes().iter().all(|b| b.is_ascii_hexdigit())
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
