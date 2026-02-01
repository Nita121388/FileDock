import type { Settings } from "../model/settings";

export type DeviceInfo = {
  id: string;
  name: string;
  os: string;
};

export type DeviceRegisterRequest = {
  device_name: string;
  os: string;
};

export type DeviceRegisterResponse = {
  device_id: string;
  device_token: string;
};

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
  if (settings.deviceId.trim()) h["x-filedock-device-id"] = settings.deviceId.trim();
  if (settings.deviceToken.trim()) h["x-filedock-device-token"] = settings.deviceToken.trim();
  return h;
}

async function apiPostJson<T>(
  settings: Settings,
  path: string,
  body: unknown
): Promise<T> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = base + path;
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${resp.status} ${text}`.trim());
  }
  return (await resp.json()) as T;
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
    headers: headers(settings)
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

export async function listDevices(settings: Settings): Promise<DeviceInfo[]> {
  return apiGetJson<DeviceInfo[]>(settings, "/v1/devices");
}

export async function registerDevice(settings: Settings, req: DeviceRegisterRequest): Promise<DeviceRegisterResponse> {
  return apiPostJson<DeviceRegisterResponse>(settings, "/v1/auth/device/register", req);
}
