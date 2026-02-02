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
  getTree,
  listDevices,
  listSnapshots,
  putChunk,
  putManifest,
  registerDevice,
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
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loadedKey, setLoadedKey] = useState<string>("");
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [lastSelIndex, setLastSelIndex] = useState<number | null>(null);
  const [restorePct, setRestorePct] = useState<number | null>(null);
  const [restoreConcurrency, setRestoreConcurrency] = useState<number>(() => loadRestoreConcurrency());

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
    return snapshots.filter((s) => (deviceName ? s.device_name === deviceName : true));
  }, [snapshots, deviceName]);

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
      setStatus(`snapshots: ${s.length}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [deviceName, effSettings, onTabChange, tab]);

  const refreshTree = useCallback(async (nextSnapshotId: string, nextPath: string) => {
    setLoading(true);
    try {
      const tr = await getTree(effSettings, nextSnapshotId, nextPath);
      setEntries(tr.entries);
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
    refreshDevices();
    refreshSnapshots();
    // If we already have a selected snapshot, try to refresh the tree too.
    if (snapshotId) refreshTree(snapshotId, path);
  }, [path, refreshDevices, refreshSnapshots, refreshTree, effSettings.serverBaseUrl, effSettings.token, effSettings.deviceId, effSettings.deviceToken, snapshotId]);

  useEffect(() => {
    // When switching pane tabs, sync the tree view to the tab state.
    if (!snapshotId) {
      setEntries([]);
      setLoadedKey("");
      setSelected([]);
      setLastSelIndex(null);
      return;
    }
    const wantKey = `${snapshotId}::${path}`;
    if (wantKey !== loadedKey) {
      setEntries([]);
      setSelected([]);
      setLastSelIndex(null);
      refreshTree(snapshotId, path);
    }
  }, [loadedKey, path, refreshTree, snapshotId]);

  const items = useMemo(() => {
    return entries.map((e, idx) => {
      const itemPath = path ? `${path}/${e.name}` : e.name;
      return { e, idx, itemPath };
    });
  }, [entries, path]);

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

        // Create a one-file snapshot manifest on destination.
        const now = Math.floor(Date.now() / 1000);
        const snap = await createSnapshot(effSettings, {
          device_name: deviceName,
          device_id: tab.state.deviceId?.trim() ? tab.state.deviceId.trim() : null,
          root_path: "(upload)"
        });
        const dstPath = path ? `${path}/${file.name}` : file.name;
        await putManifest(effSettings, snap.snapshot_id, {
          snapshot_id: snap.snapshot_id,
          created_unix: now,
          files: [
            {
              path: dstPath,
              size: file.size,
              mtime_unix: now,
              chunk_hash: null,
              chunks: manifestChunks
            }
          ]
        });

        setStatus(`uploaded ${file.name} -> /${dstPath} (snapshot ${snap.snapshot_id})`);
        await refreshSnapshots();

        // Jump into the new snapshot at the current directory.
        onTabChange({ ...tab, state: { ...tab.state, snapshotId: snap.snapshot_id } });
        await refreshTree(snap.snapshot_id, path);
      } catch (e: any) {
        setStatus(String(e?.message ?? e));
      } finally {
        setLoading(false);
      }
    },
    [deviceName, effSettings, onTabChange, path, refreshSnapshots, refreshTree, tab]
  );

  return (
    <div className="device-browser">
      <div className="db-col">
        <div className="db-head">
          Devices
          <span className="db-head-right">
            <button className="db-mini" onClick={refreshDevices} disabled={loading} title="Refresh devices">
              Devices
            </button>
            <button className="db-mini" onClick={refreshSnapshots} disabled={loading} title="Refresh snapshots">
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
              className={name === deviceName ? "db-item active" : "db-item"}
              onClick={() => {
                onTabChange({ ...tab, state: { ...tab.state, deviceName: name, snapshotId: "", path: "" } });
                setEntries([]);
              }}
            >
              <div className="db-title">{name}</div>
              <div className="db-sub">
                {deviceByName.get(name)?.os ? `${deviceByName.get(name)!.os} · ` : ""}
                {deviceByName.get(name)?.last_seen_unix
                  ? `seen ${fmtLastSeen(deviceByName.get(name)!.last_seen_unix)} · `
                  : ""}
                {snapshots.filter((s) => s.device_name === name).length} snapshots
              </div>
            </button>
          ))}
          {deviceNames.length === 0 ? <div className="db-empty">No devices</div> : null}
        </div>
      </div>

      <div className="db-col">
        <div className="db-head">Snapshots</div>
        <div className="db-list">
          {filtered.map((s) => (
            <button
              key={s.snapshot_id}
              className={s.snapshot_id === snapshotId ? "db-item active" : "db-item"}
              onClick={() => {
                onTabChange({ ...tab, state: { ...tab.state, snapshotId: s.snapshot_id, path: "" } });
                setEntries([]);
                refreshTree(s.snapshot_id, "");
              }}
            >
              <div className="db-title">{s.snapshot_id}</div>
              <div className="db-sub">
                {fmtUnix(s.created_unix)} · {s.root_path}
              </div>
            </button>
          ))}
          {filtered.length === 0 ? <div className="db-empty">No snapshots</div> : null}
        </div>
      </div>

      <div className="db-col db-col-wide">
        <div className="db-head">
          Tree
          <span className="db-head-right">
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
                  ? "Upload a local file into this device/path (creates a new snapshot)"
                  : "Select a device first"
              }
            >
              UL
            </button>
            <button
              className="db-mini"
              disabled={!snapshotId || loading}
              onClick={() => {
                if (!snapshotId) return;
                const up = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                refreshTree(snapshotId, up);
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
                    title: "Restore snapshot to folder"
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
              title="Restore the selected snapshot into a local folder"
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
                  items?: { kind: "file" | "dir"; path: string; name: string }[];
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
                    if (it.kind === "dir") {
                      const dstDirPath = path ? `${path}/${it.name}` : it.name;
                      onEnqueueCopyFolder({
                        src: parsed.src,
                        srcSnapshotId: parsed.snapshotId,
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
                        srcSnapshotId: parsed.snapshotId,
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
          {!snapshotId ? (
            <div className="db-empty">Select a snapshot to browse</div>
          ) : (
            <div className="db-tree-list">
              {items.map(({ e, idx, itemPath }) => (
                <div key={`${e.kind}:${e.name}`} className="db-row">
                  <button
                    className={selectedSet.has(itemPath) ? "db-mini" : "db-mini"}
                    onClick={(ev) => toggleSelect(idx, itemPath, ev)}
                    title={selectedSet.has(itemPath) ? "Deselect" : "Select"}
                  >
                    {selectedSet.has(itemPath) ? "[x]" : "[ ]"}
                  </button>
                  <button
                    className={e.kind === "dir" ? "db-row-main dir" : "db-row-main file"}
                    draggable={true}
                    onClick={() => {
                      if (e.kind !== "dir") return;
                      const next = path ? `${path}/${e.name}` : e.name;
                      refreshTree(snapshotId, next);
                    }}
                    onDragStart={(ev) => {
                      // If the dragged item is selected, drag the whole selection (current directory).
                      const wantMulti = selectedSet.has(itemPath) && selected.length > 1;
                      const payload = wantMulti
                        ? JSON.stringify({
                            kind: e.kind,
                            items: selected
                              .map((p) => {
                                const found = items.find((x) => x.itemPath === p);
                                if (!found) return null;
                                return { kind: found.e.kind, path: found.itemPath, name: found.e.name };
                              })
                              .filter((x): x is { kind: "file" | "dir"; path: string; name: string } => x !== null),
                            src: effConn,
                            snapshotId,
                            path: itemPath,
                            name: e.name
                          })
                        : JSON.stringify({
                            kind: e.kind,
                            src: effConn,
                            snapshotId,
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
                          onEnqueueDownload(snapshotId, filePath, effConn);
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
                          try {
                            const blob = await apiGetBytes(
                              effSettings,
                              `/v1/snapshots/${encodeURIComponent(snapshotId)}/file`,
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
              {entries.length === 0 ? <div className="db-empty">Empty directory</div> : null}
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
