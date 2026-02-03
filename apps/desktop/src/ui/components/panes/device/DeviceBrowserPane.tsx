import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PaneTab } from "../../../model/layout";
import type { Settings } from "../../../model/settings";
import type { Conn, PluginRunConfig, SftpConn } from "../../../model/transfers";
import {
  apiGetBytes,
  chunksPresence,
  createSnapshot,
  getManifest,
  getTree,
  listDevices,
  listSnapshots,
  putChunk,
  putManifest,
  registerDevice,
  type ManifestFileEntry,
  type SnapshotManifest,
  type DeviceInfo,
  type SnapshotMeta,
  type TreeEntry
} from "../../../api/client";
import { cancelRestoreSnapshot, restoreSnapshotToFolder, type RestoreSnapshotProgress } from "../../../api/tauri";
import { chunkFile } from "../../../util/chunking";

const RESTORE_KEY = "filedock.desktop.restore.v1";

function loadRestoreConcurrency(): number {
  try {
    const raw = localStorage.getItem(RESTORE_KEY);
    if (!raw) return 4;
    const parsed = JSON.parse(raw) as any;
    const c = Number(parsed?.concurrency);
    if (!Number.isFinite(c) || c < 1) return 4;
    return Math.min(16, Math.floor(c));
  } catch {
    return 4;
  }
}

function saveRestoreConcurrency(concurrency: number) {
  try {
    localStorage.setItem(RESTORE_KEY, JSON.stringify({ concurrency }));
  } catch {
    // ignore
  }
}

type DeviceTab = Extract<PaneTab, { pane: "deviceBrowser" }>;

type BrowserEntry = TreeEntry & {
  snapshotId?: string;
  snapshotUnix?: number;
};

type MergedFile = {
  path: string;
  entry: ManifestFileEntry;
  snapshotId: string;
  snapshotUnix: number;
};

function fmtUnix(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function fmtLastSeen(ts?: number | null): string {
  if (!ts) return "never";
  return fmtUnix(ts);
}

function detectOs(): string {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown";
}

export default function DeviceBrowserPane(props: {
  settings: Settings;
  tab: DeviceTab;
  onTabChange: (tab: DeviceTab) => void;
  onEnqueueDownload: (snapshotId: string, path: string, conn?: Conn) => void;
  onSetDeviceAuth: (deviceId: string, deviceToken: string) => void;
  onEnqueueCopy: (job: {
    src: Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
  }) => void;
  onEnqueueCopyFolder: (job: {
    src: Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
    dstBaseSnapshotId?: string;
  }) => void;
  onEnqueueSftpToSnapshot: (job: {
    runner?: PluginRunConfig;
    conn: SftpConn;
    remotePath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => void;
}) {
  const {
    settings,
    tab,
    onTabChange,
    onEnqueueDownload,
    onSetDeviceAuth,
    onEnqueueCopy,
    onEnqueueCopyFolder,
    onEnqueueSftpToSnapshot
  } = props;

  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [devicesApi, setDevicesApi] = useState<DeviceInfo[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapshotEntries, setSnapshotEntries] = useState<BrowserEntry[]>([]);
  const [mergedIndex, setMergedIndex] = useState<Map<string, MergedFile>>(new Map());
  const manifestCacheRef = useRef<Map<string, SnapshotManifest>>(new Map());
  const [loadedKey, setLoadedKey] = useState<string>("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [lastSelIndex, setLastSelIndex] = useState<number | null>(null);
  const [restorePct, setRestorePct] = useState<number | null>(null);
  const [restoreConcurrency, setRestoreConcurrency] = useState<number>(() => loadRestoreConcurrency());
  const [showHistory, setShowHistory] = useState(false);
  const [viewMode, setViewMode] = useState<"all" | "snapshot">("all");

  useEffect(() => {
    saveRestoreConcurrency(restoreConcurrency);
  }, [restoreConcurrency]);

  const deviceName = tab.state.deviceName;
  const snapshotId = tab.state.snapshotId;
  const path = tab.state.path;

  const effSettings: Settings = useMemo(() => {
    // Per-tab overrides let one window browse multiple servers/devices at once.
    const sUrl = tab.state.serverBaseUrl.trim() || settings.serverBaseUrl;
    const tok = tab.state.token || settings.token;
    const devId = tab.state.deviceId || settings.deviceId;
    const devTok = tab.state.deviceToken || settings.deviceToken;
    return {
      ...settings,
      serverBaseUrl: sUrl,
      token: tok,
      deviceId: devId,
      deviceToken: devTok
    };
  }, [
    settings,
    tab.state.serverBaseUrl,
    tab.state.token,
    tab.state.deviceId,
    tab.state.deviceToken
  ]);

  const effConn: Conn = useMemo(() => {
    return {
      serverBaseUrl: effSettings.serverBaseUrl,
      token: effSettings.token,
      deviceId: effSettings.deviceId,
      deviceToken: effSettings.deviceToken
    };
  }, [effSettings.deviceId, effSettings.deviceToken, effSettings.serverBaseUrl, effSettings.token]);

  const [regName, setRegName] = useState<string>("");
  const [regOs, setRegOs] = useState<string>(() => detectOs());

  const deviceNames = useMemo(() => {
    // Prefer registered devices; fall back to snapshot-derived names.
    const fromApi = devicesApi.map((d) => d.name).filter((x) => x);
    if (fromApi.length > 0) return Array.from(new Set(fromApi)).sort();
    return Array.from(new Set(snapshots.map((s) => s.device_name))).sort();
  }, [devicesApi, snapshots]);

  const deviceByName = useMemo(() => {
    const m = new Map<string, DeviceInfo>();
    for (const d of devicesApi) m.set(d.name, d);
    return m;
  }, [devicesApi]);

  const filtered = useMemo(() => {
    const list = snapshots.filter((s) => (deviceName ? s.device_name === deviceName : true));
    return [...list].sort((a, b) => b.created_unix - a.created_unix);
  }, [snapshots, deviceName]);

  const latestSnapshot = filtered[0];
  const activeSnapshot = useMemo(
    () => filtered.find((s) => s.snapshot_id === snapshotId) ?? null,
    [filtered, snapshotId]
  );

  const refreshDevices = useCallback(async () => {
    try {
      const ds = await listDevices(effSettings);
      setDevicesApi(ds);
      setStatus((prev) => prev || `devices: ${ds.length}`);
    } catch (e: any) {
      // Device registry may be unused; keep it non-fatal.
      setDevicesApi([]);
      setStatus(String(e?.message ?? e));
    }
  }, [effSettings]);

  const refreshSnapshots = useCallback(async () => {
    setLoading(true);
    try {
      const s = await listSnapshots(effSettings);
      setSnapshots(s);
      if (!deviceName && s.length > 0) {
        onTabChange({ ...tab, state: { ...tab.state, deviceName: s[0]!.device_name } });
      }
      setStatus(`backups: ${s.length}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [deviceName, effSettings, onTabChange, tab]);

  const refreshSnapshotTree = useCallback(async (nextSnapshotId: string, nextPath: string) => {
    setLoading(true);
    try {
      const tr = await getTree(effSettings, nextSnapshotId, nextPath);
      const withSnapshot = tr.entries.map((entry) => ({ ...entry, snapshotId: nextSnapshotId }));
      setSnapshotEntries(withSnapshot);
      setLoadedKey(`${nextSnapshotId}::${tr.path}`);
      if (tab.state.snapshotId !== nextSnapshotId || tab.state.path !== tr.path) {
        onTabChange({ ...tab, state: { ...tab.state, snapshotId: nextSnapshotId, path: tr.path } });
      }
      setStatus(`tree: ${tr.entries.length}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [effSettings, onTabChange, tab]);

  const refreshMergedIndex = useCallback(async () => {
    if (!deviceName) {
      setMergedIndex(new Map());
      return;
    }
    if (filtered.length === 0) {
      setMergedIndex(new Map());
      return;
    }
    setLoading(true);
    try {
      const keep = new Set(filtered.map((s) => s.snapshot_id));
      for (const key of manifestCacheRef.current.keys()) {
        if (!keep.has(key)) manifestCacheRef.current.delete(key);
      }

      const merged = new Map<string, MergedFile>();
      for (const snap of filtered) {
        let manifest = manifestCacheRef.current.get(snap.snapshot_id);
        if (!manifest || snap.snapshot_id === latestSnapshot?.snapshot_id) {
          manifest = await getManifest(effSettings, snap.snapshot_id);
          manifestCacheRef.current.set(snap.snapshot_id, manifest);
        }
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        for (const f of files) {
          if (!merged.has(f.path)) {
            merged.set(f.path, {
              path: f.path,
              entry: f,
              snapshotId: snap.snapshot_id,
              snapshotUnix: snap.created_unix
            });
          }
        }
      }

      setMergedIndex(merged);
      setStatus(`files: ${merged.size}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [deviceName, effSettings, filtered, latestSnapshot]);

  useEffect(() => {
    // Keep device selection valid if the device list changes.
    if (deviceNames.length === 0) {
      if (deviceName) onTabChange({ ...tab, state: { ...tab.state, deviceName: "" } });
      return;
    }
    if (!deviceName) {
      onTabChange({ ...tab, state: { ...tab.state, deviceName: deviceNames[0]! } });
      return;
    }
    if (!deviceNames.includes(deviceName)) {
      onTabChange({ ...tab, state: { ...tab.state, deviceName: deviceNames[0]! } });
    }
  }, [deviceNames, deviceName, onTabChange, tab]);

  useEffect(() => {
    if (!deviceName) return;
    setShowHistory(false);
    setViewMode("all");
  }, [deviceName]);

  useEffect(() => {
    refreshDevices();
    refreshSnapshots();
    // If we already have a selected snapshot, try to refresh the tree too.
    if (viewMode === "snapshot" && snapshotId) refreshSnapshotTree(snapshotId, path);
  }, [
    path,
    refreshDevices,
    refreshSnapshots,
    refreshSnapshotTree,
    effSettings.serverBaseUrl,
    effSettings.token,
    effSettings.deviceId,
    effSettings.deviceToken,
    snapshotId,
    viewMode
  ]);

  useEffect(() => {
    if (!deviceName) return;
    if (!latestSnapshot) {
      if (snapshotId) {
        onTabChange({ ...tab, state: { ...tab.state, snapshotId: "", path: "" } });
        setSnapshotEntries([]);
      }
      return;
    }
    if (!snapshotId || !filtered.some((s) => s.snapshot_id === snapshotId)) {
      onTabChange({ ...tab, state: { ...tab.state, snapshotId: latestSnapshot.snapshot_id, path: "" } });
      setSnapshotEntries([]);
      if (viewMode === "snapshot") {
        refreshSnapshotTree(latestSnapshot.snapshot_id, "");
      }
    }
  }, [deviceName, filtered, latestSnapshot, onTabChange, refreshSnapshotTree, snapshotId, tab, viewMode]);

  useEffect(() => {
    if (!deviceName || filtered.length === 0) {
      setMergedIndex(new Map());
      return;
    }
    refreshMergedIndex();
  }, [deviceName, filtered, refreshMergedIndex]);

  useEffect(() => {
    if (viewMode !== "all") return;
    if (!latestSnapshot) return;
    if (snapshotId === latestSnapshot.snapshot_id) return;
    onTabChange({ ...tab, state: { ...tab.state, snapshotId: latestSnapshot.snapshot_id } });
  }, [latestSnapshot, onTabChange, snapshotId, tab, viewMode]);

  useEffect(() => {
    // When switching pane tabs, sync the tree view to the tab state.
    if (viewMode !== "snapshot") {
      setSnapshotEntries([]);
      setLoadedKey("");
      setSelected([]);
      setLastSelIndex(null);
      return;
    }
    if (!snapshotId) {
      setSnapshotEntries([]);
      setLoadedKey("");
      setSelected([]);
      setLastSelIndex(null);
      return;
    }
    const wantKey = `${snapshotId}::${path}`;
    if (wantKey !== loadedKey) {
      setSnapshotEntries([]);
      setSelected([]);
      setLastSelIndex(null);
      refreshSnapshotTree(snapshotId, path);
    }
  }, [loadedKey, path, refreshSnapshotTree, snapshotId, viewMode]);

  const displayEntries = useMemo(() => {
    if (viewMode === "snapshot") return snapshotEntries;
    if (mergedIndex.size === 0) return [];
    const prefix = path ? `${path}/` : "";
    const dirs = new Set<string>();
    const files: BrowserEntry[] = [];
    for (const [filePath, info] of mergedIndex) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        files.push({
          name: rest,
          kind: "file",
          size: info.entry.size,
          mtime_unix: info.entry.mtime_unix,
          chunk_hash: info.entry.chunk_hash ?? null,
          snapshotId: info.snapshotId,
          snapshotUnix: info.snapshotUnix
        });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    const dirEntries = Array.from(dirs)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, kind: "dir" as const }));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirEntries, ...files];
  }, [mergedIndex, path, snapshotEntries, viewMode]);

  const items = useMemo(() => {
    return displayEntries.map((e, idx) => {
      const itemPath = path ? `${path}/${e.name}` : e.name;
      return { e, idx, itemPath, itemSnapshotId: e.snapshotId };
    });
  }, [displayEntries, path]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleSelect = (idx: number, itemPath: string, ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();

    setSelected((prev) => {
      const prevSet = new Set(prev);
      const shift = ev.shiftKey;
      const multi = ev.ctrlKey || ev.metaKey;

      if (shift && lastSelIndex !== null) {
        const a = Math.min(lastSelIndex, idx);
        const b = Math.max(lastSelIndex, idx);
        // Shift-select range in current directory view.
        for (let i = a; i <= b; i++) prevSet.add(items[i]!.itemPath);
        return Array.from(prevSet);
      }

      if (multi) {
        if (prevSet.has(itemPath)) prevSet.delete(itemPath);
        else prevSet.add(itemPath);
        return Array.from(prevSet);
      }

      // Single select.
      if (prevSet.size === 1 && prevSet.has(itemPath)) return prev;
      return [itemPath];
    });

    setLastSelIndex(idx);
  };

  const uploadFile = useCallback(
    async (file: File) => {
      if (!file) return;
      if (!deviceName) return;
      setLoading(true);
      try {
        const now = Math.floor(Date.now() / 1000);
        setStatus(`hashing ${file.name}...`);
        const refs = await chunkFile(file, undefined, (done, total) => {
          const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
          setStatus(`hashing ${file.name}... ${pct}%`);
        });
        const hashes = refs.map((c) => c.hash);
        const manifestChunks = refs.map((c) => ({ hash: c.hash, size: c.size }));

        // Presence (batched) to reduce requests.
        const missing = new Set<string>();
        const batchSize = 1000;
        for (let i = 0; i < hashes.length; i += batchSize) {
          const batch = hashes.slice(i, i + batchSize);
          const resp = await chunksPresence(effSettings, { hashes: batch });
          for (const h of resp.missing) missing.add(h);
        }

        // Upload missing chunks (read slices on demand; avoids buffering whole file).
        let doneBytes = 0;
        for (const c of refs) {
          doneBytes += c.size;
          if (!missing.has(c.hash)) continue;
          const end = c.offset + c.size;
          const chunkBuf = new Uint8Array(await file.slice(c.offset, end).arrayBuffer());
          await putChunk(effSettings, c.hash, chunkBuf);
          const pct = file.size > 0 ? Math.floor((doneBytes / file.size) * 100) : 0;
          setStatus(`uploading ${file.name}... ${pct}%`);
        }

        let targetSnapshotId = latestSnapshot?.snapshot_id;
        if (!targetSnapshotId) {
          const snap = await createSnapshot(effSettings, {
            device_name: deviceName,
            device_id: tab.state.deviceId?.trim() ? tab.state.deviceId.trim() : null,
            root_path: "(upload)"
          });
          targetSnapshotId = snap.snapshot_id;
        }
        const dstPath = path ? `${path}/${file.name}` : file.name;
        let files: ManifestFileEntry[] = [];
        let createdUnix = now;
        try {
          const manifest = await getManifest(effSettings, targetSnapshotId);
          createdUnix = manifest.created_unix || createdUnix;
          files = Array.isArray(manifest.files) ? manifest.files : [];
        } catch {
          files = [];
        }
        const nextFiles = files.filter((f) => f.path !== dstPath);
        nextFiles.push({
          path: dstPath,
          size: file.size,
          mtime_unix: now,
          chunk_hash: null,
          chunks: manifestChunks
        });
        await putManifest(effSettings, targetSnapshotId, {
          snapshot_id: targetSnapshotId,
          created_unix: createdUnix,
          files: nextFiles
        });

        manifestCacheRef.current.delete(targetSnapshotId);
        setStatus(`uploaded ${file.name} -> /${dstPath}`);
        await refreshSnapshots();

        if (viewMode === "snapshot") {
          // Jump into the latest snapshot at the current directory.
          onTabChange({ ...tab, state: { ...tab.state, snapshotId: targetSnapshotId } });
          await refreshSnapshotTree(targetSnapshotId, path);
        }
      } catch (e: any) {
        setStatus(String(e?.message ?? e));
      } finally {
        setLoading(false);
      }
    },
    [deviceName, effSettings, latestSnapshot, onTabChange, path, refreshSnapshots, refreshSnapshotTree, tab, viewMode]
  );

  const snapshotLabel =
    viewMode === "all"
      ? latestSnapshot
        ? `All files · ${fmtUnix(latestSnapshot.created_unix)}`
        : "All files"
      : activeSnapshot
        ? `History · ${fmtUnix(activeSnapshot.created_unix)}`
        : "History";

  return (
    <div className={`device-browser ${showHistory ? "" : "history-hidden"}`}>
      <div className="db-col">
        <div className="db-head">
          Devices
          <span className="db-head-right">
            <button className="db-mini" onClick={refreshDevices} disabled={loading} title="Refresh devices">
              Devices
            </button>
            <button className="db-mini" onClick={refreshSnapshots} disabled={loading} title="Refresh backups">
              Refresh
            </button>
          </span>
        </div>
        <div className="db-reg">
          <input
            className="db-input"
            value={tab.state.serverBaseUrl}
            onChange={(e) => onTabChange({ ...tab, state: { ...tab.state, serverBaseUrl: e.target.value } })}
            placeholder="server url (optional)"
            title="Override server URL for this pane tab"
          />
          <input
            className="db-input"
            value={tab.state.token}
            onChange={(e) => onTabChange({ ...tab, state: { ...tab.state, token: e.target.value } })}
            placeholder="server token (optional)"
            title="Override X-FileDock-Token for this pane tab"
          />
          <button
            className="db-mini"
            onClick={() => onTabChange({
              ...tab,
              state: {
                ...tab.state,
                serverBaseUrl: "",
                token: "",
                deviceId: "",
                deviceToken: ""
              }
            })}
            title="Clear per-tab connection override"
          >
            Clear
          </button>
        </div>
        <div className="db-reg">
          <input
            className="db-input"
            value={tab.state.deviceId}
            onChange={(e) => onTabChange({ ...tab, state: { ...tab.state, deviceId: e.target.value } })}
            placeholder="device id (optional)"
            title="Override X-FileDock-Device-Id for this pane tab"
          />
          <input
            className="db-input"
            value={tab.state.deviceToken}
            onChange={(e) => onTabChange({ ...tab, state: { ...tab.state, deviceToken: e.target.value } })}
            placeholder="device token (optional)"
            title="Override X-FileDock-Device-Token for this pane tab"
          />
          <span />
        </div>
        <div className="db-reg">
          <input
            className="db-input"
            value={regName}
            onChange={(e) => setRegName(e.target.value)}
            placeholder="device name"
          />
          <input
            className="db-input"
            value={regOs}
            onChange={(e) => setRegOs(e.target.value)}
            placeholder="os"
          />
          <button
            className="db-mini"
            disabled={loading || !regName.trim() || !regOs.trim()}
            onClick={async () => {
              setLoading(true);
              try {
                const resp = await registerDevice(effSettings, { device_name: regName.trim(), os: regOs.trim() });
                setStatus(`registered ${regName.trim()} (id=${resp.device_id})`);
                // Make it easy to switch to device-auth without exposing FILEDOCK_TOKEN.
                onTabChange({
                  ...tab,
                  state: {
                    ...tab.state,
                    deviceId: resp.device_id,
                    deviceToken: resp.device_token,
                    deviceName: regName.trim()
                  }
                });
                onSetDeviceAuth(resp.device_id, resp.device_token);
                await refreshDevices();
              } catch (e: any) {
                setStatus(String(e?.message ?? e));
              } finally {
                setLoading(false);
              }
            }}
            title="Register device"
          >
            Register
          </button>
          <button
            className="db-mini"
            disabled={!regName.trim() || !regOs.trim()}
            onClick={() => setRegOs(detectOs())}
            title="Auto-detect OS"
          >
            Detect
          </button>
        </div>
        <div className="db-list">
          {deviceNames.map((name) => (
            <button
              key={name}
              className={name === deviceName ? "db-item ui-item active" : "db-item ui-item"}
              onClick={() => {
                onTabChange({ ...tab, state: { ...tab.state, deviceName: name, snapshotId: "", path: "" } });
                setSnapshotEntries([]);
                setSelected([]);
                setLastSelIndex(null);
                setShowHistory(false);
                setViewMode("all");
              }}
            >
              <div className="db-title">{name}</div>
              <div className="db-sub">
                {deviceByName.get(name)?.os ? `${deviceByName.get(name)!.os} · ` : ""}
                {deviceByName.get(name)?.last_seen_unix
                  ? `seen ${fmtLastSeen(deviceByName.get(name)!.last_seen_unix)} · `
                  : ""}
                {snapshots.filter((s) => s.device_name === name).length} backups
              </div>
            </button>
          ))}
          {deviceNames.length === 0 ? <div className="db-empty">No devices</div> : null}
        </div>
      </div>

      {showHistory ? (
        <div className="db-col">
          <div className="db-head">History</div>
          <div className="db-list">
            {filtered.map((s) => (
              <button
                key={s.snapshot_id}
                className={s.snapshot_id === snapshotId ? "db-item ui-item active" : "db-item ui-item"}
                onClick={() => {
                  setViewMode("snapshot");
                  onTabChange({ ...tab, state: { ...tab.state, snapshotId: s.snapshot_id, path: "" } });
                  setSnapshotEntries([]);
                  setSelected([]);
                  setLastSelIndex(null);
                  refreshSnapshotTree(s.snapshot_id, "");
                }}
              >
                <div className="db-title">{fmtUnix(s.created_unix)}</div>
                <div className="db-sub">
                  {s.root_path} · {s.snapshot_id}
                </div>
              </button>
            ))}
            {filtered.length === 0 ? <div className="db-empty">No history yet</div> : null}
          </div>
        </div>
      ) : null}

      <div className="db-col db-col-wide">
        <div className="db-head">
          Files
          <span className="db-head-right">
            <span className="db-meta">{snapshotLabel}</span>
            <span className="db-path">/{path || ""}</span>
            <input
              ref={uploadInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={async (e) => {
                const f = e.currentTarget.files?.[0];
                if (f) await uploadFile(f);
                // Reset so picking the same file again still triggers onChange.
                e.currentTarget.value = "";
              }}
            />
            <button
              className="db-mini"
              disabled={loading || !deviceName}
              onClick={() => uploadInputRef.current?.click()}
              title={
                deviceName
                  ? "Upload a local file into the latest backup"
                  : "Select a device first"
              }
            >
              UL
            </button>
            <button
              className="db-mini"
              onClick={() => setShowHistory((v) => {
                const next = !v;
                if (!next) setViewMode("all");
                return next;
              })}
              title="Toggle history list"
            >
              {showHistory ? "Hide" : "History"}
            </button>
            <button
              className="db-mini"
              disabled={loading || (viewMode === "snapshot" && !snapshotId)}
              onClick={() => {
                const up = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                if (viewMode === "snapshot") {
                  if (!snapshotId) return;
                  refreshSnapshotTree(snapshotId, up);
                  return;
                }
                if (tab.state.path !== up) {
                  onTabChange({ ...tab, state: { ...tab.state, path: up } });
                }
              }}
              title="Up"
            >
              Up
            </button>
            <input
              className="conn-input"
              style={{ width: 70 }}
              type="number"
              min={1}
              max={16}
              step={1}
              value={restoreConcurrency}
              disabled={loading}
              onChange={(e) => setRestoreConcurrency(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
              title="Restore concurrency (files in parallel)"
            />
            <button
              className="db-mini"
              disabled={!snapshotId || loading}
              onClick={async () => {
                if (!snapshotId) return;
                try {
                  const picked = await open({
                    directory: true,
                    multiple: false,
                    title: "Restore backup to folder"
                  });
                  if (!picked || Array.isArray(picked)) return;

                  setRestorePct(0);
                  setLoading(true);
                  setStatus(`restoring ${snapshotId} -> ${picked}`);

                  const tok = effSettings.token?.trim() ? effSettings.token.trim() : undefined;
                  const devId = effSettings.deviceId?.trim() ? effSettings.deviceId.trim() : undefined;
                  const devTok = effSettings.deviceToken?.trim() ? effSettings.deviceToken.trim() : undefined;

                  const resp = await restoreSnapshotToFolder(
                    {
                      server_base_url: effSettings.serverBaseUrl,
                      token: tok,
                      device_id: devId,
                      device_token: devTok,
                      snapshot_id: snapshotId,
                      dest_dir: picked,
                      concurrency: restoreConcurrency
                    },
                    (p: RestoreSnapshotProgress) => {
                      const pct =
                        p.total_bytes > 0 ? Math.floor((p.done_bytes / p.total_bytes) * 100) : 100;
                      setRestorePct(pct);
                      setStatus(`restore ${pct}%  [${p.done_files}/${p.total_files}]  ${p.path}`);
                    }
                  );

                  setRestorePct(100);
                  setStatus(`restored ${resp.total_files} files -> ${resp.dest_dir}`);
                } catch (e: any) {
                  setStatus(String(e?.message ?? e));
                } finally {
                  setLoading(false);
                }
              }}
              title="Restore the selected backup into a local folder"
            >
              RST{restorePct !== null ? ` ${restorePct}%` : ""}
            </button>
            <button
              className="db-mini"
              disabled={!snapshotId || !loading || restorePct === null}
              onClick={async () => {
                if (!snapshotId) return;
                try {
                  const ok = await cancelRestoreSnapshot(snapshotId);
                  setStatus(ok ? `cancel requested (${snapshotId})` : "no running restore found");
                } catch (e: any) {
                  setStatus(String(e?.message ?? e));
                }
              }}
              title="Cancel restore (stops scheduling new files; in-flight downloads finish)"
            >
              Cancel
            </button>
          </span>
        </div>

        <div
          className="db-tree"
          onDragOver={(e) => {
            const t = Array.from(e.dataTransfer.types);
            if (t.includes("application/x-filedock-file") || t.includes("application/x-filedock-sftp-file") || t.includes("Files"))
              e.preventDefault();
          }}
          onDrop={async (e) => {
            const rawSftp = e.dataTransfer.getData("application/x-filedock-sftp-file");
            const raw = e.dataTransfer.getData("application/x-filedock-file");
            if (rawSftp) {
              e.preventDefault();
              try {
                if (!deviceName) return;
                const parsed = JSON.parse(rawSftp) as any;
                const remotePath = String(parsed?.remotePath ?? "");
                const conn = parsed?.conn as SftpConn | undefined;
                const runner = parsed?.runner as PluginRunConfig | undefined;
                if (!remotePath || !conn) return;

                const base = remotePath.split("/").filter(Boolean).pop() || "file";
                const defaultDstPath = path ? `${path}/${base}` : base;
                const dst = prompt("Import to snapshot path (relative POSIX path)?", defaultDstPath);
                if (!dst) return;

                onEnqueueSftpToSnapshot({
                  runner,
                  conn,
                  remotePath,
                  dst: effConn,
                  dstDeviceName: deviceName || "device",
                  dstDeviceId: tab.state.deviceId || undefined,
                  dstPath: dst,
                  dstBaseSnapshotId: snapshotId || undefined,
                  conflictPolicy: "overwrite"
                });
                setStatus(`queued sftp import: ${remotePath} -> ${dst}`);
              } catch {
                // ignore
              }
              return;
            }

            if (raw) {
              e.preventDefault();
              try {
                const parsed = JSON.parse(raw) as {
                  kind?: "file" | "dir";
                  items?: { kind: "file" | "dir"; path: string; name: string; snapshotId?: string }[];
                  src: Conn;
                  snapshotId: string;
                  path: string;
                  name?: string;
                };
                if (!parsed?.src?.serverBaseUrl || !parsed.snapshotId || !parsed.path) return;

                if (Array.isArray(parsed.items) && parsed.items.length > 0) {
                  let files = 0;
                  let dirs = 0;
                  for (const it of parsed.items) {
                    if (!it?.path) continue;
                    const srcSnapshotId = it.snapshotId || parsed.snapshotId;
                    if (!srcSnapshotId) continue;
                    if (it.kind === "dir") {
                      const dstDirPath = path ? `${path}/${it.name}` : it.name;
                      onEnqueueCopyFolder({
                        src: parsed.src,
                        srcSnapshotId,
                        srcDirPath: it.path,
                        dst: effConn,
                        dstDeviceName: deviceName || "device",
                        dstDeviceId: tab.state.deviceId || undefined,
                        dstDirPath,
                        dstBaseSnapshotId: snapshotId || undefined
                      });
                      dirs++;
                    } else {
                      const dstPath = path ? `${path}/${it.name}` : it.name;
                      onEnqueueCopy({
                        src: parsed.src,
                        srcSnapshotId,
                        srcPath: it.path,
                        dst: effConn,
                        dstDeviceName: deviceName || "device",
                        dstDeviceId: tab.state.deviceId || undefined,
                        dstPath,
                        dstBaseSnapshotId: snapshotId || undefined
                      });
                      files++;
                    }
                  }
                  setStatus(`queued copy: ${files} files, ${dirs} dirs`);
                  return;
                }

                if ((parsed.kind ?? "file") === "dir") {
                  if (!parsed.snapshotId) return;
                  const dirName = parsed.name || parsed.path.split("/").pop() || "folder";
                  const dstDirPath = path ? `${path}/${dirName}` : dirName;
                  onEnqueueCopyFolder({
                    src: parsed.src,
                    srcSnapshotId: parsed.snapshotId,
                    srcDirPath: parsed.path,
                    dst: effConn,
                    dstDeviceName: deviceName || "device",
                    dstDeviceId: tab.state.deviceId || undefined,
                    dstDirPath,
                    dstBaseSnapshotId: snapshotId || undefined
                  });
                  setStatus(`queued copy dir: ${parsed.path} -> ${dstDirPath}`);
                } else {
                  // Drop means: copy file from source server into this destination server/device context.
                  // For MVP we create a new snapshot on destination (one-file manifest) under this device.
                  if (!parsed.snapshotId) return;
                  const fileName = parsed.name || parsed.path.split("/").pop() || "file";
                  const dstPath = path ? `${path}/${fileName}` : fileName;
                  onEnqueueCopy({
                    src: parsed.src,
                    srcSnapshotId: parsed.snapshotId,
                    srcPath: parsed.path,
                    dst: effConn,
                    dstDeviceName: deviceName || "device",
                    dstDeviceId: tab.state.deviceId || undefined,
                    dstPath,
                    dstBaseSnapshotId: snapshotId || undefined
                  });
                  setStatus(`queued copy: ${parsed.path} -> ${dstPath}`);
                }
              } catch {
                // ignore
              }
              return;
            }

            // Local file drop: upload into this device/path (one-file snapshot).
            const f = e.dataTransfer.files?.[0];
            if (!f || !deviceName) return;
            e.preventDefault();
            await uploadFile(f);
          }}
        >
          {(viewMode === "all" && mergedIndex.size === 0) || (viewMode === "snapshot" && !snapshotId) ? (
            <div className="db-empty">No backups yet. Upload a file to start.</div>
          ) : (
            <div className="db-tree-list">
              {items.map(({ e, idx, itemPath, itemSnapshotId }) => (
                <div key={`${e.kind}:${e.name}`} className="db-row">
                  <button
                    className={selectedSet.has(itemPath) ? "db-mini" : "db-mini"}
                    onClick={(ev) => toggleSelect(idx, itemPath, ev)}
                    title={selectedSet.has(itemPath) ? "Deselect" : "Select"}
                  >
                    {selectedSet.has(itemPath) ? "[x]" : "[ ]"}
                  </button>
                  <button
                    className={`db-row-main ui-item ${e.kind}${selectedSet.has(itemPath) ? " active" : ""}`}
                    draggable={viewMode === "snapshot" || e.kind === "file"}
                    onClick={() => {
                      if (e.kind !== "dir") return;
                      const next = path ? `${path}/${e.name}` : e.name;
                      if (viewMode === "snapshot") {
                        if (!snapshotId) return;
                        refreshSnapshotTree(snapshotId, next);
                        return;
                      }
                      if (tab.state.path !== next) {
                        onTabChange({ ...tab, state: { ...tab.state, path: next } });
                      }
                    }}
                    onDragStart={(ev) => {
                      if (viewMode === "all" && e.kind === "dir") return;
                      // If the dragged item is selected, drag the whole selection (current directory).
                      const wantMulti = selectedSet.has(itemPath) && selected.length > 1;
                      if (viewMode === "all" && !itemSnapshotId) return;
                      const entrySnapshotId = itemSnapshotId || snapshotId;
                      if (!entrySnapshotId) return;
                      const payload = wantMulti
                        ? JSON.stringify({
                            kind: e.kind,
                            items: selected
                              .map((p) => {
                                const found = items.find((x) => x.itemPath === p);
                                if (!found) return null;
                                if (viewMode === "all" && !found.itemSnapshotId) return null;
                                const foundSnapshotId = found.itemSnapshotId || snapshotId;
                                if (!foundSnapshotId) return null;
                                return {
                                  kind: found.e.kind,
                                  path: found.itemPath,
                                  name: found.e.name,
                                  snapshotId: foundSnapshotId
                                };
                              })
                              .filter((x): x is { kind: "file" | "dir"; path: string; name: string; snapshotId: string } => x !== null),
                            src: effConn,
                            snapshotId: entrySnapshotId,
                            path: itemPath,
                            name: e.name
                          })
                        : JSON.stringify({
                            kind: e.kind,
                            src: effConn,
                            snapshotId: entrySnapshotId,
                            path: itemPath,
                            name: e.name
                          });
                      ev.dataTransfer.effectAllowed = "copy";
                      ev.dataTransfer.setData("application/x-filedock-file", payload);
                      ev.dataTransfer.setData("text/plain", itemPath);
                    }}
                    title={e.name}
                  >
                    <span className="db-icon">{e.kind === "dir" ? "[D]" : "[F]"}</span>
                    <span className="db-row-name">{e.name}</span>
                  </button>

                  {e.kind === "file" ? (
                    <>
                      <button
                        className="db-mini"
                        onClick={() => {
                          const filePath = path ? `${path}/${e.name}` : e.name;
                          const fileSnapshotId = itemSnapshotId || snapshotId;
                          if (!fileSnapshotId) return;
                          onEnqueueDownload(fileSnapshotId, filePath, effConn);
                          setStatus(`queued ${filePath}`);
                        }}
                        title="Add to transfer queue"
                      >
                        +Q
                      </button>
                      <button
                        className="db-mini"
                        onClick={async () => {
                          const filePath = path ? `${path}/${e.name}` : e.name;
                          const fileSnapshotId = itemSnapshotId || snapshotId;
                          if (!fileSnapshotId) return;
                          try {
                            const blob = await apiGetBytes(
                              effSettings,
                              `/v1/snapshots/${encodeURIComponent(fileSnapshotId)}/file`,
                              { path: filePath }
                            );
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = e.name;
                            a.click();
                            URL.revokeObjectURL(url);
                            setStatus(`downloaded ${filePath}`);
                          } catch (err: any) {
                            setStatus(String(err?.message ?? err));
                          }
                        }}
                        title="Download"
                      >
                        DL
                      </button>
                    </>
                  ) : null}
                </div>
              ))}
              {displayEntries.length === 0 ? <div className="db-empty">Empty directory</div> : null}
            </div>
          )}
        </div>

        <div className="db-foot">
          <span className={loading ? "db-spin" : ""}>{loading ? "Loading..." : "Ready"}</span>
          <span className="db-status">{status}</span>
        </div>
      </div>
    </div>
  );
}
