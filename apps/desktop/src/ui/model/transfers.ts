export type TransferStatus = "queued" | "running" | "done" | "failed";

export type Conn = {
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
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
};

export type TransferJob = DownloadJob | CopyJob;

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
        const withStatus = { ...j, status };

        if (j.kind === "download") return withStatus as DownloadJob;
        if (j.kind === "copy_file") return withStatus as CopyJob;
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
