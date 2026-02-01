import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaneTab } from "../../../model/layout";
import type { Settings } from "../../../model/settings";
import {
  apiGetBytes,
  getTree,
  listDevices,
  listSnapshots,
  registerDevice,
  type DeviceInfo,
  type SnapshotMeta,
  type TreeEntry
} from "../../../api/client";

type DeviceTab = Extract<PaneTab, { pane: "deviceBrowser" }>;

function fmtUnix(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16);
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
  onEnqueueDownload: (snapshotId: string, path: string) => void;
}) {
  const { settings, tab, onTabChange, onEnqueueDownload } = props;

  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [devicesApi, setDevicesApi] = useState<DeviceInfo[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [loadedKey, setLoadedKey] = useState<string>("");

  const deviceName = tab.state.deviceName;
  const snapshotId = tab.state.snapshotId;
  const path = tab.state.path;

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
      const ds = await listDevices(settings);
      setDevicesApi(ds);
      setStatus((prev) => prev || `devices: ${ds.length}`);
    } catch (e: any) {
      // Device registry may be unused; keep it non-fatal.
      setDevicesApi([]);
      setStatus(String(e?.message ?? e));
    }
  }, [settings]);

  const refreshSnapshots = useCallback(async () => {
    setLoading(true);
    try {
      const s = await listSnapshots(settings);
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
  }, [deviceName, onTabChange, settings, tab]);

  const refreshTree = useCallback(async (nextSnapshotId: string, nextPath: string) => {
    setLoading(true);
    try {
      const tr = await getTree(settings, nextSnapshotId, nextPath);
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
  }, [onTabChange, settings, tab]);

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
  }, [path, refreshDevices, refreshSnapshots, refreshTree, settings.serverBaseUrl, settings.token, snapshotId]);

  useEffect(() => {
    // When switching pane tabs, sync the tree view to the tab state.
    if (!snapshotId) {
      setEntries([]);
      setLoadedKey("");
      return;
    }
    const wantKey = `${snapshotId}::${path}`;
    if (wantKey !== loadedKey) {
      setEntries([]);
      refreshTree(snapshotId, path);
    }
  }, [loadedKey, path, refreshTree, snapshotId]);

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
                const resp = await registerDevice(settings, { device_name: regName.trim(), os: regOs.trim() });
                setStatus(`registered ${regName.trim()} (id=${resp.device_id}) token=${resp.device_token}`);
                await refreshDevices();
                onTabChange({ ...tab, state: { ...tab.state, deviceName: regName.trim() } });
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
          </span>
        </div>

        <div className="db-tree">
          {!snapshotId ? (
            <div className="db-empty">Select a snapshot to browse</div>
          ) : (
            <div className="db-tree-list">
              {entries.map((e) => (
                <div key={`${e.kind}:${e.name}`} className="db-row">
                  <button
                    className={e.kind === "dir" ? "db-row-main dir" : "db-row-main file"}
                    draggable={e.kind === "file"}
                    onClick={() => {
                      if (e.kind !== "dir") return;
                      const next = path ? `${path}/${e.name}` : e.name;
                      refreshTree(snapshotId, next);
                    }}
                    onDragStart={(ev) => {
                      if (e.kind !== "file") return;
                      const filePath = path ? `${path}/${e.name}` : e.name;
                      const payload = JSON.stringify({ snapshotId, path: filePath, name: e.name });
                      ev.dataTransfer.effectAllowed = "copy";
                      ev.dataTransfer.setData("application/x-filedock-file", payload);
                      ev.dataTransfer.setData("text/plain", filePath);
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
                          onEnqueueDownload(snapshotId, filePath);
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
                              settings,
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
