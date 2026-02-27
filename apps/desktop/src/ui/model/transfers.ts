export type TransferStatus = "queued" | "running" | "done" | "failed";

export type Conn = {
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
};

export type SftpConn = {
  host: string;
  port: number;
  user: string;
  auth: {
    password: string;
    key_path: string;
    agent: boolean;
  };
  known_hosts: {
    policy: "strict" | "accept-new" | "insecure";
    path: string;
  };
  base_path: string;
};

export type PluginRunConfig = {
  // Optional path to filedock binary. Empty means "auto-detect or PATH".
  filedock_path?: string;
  // ":"-separated plugin dirs (FILEDOCK_PLUGIN_DIRS).
  plugin_dirs?: string;
  timeout_secs?: number;
};

export type TransferProgress = {
  phase: string; // e.g. downloading / hashing / uploading / manifest
  doneBytes?: number;
  totalBytes?: number;
  pct?: number; // 0-100 (best-effort)
};

export type DownloadJob = {
  id: string;
  kind: "download";
  createdAt: number;
  status: TransferStatus;
  // Optional override: when set, download uses this connection instead of global settings.
  conn?: Conn;
  snapshotId: string;
  path: string; // snapshot-relative POSIX path
  fileName: string;
  error?: string;
  progress?: TransferProgress;
};

export type CopyJob = {
  id: string;
  kind: "copy_file";
  createdAt: number;
  status: TransferStatus;
  src: Conn;
  dst: Conn;
  srcSnapshotId: string;
  srcPath: string;
  dstDeviceName: string;
  dstDeviceId?: string;
  dstPath: string;
  // If set, destination manifest is based on this snapshot (copy-on-write via a new snapshot).
  dstBaseSnapshotId?: string;
  conflictPolicy?: "overwrite" | "skip" | "rename";
  error?: string;
  progress?: TransferProgress;
};

export type ManifestChunkRef = { hash: string; size: number };
export type ManifestFileEntry = {
  path: string;
  size: number;
  mtime_unix: number;
  chunks: ManifestChunkRef[];
};

export type CopyFolderJob = {
  id: string;
  kind: "copy_folder";
  createdAt: number;
  status: TransferStatus;
  src: Conn;
  dst: Conn;
  srcSnapshotId: string;
  srcDirPath: string; // snapshot-relative dir ("" means root)
  dstDeviceName: string;
  dstDeviceId?: string;
  dstDirPath: string; // destination dir ("" means root)
  dstBaseSnapshotId?: string;
  conflictPolicy?: "overwrite" | "skip" | "rename";
  dstSnapshotId?: string;
  // Persisted resume state.
  filePaths?: string[];
  nextIndex?: number;
  error?: string;
  progress?: TransferProgress;
};

export type SftpDownloadJob = {
  id: string;
  kind: "sftp_download";
  createdAt: number;
  status: TransferStatus;
  runner?: PluginRunConfig;
  conn: SftpConn;
  remotePath: string; // absolute POSIX path on the remote side
  localPath: string; // absolute local path
  error?: string;
  progress?: TransferProgress;
};

export type SftpUploadJob = {
  id: string;
  kind: "sftp_upload";
  createdAt: number;
  status: TransferStatus;
  runner?: PluginRunConfig;
  conn: SftpConn;
  localPath: string; // absolute local path
  remotePath: string; // absolute POSIX path on the remote side
  mkdirs?: boolean;
  error?: string;
  progress?: TransferProgress;
};

export type SnapshotToSftpJob = {
  id: string;
  kind: "snapshot_to_sftp";
  createdAt: number;
  status: TransferStatus;
  src: Conn;
  snapshotId: string;
  snapshotPath: string; // snapshot-relative POSIX path
  runner?: PluginRunConfig;
  conn: SftpConn;
  remotePath: string; // absolute POSIX path on the remote side
  mkdirs?: boolean;
  error?: string;
  progress?: TransferProgress;
};

export type SftpToSnapshotJob = {
  id: string;
  kind: "sftp_to_snapshot";
  createdAt: number;
  status: TransferStatus;

  runner?: PluginRunConfig;
  conn: SftpConn;
  remotePath: string; // absolute POSIX path on the remote side

  dst: Conn;
  dstDeviceName: string;
  dstDeviceId?: string;
  dstBaseSnapshotId?: string;
  // Optional snapshot root_path override (metadata only).
  dstRootPath?: string;
  dstPath: string; // snapshot-relative POSIX path
  conflictPolicy?: "overwrite" | "skip" | "rename";
  // Optional snapshot note (metadata only).
  note?: string;
  // If true, delete the remote file after a successful import.
  deleteSource?: boolean;

  error?: string;
  progress?: TransferProgress;
};

export type TransferJob =
  | DownloadJob
  | CopyJob
  | CopyFolderJob
  | SftpDownloadJob
  | SftpUploadJob
  | SnapshotToSftpJob
  | SftpToSnapshotJob;

const KEY = "filedock.desktop.transfers.v1";

export function loadTransfers(): TransferJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as any[];
    if (!Array.isArray(parsed)) return [];
    // Best-effort migration.
    return parsed
      .filter((j) => j && typeof j.id === "string" && typeof j.kind === "string")
      .map((j) => {
        // Normalize unknown status values (older versions).
        const status =
          j.status === "queued" || j.status === "running" || j.status === "done" || j.status === "failed"
            ? j.status
            : "queued";
        // If the app was restarted mid-transfer, don't leave jobs stuck as "running".
        const normalizedStatus = status === "running" ? "failed" : status;
        const withStatus = { ...j, status: normalizedStatus, progress: undefined };

        if (j.kind === "download") return withStatus as DownloadJob;
        if (j.kind === "copy_file") return withStatus as CopyJob;
        if (j.kind === "copy_folder") return withStatus as CopyFolderJob;
        if (j.kind === "sftp_download") return withStatus as SftpDownloadJob;
        if (j.kind === "sftp_upload") return withStatus as SftpUploadJob;
        if (j.kind === "snapshot_to_sftp") return withStatus as SnapshotToSftpJob;
        if (j.kind === "sftp_to_snapshot") return withStatus as SftpToSnapshotJob;
        return null;
      })
      .filter((j): j is TransferJob => j !== null);
  } catch {
    return [];
  }
}

export function saveTransfers(jobs: TransferJob[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {
    // ignore
  }
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function basename(p: string): string {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
