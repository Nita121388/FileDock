use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post, put},
    Json, Router,
};
use bytes::Bytes;
use filedock_protocol::{
    is_valid_chunk_hash, is_valid_rel_path, ChunkPresenceRequest, ChunkPresenceResponse,
    HealthResponse, SnapshotCreateRequest, SnapshotCreateResponse, SnapshotManifest, TreeEntry,
    TreeResponse,
};
use filedock_storage::{DiskStorage, PutOpts, Storage};
use std::{net::SocketAddr, sync::Arc};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use axum::extract::Query;
use serde::Deserialize;

#[derive(Clone)]
struct AppState {
    storage: Arc<dyn Storage>,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
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
    state
        .storage
        .get(&key)
        .await
        .map_err(|e| match e {
            filedock_storage::StorageError::NotFound => {
                (StatusCode::NOT_FOUND, "not found".to_string())
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })
}

async fn create_snapshot(
    Json(req): Json<SnapshotCreateRequest>,
) -> Result<Json<SnapshotCreateResponse>, (StatusCode, String)> {
    if req.device_name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "device_name required".to_string()));
    }
    if req.root_path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "root_path required".to_string()));
    }
    let snapshot_id = Uuid::new_v4().to_string();
    Ok(Json(SnapshotCreateResponse { snapshot_id }))
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
        if !is_valid_chunk_hash(&f.chunk_hash) {
            return Err((StatusCode::BAD_REQUEST, "invalid chunk hash".to_string()));
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
        filedock_storage::StorageError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
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
                chunk_hash: Some(f.chunk_hash.clone()),
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

async fn get_file_bytes(
    State(state): State<AppState>,
    Path(snapshot_id): Path<String>,
    Query(q): Query<FileQuery>,
) -> Result<Bytes, (StatusCode, String)> {
    if !is_valid_rel_path(&q.path) {
        return Err((StatusCode::BAD_REQUEST, "invalid path".to_string()));
    }

    let manifest = load_manifest(&state, &snapshot_id).await?;
    let entry = manifest
        .files
        .iter()
        .find(|f| f.path == q.path)
        .ok_or((StatusCode::NOT_FOUND, "file not found".to_string()))?;

    // MVP: single chunk per file
    let key = format!("chunks/{}", entry.chunk_hash);
    state.storage.get(&key).await.map_err(|e| match e {
        filedock_storage::StorageError::NotFound => (StatusCode::NOT_FOUND, "chunk not found".to_string()),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    // Disk storage root for MVP (override with FILEDOCK_STORAGE_DIR).
    let storage_dir = std::env::var("FILEDOCK_STORAGE_DIR").unwrap_or_else(|_| "./filedock-data".to_string());
    let storage: Arc<dyn Storage> = Arc::new(DiskStorage::new(storage_dir));

    let state = AppState { storage };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/snapshots", post(create_snapshot))
        .route(
            "/v1/snapshots/:snapshot_id/manifest",
            put(put_manifest).get(get_manifest),
        )
        .route("/v1/snapshots/:snapshot_id/tree", get(get_tree))
        .route("/v1/snapshots/:snapshot_id/file", get(get_file_bytes))
        .route("/v1/chunks/presence", post(chunks_presence))
        .route("/v1/chunks/:hash", put(put_chunk).get(get_chunk))
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8787".parse().expect("valid listen addr");
    tracing::info!(%addr, "server listening");

    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
