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
    /// List object keys under a prefix (best-effort; order not guaranteed).
    async fn list_prefix(&self, prefix: &str) -> Result<Vec<String>, StorageError>;
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
}
