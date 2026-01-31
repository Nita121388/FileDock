use async_trait::async_trait;
use bytes::Bytes;

#[derive(Debug, Clone)]
pub struct PutOpts {
    pub content_type: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not found")]
    NotFound,

    #[error("unsupported")]
    Unsupported,

    #[error("io: {0}")]
    Io(String),

    #[error("other: {0}")]
    Other(String),
}

#[async_trait]
pub trait Storage: Send + Sync {
    async fn put(&self, key: &str, data: Bytes, opts: PutOpts) -> Result<(), StorageError>;
    async fn get(&self, key: &str) -> Result<Bytes, StorageError>;
}

pub struct DiskStorage;

#[async_trait]
impl Storage for DiskStorage {
    async fn put(&self, _key: &str, _data: Bytes, _opts: PutOpts) -> Result<(), StorageError> {
        Err(StorageError::Unsupported)
    }

    async fn get(&self, _key: &str) -> Result<Bytes, StorageError> {
        Err(StorageError::Unsupported)
    }
}
