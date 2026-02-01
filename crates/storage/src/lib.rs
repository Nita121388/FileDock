use async_trait::async_trait;
use bytes::Bytes;
use std::path::{Component, Path, PathBuf};

fn validate_key(key: &str) -> Result<(), StorageError> {
    // Keys are logical object keys, e.g. "chunks/<hash>".
    //
    // Keep the rules strict so both DiskStorage and S3Storage behave similarly.
    if key.is_empty() {
        return Err(StorageError::InvalidKey);
    }
    if key.starts_with('/') || key.starts_with('\\') {
        return Err(StorageError::InvalidKey);
    }

    // Use Path component parsing to reject traversal attempts.
    let key_path = Path::new(key);
    for comp in key_path.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            // Disallow Prefix/RootDir/ParentDir and anything else that could escape a disk root.
            _ => return Err(StorageError::InvalidKey),
        }
    }

    Ok(())
}

fn normalize_prefix(prefix: Option<String>) -> Result<Option<String>, StorageError> {
    let Some(mut p) = prefix else { return Ok(None) };
    p = p.trim().to_string();
    if p.is_empty() {
        return Ok(None);
    }

    // Treat prefix like a key prefix; forbid traversal-y inputs.
    validate_key(&p)?;

    // Make it a "directory-like" prefix to simplify join/strip.
    if !p.ends_with('/') {
        p.push('/');
    }

    Ok(Some(p))
}

#[derive(Debug, Clone)]
pub struct PutOpts {
    pub content_type: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found")]
    NotFound,

    #[error("invalid key")]
    InvalidKey,

    #[error("unsupported")]
    Unsupported,

    #[error("io: {0}")]
    Io(String),

    #[error("other: {0}")]
    Other(String),
}

#[async_trait]
pub trait Storage: Send + Sync {
    async fn exists(&self, key: &str) -> Result<bool, StorageError>;
    async fn put(&self, key: &str, data: Bytes, opts: PutOpts) -> Result<(), StorageError>;
    async fn get(&self, key: &str) -> Result<Bytes, StorageError>;
    /// List object keys under a prefix (best-effort; order not guaranteed).
    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>, StorageError>;
    /// Delete an object key. Returns true if something was deleted, false if it did not exist.
    async fn delete(&self, key: &str) -> Result<bool, StorageError>;
}

#[derive(Debug, Clone)]
pub struct DiskStorage {
    root_dir: PathBuf,
}

impl DiskStorage {
    pub fn new(root_dir: impl Into<PathBuf>) -> Self {
        Self {
            root_dir: root_dir.into(),
        }
    }

    fn key_to_path(&self, key: &str) -> Result<PathBuf, StorageError> {
        // Prevent path traversal; keys are logical object keys (e.g., "chunks/<hash>").
        validate_key(key)?;

        let key_path = Path::new(key);
        Ok(self.root_dir.join(key_path))
    }
}

#[async_trait]
impl Storage for DiskStorage {
    async fn exists(&self, key: &str) -> Result<bool, StorageError> {
        let path = self.key_to_path(key)?;
        match tokio::fs::metadata(&path).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(StorageError::Io(e.to_string())),
        }
    }

    async fn put(&self, key: &str, data: Bytes, _opts: PutOpts) -> Result<(), StorageError> {
        let path = self.key_to_path(key)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| StorageError::Io(e.to_string()))?;
        }
        tokio::fs::write(&path, data)
            .await
            .map_err(|e| StorageError::Io(e.to_string()))?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Bytes, StorageError> {
        let path = self.key_to_path(key)?;
        match tokio::fs::read(&path).await {
            Ok(data) => Ok(Bytes::from(data)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StorageError::NotFound),
            Err(e) => Err(StorageError::Io(e.to_string())),
        }
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>, StorageError> {
        // Treat prefix as a logical key prefix like "snapshots/".
        // We map it to a directory and recursively list files.
        let dir_path = self.key_to_path(prefix)?;
        let mut out = Vec::new();

        let meta = match tokio::fs::metadata(&dir_path).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(StorageError::Io(e.to_string())),
        };
        if !meta.is_dir() {
            return Ok(out);
        }

        let root = self.root_dir.clone();
        let mut stack = vec![dir_path];
        while let Some(dir) = stack.pop() {
            let mut rd = tokio::fs::read_dir(&dir)
                .await
                .map_err(|e| StorageError::Io(e.to_string()))?;
            while let Some(ent) = rd
                .next_entry()
                .await
                .map_err(|e| StorageError::Io(e.to_string()))?
            {
                let path = ent.path();
                let ft = ent
                    .file_type()
                    .await
                    .map_err(|e| StorageError::Io(e.to_string()))?;
                if ft.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }

                let rel = path
                    .strip_prefix(&root)
                    .map_err(|e| StorageError::Other(e.to_string()))?;
                let key = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(key);
            }
        }

        Ok(out)
    }

    async fn delete(&self, key: &str) -> Result<bool, StorageError> {
        let path = self.key_to_path(key)?;
        match tokio::fs::remove_file(&path).await {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(StorageError::Io(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disk_storage_rejects_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let st = DiskStorage::new(dir.path());

        let err = st
            .put(
                "../evil",
                Bytes::from_static(b"x"),
                PutOpts { content_type: None },
            )
            .await
            .unwrap_err();

        assert!(matches!(err, StorageError::InvalidKey));
    }

    #[test]
    fn normalize_prefix_is_dir_like() {
        assert_eq!(
            normalize_prefix(Some("filedock".to_string())).unwrap(),
            Some("filedock/".to_string())
        );
        assert_eq!(
            normalize_prefix(Some("filedock/".to_string())).unwrap(),
            Some("filedock/".to_string())
        );
        assert_eq!(normalize_prefix(Some("".to_string())).unwrap(), None);
    }
}

// --- S3-compatible object storage backend ---

#[derive(Debug, Clone)]
pub struct S3StorageConfig {
    pub bucket: String,
    pub region: String,

    /// Optional endpoint URL for S3-compatible services (e.g. MinIO / Cloudflare R2).
    pub endpoint: Option<String>,

    /// Optional global prefix under which all FileDock keys live (e.g. "filedock/").
    pub prefix: Option<String>,

    /// Force path-style addressing (useful for MinIO).
    pub force_path_style: bool,
}

#[derive(Clone)]
pub struct S3Storage {
    client: aws_sdk_s3::Client,
    bucket: String,
    prefix: Option<String>,
}

impl std::fmt::Debug for S3Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Storage")
            .field("bucket", &self.bucket)
            .field("prefix", &self.prefix)
            .finish()
    }
}

impl S3Storage {
    pub async fn new(cfg: S3StorageConfig) -> Result<Self, StorageError> {
        if cfg.bucket.trim().is_empty() {
            return Err(StorageError::Other("missing s3 bucket".to_string()));
        }
        if cfg.region.trim().is_empty() {
            return Err(StorageError::Other("missing s3 region".to_string()));
        }

        let prefix = normalize_prefix(cfg.prefix)?;

        let mut loader = aws_config::from_env()
            .region(aws_types::region::Region::new(cfg.region.clone()));
        if let Some(ep) = cfg.endpoint.as_ref().filter(|s| !s.trim().is_empty()) {
            loader = loader.endpoint_url(ep.trim().to_string());
        }

        let shared = loader.load().await;
        let mut s3conf = aws_sdk_s3::config::Builder::from(&shared);
        if cfg.force_path_style {
            s3conf = s3conf.force_path_style(true);
        }
        let client = aws_sdk_s3::Client::from_conf(s3conf.build());

        Ok(Self {
            client,
            bucket: cfg.bucket.trim().to_string(),
            prefix,
        })
    }

    fn full_key(&self, key: &str) -> Result<String, StorageError> {
        validate_key(key)?;
        Ok(match self.prefix.as_ref() {
            Some(p) => format!("{p}{key}"),
            None => key.to_string(),
        })
    }

    fn strip_prefix<'a>(&self, full_key: &'a str) -> &'a str {
        match self.prefix.as_ref() {
            Some(p) if full_key.starts_with(p) => &full_key[p.len()..],
            _ => full_key,
        }
    }

    fn looks_like_not_found(msg: &str) -> bool {
        let m = msg.to_ascii_lowercase();
        m.contains("nosuchkey") || m.contains("notfound") || m.contains("404")
    }
}

#[async_trait]
impl Storage for S3Storage {
    async fn exists(&self, key: &str) -> Result<bool, StorageError> {
        let k = self.full_key(key)?;
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(k)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(e) => {
                let msg = e.to_string();
                if Self::looks_like_not_found(&msg) {
                    Ok(false)
                } else {
                    Err(StorageError::Other(msg))
                }
            }
        }
    }

    async fn put(&self, key: &str, data: Bytes, opts: PutOpts) -> Result<(), StorageError> {
        let k = self.full_key(key)?;

        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(k)
            .body(aws_sdk_s3::primitives::ByteStream::from(data.to_vec()));

        if let Some(ct) = opts.content_type.as_ref().filter(|s| !s.trim().is_empty()) {
            req = req.content_type(ct.trim());
        }

        req.send()
            .await
            .map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Bytes, StorageError> {
        let k = self.full_key(key)?;
        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(k)
            .send()
            .await
            .map_err(|e| {
                let msg = e.to_string();
                if Self::looks_like_not_found(&msg) {
                    StorageError::NotFound
                } else {
                    StorageError::Other(msg)
                }
            })?;

        let data = resp
            .body
            .collect()
            .await
            .map_err(|e| StorageError::Other(e.to_string()))?
            .into_bytes();

        Ok(data)
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>, StorageError> {
        validate_key(prefix)?;

        let full_prefix = match self.prefix.as_ref() {
            Some(p) => format!("{p}{prefix}"),
            None => prefix.to_string(),
        };

        let mut out: Vec<String> = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(full_prefix.clone());
            if let Some(t) = token.as_ref() {
                req = req.continuation_token(t);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| StorageError::Other(e.to_string()))?;

            if let Some(contents) = resp.contents {
                for obj in contents {
                    if let Some(k) = obj.key {
                        out.push(self.strip_prefix(&k).to_string());
                    }
                }
            }

            if resp.is_truncated.unwrap_or(false) {
                token = resp.next_continuation_token;
            } else {
                break;
            }
        }

        Ok(out)
    }

    async fn delete(&self, key: &str) -> Result<bool, StorageError> {
        // S3 delete is idempotent; do an existence check for accurate return value.
        let existed = self.exists(key).await?;
        if !existed {
            return Ok(false);
        }

        let k = self.full_key(key)?;
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(k)
            .send()
            .await
            .map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(true)
    }
}
