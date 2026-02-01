import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../../../model/settings";
import { apiGetBytes, getTree, listSnapshots, type SnapshotMeta, type TreeEntry } from "../../../api/client";

function fmtUnix(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

export default function DeviceBrowserPane(props: { settings: Settings }) {
  const { settings } = props;

  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [deviceName, setDeviceName] = useState<string>("");
  const [snapshotId, setSnapshotId] = useState<string>("");

  const [path, setPath] = useState<string>("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);

  const devices = useMemo(() => {
    const names = Array.from(new Set(snapshots.map((s) => s.device_name))).sort();
    return names;
  }, [snapshots]);

  const filtered = useMemo(() => {
    return snapshots.filter((s) => (deviceName ? s.device_name === deviceName : true));
  }, [snapshots, deviceName]);

  const refreshSnapshots = async () => {
    setLoading(true);
    try {
      const s = await listSnapshots(settings);
      setSnapshots(s);
      if (!deviceName && s.length > 0) setDeviceName(s[0]!.device_name);
      setStatus(`snapshots: ${s.length}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Keep device selection valid if the device list changes.
    if (devices.length === 0) {
      setDeviceName("");
      return;
    }
    if (!deviceName) {
      setDeviceName(devices[0]!);
      return;
    }
    if (!devices.includes(deviceName)) {
      setDeviceName(devices[0]!);
    }
  }, [devices, deviceName]);

  const refreshTree = async (nextSnapshotId: string, nextPath: string) => {
    setLoading(true);
    try {
      const tr = await getTree(settings, nextSnapshotId, nextPath);
      setEntries(tr.entries);
      setPath(tr.path);
      setStatus(`tree: ${tr.entries.length}`);
    } catch (e: any) {
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshSnapshots();
  }, [settings.serverBaseUrl, settings.token]);

  return (
    <div className="device-browser">
      <div className="db-col">
        <div className="db-head">
          Devices
          <span className="db-head-right">
            <button className="db-mini" onClick={refreshSnapshots} disabled={loading} title="Refresh snapshots">
              Refresh
            </button>
          </span>
        </div>
        <div className="db-list">
          {devices.map((name) => (
            <button
              key={name}
              className={name === deviceName ? "db-item active" : "db-item"}
              onClick={() => {
                setDeviceName(name);
                setSnapshotId("");
                setEntries([]);
                setPath("");
              }}
            >
              <div className="db-title">{name}</div>
              <div className="db-sub">{filtered.filter((s) => s.device_name === name).length} snapshots</div>
            </button>
          ))}
          {devices.length === 0 ? <div className="db-empty">No devices (no snapshots)</div> : null}
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
                setSnapshotId(s.snapshot_id);
                setEntries([]);
                setPath("");
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
                    onClick={() => {
                      if (e.kind !== "dir") return;
                      const next = path ? `${path}/${e.name}` : e.name;
                      refreshTree(snapshotId, next);
                    }}
                    title={e.name}
                  >
                    <span className="db-icon">{e.kind === "dir" ? "[D]" : "[F]"}</span>
                    <span className="db-row-name">{e.name}</span>
                  </button>

                  {e.kind === "file" ? (
                    <button
                      className="db-mini"
                      onClick={async () => {
                        const filePath = path ? `${path}/${e.name}` : e.name;
                        try {
                          const blob = await apiGetBytes(settings, `/v1/snapshots/${encodeURIComponent(snapshotId)}/file`, {
                            path: filePath
                          });
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
