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
  device_id?: string | null;
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

export type ChunkPresenceRequest = { hashes: string[] };
export type ChunkPresenceResponse = { missing: string[] };

export type ChunkRef = { hash: string; size: number };

export type ManifestFileEntry = {
  path: string;
  size: number;
  mtime_unix: number;
  chunk_hash?: string | null;
  chunks?: ChunkRef[] | null;
};

export type SnapshotManifest = {
  snapshot_id: string;
  created_unix: number;
  files: ManifestFileEntry[];
};

export type SnapshotCreateRequest = {
  device_name: string;
  device_id?: string | null;
  root_path: string;
};

export type SnapshotCreateResponse = { snapshot_id: string };

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
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = base + path;
  const resp = await fetch(url, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST ${path} failed: ${resp.status} ${text}`.trim());
  }
  return (await resp.json()) as T;
}

export async function apiGetJson<T>(
  settings: Settings,
  path: string,
  query?: Record<string, string>,
  signal?: AbortSignal
): Promise<T> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: headers(settings),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${resp.status} ${text}`.trim());
  }
  return (await resp.json()) as T;
}

export async function apiGetBytes(
  settings: Settings,
  path: string,
  query?: Record<string, string>,
  signal?: AbortSignal
): Promise<Blob> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: headers(settings),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${resp.status} ${text}`.trim());
  }
  return await resp.blob();
}

export async function apiGetUint8Array(
  settings: Settings,
  path: string,
  query?: Record<string, string>,
  onProgress?: (doneBytes: number, totalBytes: number | null) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: headers(settings),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${resp.status} ${text}`.trim());
  }

  const lenHeader = resp.headers.get("content-length");
  const total = lenHeader ? Number(lenHeader) : null;
  const body = resp.body;

  if (!body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onProgress?.(buf.length, buf.length);
    return buf;
  }

  const reader = body.getReader();
  let done = 0;
  const chunks: Uint8Array[] = [];
  let out: Uint8Array | null = total !== null && Number.isFinite(total) && total >= 0 ? new Uint8Array(total) : null;

  while (true) {
    const { value, done: rdDone } = await reader.read();
    if (rdDone) break;
    if (!value) continue;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(chunk);
    if (out) {
      out.set(chunk, done);
    }
    done += chunk.byteLength;
    onProgress?.(done, total);
  }

  if (out) return out.subarray(0, done);
  // Unknown length: concatenate.
  out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
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

export async function chunksPresence(
  settings: Settings,
  req: ChunkPresenceRequest,
  signal?: AbortSignal
): Promise<ChunkPresenceResponse> {
  return apiPostJson<ChunkPresenceResponse>(settings, "/v1/chunks/presence", req, signal);
}

export async function putChunk(settings: Settings, hash: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chunks/${encodeURIComponent(hash)}`;
  const body: ArrayBuffer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  const resp = await fetch(url, {
    method: "PUT",
    headers: headers(settings),
    body,
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PUT /v1/chunks/${hash} failed: ${resp.status} ${text}`.trim());
  }
}

export async function createSnapshot(
  settings: Settings,
  req: SnapshotCreateRequest,
  signal?: AbortSignal
): Promise<SnapshotCreateResponse> {
  return apiPostJson<SnapshotCreateResponse>(settings, "/v1/snapshots", req, signal);
}

export async function putManifest(
  settings: Settings,
  snapshotId: string,
  manifest: SnapshotManifest,
  signal?: AbortSignal
): Promise<void> {
  const base = settings.serverBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/snapshots/${encodeURIComponent(snapshotId)}/manifest`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: headers(settings),
    body: JSON.stringify(manifest),
    signal
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`PUT /v1/snapshots/${snapshotId}/manifest failed: ${resp.status} ${text}`.trim());
  }
}
