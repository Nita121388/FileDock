export type TransferStatus = "queued" | "done" | "failed";

export type TransferJob = {
  id: string;
  kind: "download";
  createdAt: number;
  status: TransferStatus;
  snapshotId: string;
  path: string; // snapshot-relative POSIX path
  fileName: string;
  error?: string;
};

const KEY = "filedock.desktop.transfers.v1";

export function loadTransfers(): TransferJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TransferJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((j) => j && typeof j.id === "string");
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

