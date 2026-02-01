export type TransferStatus = "queued" | "running" | "done" | "failed";

export type Conn = {
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
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
  dstSnapshotId?: string;
  // Persisted resume state.
  filePaths?: string[];
  nextIndex?: number;
  error?: string;
  progress?: TransferProgress;
};

export type TransferJob = DownloadJob | CopyJob | CopyFolderJob;

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
