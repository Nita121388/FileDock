use async_trait::async_trait;
use bytes::Bytes;
use std::path::{Component, Path, PathBuf};

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
        if key.is_empty() {
            return Err(StorageError::InvalidKey);
        }
        if key.starts_with('/') || key.starts_with('\\') {
            return Err(StorageError::InvalidKey);
        }

        let key_path = Path::new(key);
        for comp in key_path.components() {
            match comp {
                Component::Normal(_) => {}
                Component::CurDir => {}
                // Disallow Prefix/RootDir/ParentDir and anything else that could escape root_dir.
                _ => return Err(StorageError::InvalidKey),
            }
        }

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
}

