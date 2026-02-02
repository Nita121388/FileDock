use axum::{
    body::Body,
    extract::{Path, State},
    http::Request,
    http::StatusCode,
    middleware::Next,
    routing::{delete, get, post, put},
    Json, Router,
};
use bytes::Bytes;
use filedock_protocol::{
    is_valid_chunk_hash, is_valid_rel_path, ChunkGcRequest, ChunkGcResponse, ChunkPresenceRequest,
    ChunkPresenceResponse, ChunkRef, DeviceHeartbeatRequest, DeviceHeartbeatResponse, DeviceInfo,
    DeviceRegisterRequest, DeviceRegisterResponse, HealthResponse, SnapshotCreateRequest,
    SnapshotCreateResponse, SnapshotDeleteResponse, SnapshotManifest, SnapshotMeta,
    SnapshotPruneRequest, SnapshotPruneResponse, TreeEntry, TreeResponse,
};
use filedock_storage::{DiskStorage, PutOpts, S3Storage, S3StorageConfig, Storage};
use std::{net::SocketAddr, sync::Arc};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use axum::extract::Query;
use clap::Parser;
use serde::Deserialize;
use std::io;

#[derive(Parser, Debug)]
#[command(name = "filedock-server", version)]
struct Opt {
    /// Listen address (IP:PORT).
    #[arg(long, env = "FILEDOCK_LISTEN", default_value = "0.0.0.0:8787")]
    listen: String,

    /// Storage backend: "disk" (default) or "s3" (S3-compatible object storage).
    #[arg(long, env = "FILEDOCK_STORAGE_BACKEND", default_value = "disk")]
    storage_backend: String,

    /// Storage directory (DiskStorage root).
    #[arg(long, env = "FILEDOCK_STORAGE_DIR", default_value = "./filedock-data")]
    storage_dir: String,

    /// S3 bucket name (required when backend is "s3").
    #[arg(long, env = "FILEDOCK_S3_BUCKET")]
    s3_bucket: Option<String>,

    /// S3 region (required when backend is "s3"). For S3-compatible services, "us-east-1" is usually fine.
    #[arg(long, env = "FILEDOCK_S3_REGION", default_value = "us-east-1")]
    s3_region: String,

    /// Optional S3-compatible endpoint URL (e.g. http://127.0.0.1:9000 for MinIO, or https://<account>.r2.cloudflarestorage.com for R2).
    #[arg(long, env = "FILEDOCK_S3_ENDPOINT")]
    s3_endpoint: Option<String>,

    /// Optional prefix under which FileDock stores all keys (e.g. "filedock/").
    #[arg(long, env = "FILEDOCK_S3_PREFIX")]
    s3_prefix: Option<String>,

    /// Force S3 path-style addressing (useful for MinIO).
    #[arg(long, env = "FILEDOCK_S3_FORCE_PATH_STYLE", default_value_t = false)]
    s3_force_path_style: bool,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct DeviceRecord {
    device_id: String,
    device_name: String,
    os: String,
    device_token: String,
    created_unix: i64,
    last_seen_unix: Option<i64>,
}

#[derive(Clone)]
struct AppState {
    storage: Arc<dyn Storage>,
    token: Option<String>,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn register_device(
    State(state): State<AppState>,
    Json(req): Json<DeviceRegisterRequest>,
) -> Result<Json<DeviceRegisterResponse>, (StatusCode, String)> {
    if req.device_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "device_name required".to_string()));
    }
    if req.os.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "os required".to_string()));
    }

    let device_id = Uuid::new_v4().to_string();
    let device_token = Uuid::new_v4().to_string();

    let rec = DeviceRecord {
        device_id: device_id.clone(),
        device_name: req.device_name,
        os: req.os,
        device_token: device_token.clone(),
        created_unix: now_unix(),
        last_seen_unix: None,
    };

    let key = format!("devices/{device_id}.json");
    let data =
        serde_json::to_vec(&rec).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .storage
        .put(
            &key,
            Bytes::from(data),
            PutOpts {
                content_type: Some("application/json".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(DeviceRegisterResponse {
        device_id,
        device_token,
    }))
}

async fn list_devices(
    State(state): State<AppState>,
) -> Result<Json<Vec<DeviceInfo>>, (StatusCode, String)> {
    let keys = state
        .storage
        .list_prefix("devices/")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut out = Vec::new();
    for key in keys {
        if !key.ends_with(".json") {
            continue;
        }
        let data = state.storage.get(&key).await.map_err(|e| match e {
            filedock_storage::StorageError::NotFound => {
                (StatusCode::NOT_FOUND, "not found".to_string())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })?;
        let rec: DeviceRecord = serde_json::from_slice(&data)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        out.push(DeviceInfo {
            id: rec.device_id,
            name: rec.device_name,
            os: rec.os,
            last_seen_unix: rec.last_seen_unix,
        });
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(out))
}

async fn device_heartbeat(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    Json(req): Json<DeviceHeartbeatRequest>,
) -> Result<Json<DeviceHeartbeatResponse>, (StatusCode, String)> {
    if device_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "device_id required".to_string()));
    }
    if req.agent_version.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "agent_version required".to_string(),
        ));
    }

    // Load device record and update last_seen.
    let key = format!("devices/{device_id}.json");
    let data = state.storage.get(&key).await.map_err(|e| match e {
        filedock_storage::StorageError::NotFound => {
            (StatusCode::NOT_FOUND, "device not found".to_string())
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    })?;
    let mut rec: DeviceRecord = serde_json::from_slice(&data)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let now = now_unix();
    rec.last_seen_unix = Some(now);

    let new_data =
        serde_json::to_vec(&rec).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .storage
        .put(
            &key,
            Bytes::from(new_data),
            PutOpts {
                content_type: Some("application/json".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Store last heartbeat payload for debugging.
    #[derive(serde::Serialize)]
    struct HeartbeatRecord {
        device_id: String,
        agent_version: String,
        status: Option<String>,
        created_unix: i64,
    }
    let hb = HeartbeatRecord {
        device_id: device_id.clone(),
        agent_version: req.agent_version,
        status: req.status,
        created_unix: now,
    };
    let hb_key = format!("devices/{device_id}.heartbeat.json");
    let hb_data =
        serde_json::to_vec(&hb).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .storage
        .put(
            &hb_key,
            Bytes::from(hb_data),
            PutOpts {
                content_type: Some("application/json".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(DeviceHeartbeatResponse {
        device_id,
        last_seen_unix: now,
    }))
}

async fn auth(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    // If FILEDOCK_TOKEN is not set, run in open mode (dev).
    let Some(expected) = &state.token else {
        return Ok(next.run(req).await);
    };

    // Health endpoint is always open.
    if req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }

    // Server/admin token always works.
    let got = req
        .headers()
        .get("x-filedock-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let path = req.uri().path();
    let is_admin_route = path.starts_with("/v1/admin/")
        || path == "/v1/snapshots/prune"
        || (req.method() == axum::http::Method::DELETE && path.starts_with("/v1/snapshots/"));

    if got != expected {
        // Admin routes require the server token (device tokens are not allowed).
        if is_admin_route {
            return Err(StatusCode::UNAUTHORIZED);
        }

        // Device token is allowed for non-registration routes.
        if path == "/v1/auth/device/register" {
            return Err(StatusCode::UNAUTHORIZED);
        }

        let dev_id = req
            .headers()
            .get("x-filedock-device-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let dev_token = req
            .headers()
            .get("x-filedock-device-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if dev_id.is_empty() || dev_token.is_empty() {
            return Err(StatusCode::UNAUTHORIZED);
        }

        let key = format!("devices/{dev_id}.json");
        let data = state
            .storage
            .get(&key)
            .await
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        let rec: DeviceRecord =
            serde_json::from_slice(&data).map_err(|_| StatusCode::UNAUTHORIZED)?;
        if rec.device_token != dev_token {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    Ok(next.run(req).await)
}

async fn chunks_presence(
    State(state): State<AppState>,
    Json(req): Json<ChunkPresenceRequest>,
) -> Result<Json<ChunkPresenceResponse>, (StatusCode, String)> {
    let mut missing = Vec::new();
    for hash in req.hashes {
        if !is_valid_chunk_hash(&hash) {
            return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
        }
        let key = format!("chunks/{hash}");
        let exists = state
            .storage
            .exists(&key)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if !exists {
            missing.push(hash);
        }
    }
    Ok(Json(ChunkPresenceResponse { missing }))
}

async fn put_chunk(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    if !is_valid_chunk_hash(&hash) {
        return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
    }
    // Integrity: key must match content hash.
    let actual = blake3::hash(&body).to_hex().to_string();
    if actual != hash {
        return Err((StatusCode::BAD_REQUEST, "chunk hash mismatch".to_string()));
    }
    let key = format!("chunks/{hash}");
    state
        .storage
        .put(
            &key,
            body,
            PutOpts {
                content_type: Some("application/octet-stream".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::CREATED)
}

async fn get_chunk(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Bytes, (StatusCode, String)> {
    if !is_valid_chunk_hash(&hash) {
        return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
    }
    let key = format!("chunks/{hash}");
    state.storage.get(&key).await.map_err(|e| match e {
        filedock_storage::StorageError::NotFound => {
            (StatusCode::NOT_FOUND, "not found".to_string())
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    })
}

async fn create_snapshot(
    State(state): State<AppState>,
    Json(req): Json<SnapshotCreateRequest>,
) -> Result<Json<SnapshotCreateResponse>, (StatusCode, String)> {
    if req.device_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "device_name required".to_string()));
    }
    if req.root_path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "root_path required".to_string()));
    }
    let snapshot_id = Uuid::new_v4().to_string();

    let meta = SnapshotMeta {
        snapshot_id: snapshot_id.clone(),
        device_name: req.device_name,
        device_id: req.device_id,
        root_path: req.root_path,
        created_unix: now_unix(),
    };
    let key = format!("snapshots/{snapshot_id}.json");
    let data = serde_json::to_vec(&meta)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .storage
        .put(
            &key,
            Bytes::from(data),
            PutOpts {
                content_type: Some("application/json".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(SnapshotCreateResponse { snapshot_id }))
}

async fn list_snapshots(
    State(state): State<AppState>,
) -> Result<Json<Vec<SnapshotMeta>>, (StatusCode, String)> {
    Ok(Json(load_snapshot_metas(&state).await?))
}

async fn load_snapshot_metas(state: &AppState) -> Result<Vec<SnapshotMeta>, (StatusCode, String)> {
    let keys = state
        .storage
        .list_prefix("snapshots/")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut out = Vec::new();
    for key in keys {
        if !key.ends_with(".json") {
            continue;
        }
        let data = state.storage.get(&key).await.map_err(|e| match e {
            filedock_storage::StorageError::NotFound => {
                (StatusCode::NOT_FOUND, "not found".to_string())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })?;
        let meta: SnapshotMeta = serde_json::from_slice(&data)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        out.push(meta);
    }

    out.sort_by(|a, b| b.created_unix.cmp(&a.created_unix));
    Ok(out)
}

async fn delete_snapshot(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
) -> Result<Json<SnapshotDeleteResponse>, (StatusCode, String)> {
    if snapshot_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "snapshot id required".to_string()));
    }

    let meta_key = format!("snapshots/{snapshot_id}.json");
    let manifest_key = format!("manifests/{snapshot_id}.json");

    let deleted_meta = state
        .storage
        .delete(&meta_key)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let deleted_manifest = state
        .storage
        .delete(&manifest_key)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(SnapshotDeleteResponse {
        snapshot_id,
        deleted_meta,
        deleted_manifest,
    }))
}

async fn prune_snapshots(
    State(state): State<AppState>,
    Json(req): Json<SnapshotPruneRequest>,
) -> Result<Json<SnapshotPruneResponse>, (StatusCode, String)> {
    if req.keep_last.is_none() && req.keep_days.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            "keep_last or keep_days required".to_string(),
        ));
    }

    let now = now_unix();
    let cutoff_unix = req
        .keep_days
        .map(|d| now.saturating_sub((d as i64).saturating_mul(86400)));

    let all = load_snapshot_metas(&state).await?;
    let examined = all.len() as u64;

    let matched: Vec<SnapshotMeta> = all
        .into_iter()
        .filter(|m| {
            if let Some(id) = &req.device_id {
                if m.device_id.as_deref() != Some(id.as_str()) {
                    return false;
                }
            }
            if let Some(name) = &req.device_name {
                if m.device_name != *name {
                    return false;
                }
            }
            true
        })
        .collect();

    let matched_count = matched.len() as u64;

    // Group snapshots by a stable device key: prefer device_id when present, else device_name.
    let mut groups: std::collections::BTreeMap<String, Vec<SnapshotMeta>> =
        std::collections::BTreeMap::new();
    for m in matched {
        let key = m
            .device_id
            .clone()
            .unwrap_or_else(|| format!("name:{}", m.device_name));
        groups.entry(key).or_default().push(m);
    }

    let mut keep = std::collections::HashSet::<String>::new();
    for (_k, metas) in groups.iter_mut() {
        metas.sort_by(|a, b| b.created_unix.cmp(&a.created_unix));

        if let Some(keep_last) = req.keep_last {
            let keep_last = keep_last as usize;
            for m in metas.iter().take(keep_last) {
                keep.insert(m.snapshot_id.clone());
            }
        }

        if let Some(cutoff) = cutoff_unix {
            for m in metas.iter() {
                if m.created_unix >= cutoff {
                    keep.insert(m.snapshot_id.clone());
                }
            }
        }
    }

    let mut deleted_snapshot_ids = Vec::<String>::new();
    if !req.dry_run {
        for (_k, metas) in groups.iter() {
            for m in metas {
                if keep.contains(&m.snapshot_id) {
                    continue;
                }
                let meta_key = format!("snapshots/{}.json", m.snapshot_id);
                let manifest_key = format!("manifests/{}.json", m.snapshot_id);
                let _ = state
                    .storage
                    .delete(&manifest_key)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                let _ = state
                    .storage
                    .delete(&meta_key)
                    .await
                    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
                deleted_snapshot_ids.push(m.snapshot_id.clone());
            }
        }
    } else {
        for (_k, metas) in groups.iter() {
            for m in metas {
                if keep.contains(&m.snapshot_id) {
                    continue;
                }
                deleted_snapshot_ids.push(m.snapshot_id.clone());
            }
        }
    }

    Ok(Json(SnapshotPruneResponse {
        dry_run: req.dry_run,
        examined,
        matched: matched_count,
        groups: groups.len() as u64,
        deleted: deleted_snapshot_ids.len() as u64,
        deleted_snapshot_ids,
    }))
}

async fn gc_chunks(
    State(state): State<AppState>,
    Json(req): Json<ChunkGcRequest>,
) -> Result<Json<ChunkGcResponse>, (StatusCode, String)> {
    // Gather referenced chunk hashes from all manifests.
    let manifest_keys = state
        .storage
        .list_prefix("manifests/")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut referenced = std::collections::HashSet::<String>::new();
    for key in manifest_keys {
        if !key.ends_with(".json") {
            continue;
        }
        let data = state.storage.get(&key).await.map_err(|e| match e {
            filedock_storage::StorageError::NotFound => {
                (StatusCode::NOT_FOUND, "not found".to_string())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })?;
        let manifest: SnapshotManifest = serde_json::from_slice(&data).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("decode manifest {key}: {e}"),
            )
        })?;
        for f in &manifest.files {
            if f.size == 0 {
                continue;
            }
            if let Some(chunks) = &f.chunks {
                for c in chunks {
                    referenced.insert(c.hash.clone());
                }
            } else if let Some(h) = &f.chunk_hash {
                referenced.insert(h.clone());
            }
        }
    }

    // List all stored chunks.
    let chunk_keys = state
        .storage
        .list_prefix("chunks/")
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut total_chunks = 0u64;
    let mut unref = Vec::<String>::new();
    for key in chunk_keys {
        let Some(hash) = key.strip_prefix("chunks/") else {
            continue;
        };
        if hash.is_empty() {
            continue;
        }
        if !is_valid_chunk_hash(hash) {
            // Ignore unexpected keys.
            continue;
        }
        total_chunks += 1;
        if !referenced.contains(hash) {
            unref.push(hash.to_string());
        }
    }

    unref.sort();
    let unreferenced_chunks = unref.len() as u64;
    let referenced_chunks = total_chunks.saturating_sub(unreferenced_chunks);

    let limit = req
        .max_delete
        .map(|n| std::cmp::min(n as usize, unref.len()))
        .unwrap_or(unref.len());

    let mut deleted = Vec::<String>::new();
    if !req.dry_run {
        for h in unref.into_iter().take(limit) {
            let key = format!("chunks/{h}");
            let did = state
                .storage
                .delete(&key)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            if did {
                deleted.push(h);
            }
        }
    } else {
        deleted.extend(unref.into_iter().take(limit));
    }

    // Avoid giant payloads; still useful for debugging.
    if deleted.len() > 1000 {
        deleted.truncate(1000);
    }

    Ok(Json(ChunkGcResponse {
        dry_run: req.dry_run,
        total_chunks,
        referenced_chunks,
        unreferenced_chunks,
        deleted_chunks: deleted.len() as u64,
        deleted_chunk_hashes: deleted,
    }))
}

async fn put_manifest(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
    Json(manifest): Json<SnapshotManifest>,
) -> Result<StatusCode, (StatusCode, String)> {
    if snapshot_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "snapshot id required".to_string()));
    }
    if manifest.snapshot_id != snapshot_id {
        return Err((StatusCode::BAD_REQUEST, "snapshot id mismatch".to_string()));
    }
    for f in &manifest.files {
        if !is_valid_rel_path(&f.path) {
            return Err((StatusCode::BAD_REQUEST, "invalid file path".to_string()));
        }

        // Back-compat: accept either single chunk_hash or chunks[].
        if let Some(ch) = &f.chunk_hash {
            if !is_valid_chunk_hash(ch) {
                return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
            }
        }
        if let Some(chunks) = &f.chunks {
            if chunks.is_empty() && f.size != 0 {
                return Err((StatusCode::BAD_REQUEST, "empty chunks".to_string()));
            }
            for ChunkRef { hash, size: _ } in chunks {
                if !is_valid_chunk_hash(hash) {
                    return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
                }
            }
        }
    }

    let key = format!("manifests/{snapshot_id}.json");
    let data = serde_json::to_vec(&manifest)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    state
        .storage
        .put(
            &key,
            Bytes::from(data),
            PutOpts {
                content_type: Some("application/json".to_string()),
            },
        )
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::CREATED)
}

async fn load_manifest(
    state: &AppState,
    snapshot_id: &str,
) -> Result<SnapshotManifest, (StatusCode, String)> {
    let key = format!("manifests/{snapshot_id}.json");
    let data = state.storage.get(&key).await.map_err(|e| match e {
        filedock_storage::StorageError::NotFound => {
            (StatusCode::NOT_FOUND, "not found".to_string())
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    })?;
    let manifest: SnapshotManifest = serde_json::from_slice(&data)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(manifest)
}

async fn get_manifest(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
) -> Result<Json<SnapshotManifest>, (StatusCode, String)> {
    Ok(Json(load_manifest(&state, &snapshot_id).await?))
}

#[derive(Debug, Deserialize)]
struct TreeQuery {
    path: Option<String>,
}

async fn get_tree(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
    Query(q): Query<TreeQuery>,
) -> Result<Json<TreeResponse>, (StatusCode, String)> {
    let manifest = load_manifest(&state, &snapshot_id).await?;

    let path = q.path.unwrap_or_default();
    let prefix = if path.trim().is_empty() {
        String::new()
    } else {
        if !is_valid_rel_path(&path) {
            return Err((StatusCode::BAD_REQUEST, "invalid path".to_string()));
        }
        format!("{path}/")
    };

    let mut dirs = std::collections::BTreeSet::<String>::new();
    let mut files = Vec::<TreeEntry>::new();

    for f in &manifest.files {
        if !f.path.starts_with(&prefix) {
            continue;
        }
        let rest = &f.path[prefix.len()..];
        if rest.is_empty() {
            continue;
        }
        if let Some((child, _)) = rest.split_once('/') {
            dirs.insert(child.to_string());
        } else {
            files.push(TreeEntry {
                name: rest.to_string(),
                kind: "file".to_string(),
                size: Some(f.size),
                mtime_unix: Some(f.mtime_unix),
                // For UI: show a representative hash if present.
                chunk_hash: f.chunk_hash.clone().or_else(|| {
                    f.chunks
                        .as_ref()
                        .and_then(|c| c.first().map(|x| x.hash.clone()))
                }),
            });
        }
    }

    let mut entries = Vec::new();
    for d in dirs {
        entries.push(TreeEntry {
            name: d,
            kind: "dir".to_string(),
            size: None,
            mtime_unix: None,
            chunk_hash: None,
        });
    }
    // Stable sort file names.
    files.sort_by(|a, b| a.name.cmp(&b.name));
    entries.extend(files);

    Ok(Json(TreeResponse { path, entries }))
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

async fn get_file_stream(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
    Query(q): Query<FileQuery>,
) -> Result<axum::body::Body, (StatusCode, String)> {
    if !is_valid_rel_path(&q.path) {
        return Err((StatusCode::BAD_REQUEST, "invalid path".to_string()));
    }

    let manifest = load_manifest(&state, &snapshot_id).await?;
    let entry = manifest
        .files
        .iter()
        .find(|f| f.path == q.path)
        .ok_or((StatusCode::NOT_FOUND, "file not found".to_string()))?;

    if entry.size == 0 {
        return Ok(axum::body::Body::from(Bytes::new()));
    }

    let chunks: Vec<ChunkRef> = if let Some(chunks) = &entry.chunks {
        chunks.clone()
    } else if let Some(hash) = &entry.chunk_hash {
        vec![ChunkRef {
            hash: hash.clone(),
            size: entry.size,
        }]
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "manifest missing chunk info".to_string(),
        ));
    };

    // Stream chunks sequentially without buffering all of them first.
    // If a chunk read fails mid-stream, the client will observe a truncated response.
    // This is acceptable for now (caller can retry / verify via hashes).
    let storage = state.storage.clone();
    let stream = futures_util::stream::try_unfold(
        (storage, chunks, 0usize),
        |(storage, chunks, idx)| async move {
            if idx >= chunks.len() {
                return Ok::<_, io::Error>(None);
            }
            let key = format!("chunks/{}", chunks[idx].hash);
            let data = storage.get(&key).await.map_err(|e| match e {
                filedock_storage::StorageError::NotFound => {
                    io::Error::new(io::ErrorKind::NotFound, "chunk not found")
                }
                _ => io::Error::other(e.to_string()),
            })?;
            Ok(Some((data, (storage, chunks, idx + 1))))
        },
    );

    Ok(axum::body::Body::from_stream(stream))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let opt = Opt::parse();

    let storage: Arc<dyn Storage> = match opt.storage_backend.trim() {
        "disk" => Arc::new(DiskStorage::new(opt.storage_dir)),
        "s3" => {
            let bucket = opt
                .s3_bucket
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    eprintln!(
                        "missing FILEDOCK_S3_BUCKET (required when FILEDOCK_STORAGE_BACKEND=s3)"
                    );
                    std::process::exit(2);
                });

            let cfg = S3StorageConfig {
                bucket,
                region: opt.s3_region.clone(),
                endpoint: opt.s3_endpoint.clone(),
                prefix: opt.s3_prefix.clone(),
                force_path_style: opt.s3_force_path_style,
            };

            Arc::new(
                S3Storage::new(cfg)
                    .await
                    .unwrap_or_else(|e| panic!("failed to init s3 storage: {e}")),
            )
        }
        other => {
            eprintln!("invalid FILEDOCK_STORAGE_BACKEND: {other} (expected: disk|s3)");
            std::process::exit(2);
        }
    };

    let token = std::env::var("FILEDOCK_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!("auth: enabled (FILEDOCK_TOKEN set)");
    } else {
        tracing::warn!("auth: disabled (FILEDOCK_TOKEN not set)");
    }

    let state = AppState { storage, token };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/auth/device/register", post(register_device))
        .route("/v1/devices", get(list_devices))
        .route("/v1/devices/:device_id/heartbeat", post(device_heartbeat))
        .route("/v1/snapshots", post(create_snapshot).get(list_snapshots))
        .route("/v1/snapshots/prune", post(prune_snapshots))
        .route("/v1/snapshots/:snapshot_id", delete(delete_snapshot))
        .route("/v1/admin/chunks/gc", post(gc_chunks))
        .route(
            "/v1/snapshots/:snapshot_id/manifest",
            put(put_manifest).get(get_manifest),
        )
        .route("/v1/snapshots/:snapshot_id/tree", get(get_tree))
        .route("/v1/snapshots/:snapshot_id/file", get(get_file_stream))
        .route("/v1/chunks/presence", post(chunks_presence))
        .route("/v1/chunks/:hash", put(put_chunk).get(get_chunk))
        // Add auth layer before attaching state; middleware already has a cloned state.
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state);

    let addr: SocketAddr = opt.listen.parse().expect("valid listen addr");
    tracing::info!(%addr, "server listening");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
