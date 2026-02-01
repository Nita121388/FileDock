import type { Settings } from "../model/settings";

export type SnapshotMeta = {
  snapshot_id: string;
  device_name: string;
  root_path: string;
  created_unix: number;
};

export type TreeEntry = {
  name: string;
  kind: "file" | "dir";
  size?: number | null;
  mtime_unix?: number | null;
  chunk_hash?: string | null;
};

export type TreeResponse = {
  path: string;
  entries: TreeEntry[];
};

function headers(settings: Settings): HeadersInit {
  const h: Record<string, string> = {
    "content-type": "application/json"
  };
  if (settings.token.trim()) h["x-filedock-token"] = settings.token.trim();
  return h;
}

export async function apiGetJson<T>(settings: Settings, path: string, query?: Record<string, string>): Promise<T> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: headers(settings)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${resp.status} ${text}`.trim());
  }
  return (await resp.json()) as T;
}

export async function apiGetBytes(settings: Settings, path: string, query?: Record<string, string>): Promise<Blob> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: settings.token.trim() ? { "x-filedock-token": settings.token.trim() } : undefined
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${resp.status} ${text}`.trim());
  }
  return await resp.blob();
}

export async function listSnapshots(settings: Settings): Promise<SnapshotMeta[]> {
  return apiGetJson<SnapshotMeta[]>(settings, "/v1/snapshots");
}

export async function getTree(settings: Settings, snapshotId: string, path: string): Promise<TreeResponse> {
  return apiGetJson<TreeResponse>(settings, `/v1/snapshots/${encodeURIComponent(snapshotId)}/tree`, { path });
}

