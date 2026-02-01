import { useMemo, useState } from "react";

type Device = { id: string; name: string; os: string };
type Snapshot = { id: string; deviceId: string; created: string };

export default function DeviceBrowserPane() {
  // UI shell: mock data for layout + interaction. Real data will come from the server API.
  const devices: Device[] = useMemo(
    () => [
      { id: "dev-laptop", name: "Laptop", os: "Windows" },
      { id: "dev-desktop", name: "Desktop", os: "Linux" },
      { id: "dev-nas", name: "NAS", os: "Linux" }
    ],
    []
  );

  const snapshots: Snapshot[] = useMemo(
    () => [
      { id: "snap_a1b2", deviceId: "dev-laptop", created: "2026-02-01 00:12" },
      { id: "snap_c3d4", deviceId: "dev-laptop", created: "2026-01-31 22:40" },
      { id: "snap_e5f6", deviceId: "dev-nas", created: "2026-02-01 00:20" }
    ],
    []
  );

  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [snapshotId, setSnapshotId] = useState<string>("");

  const visibleSnaps = snapshots.filter((s) => s.deviceId === deviceId);

  return (
    <div className="device-browser">
      <div className="db-col">
        <div className="db-head">Devices</div>
        <div className="db-list">
          {devices.map((d) => (
            <button
              key={d.id}
              className={d.id === deviceId ? "db-item active" : "db-item"}
              onClick={() => {
                setDeviceId(d.id);
                setSnapshotId("");
              }}
            >
              <div className="db-title">{d.name}</div>
              <div className="db-sub">{d.os}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="db-col">
        <div className="db-head">Snapshots</div>
        <div className="db-list">
          {visibleSnaps.map((s) => (
            <button
              key={s.id}
              className={s.id === snapshotId ? "db-item active" : "db-item"}
              onClick={() => setSnapshotId(s.id)}
            >
              <div className="db-title">{s.id}</div>
              <div className="db-sub">{s.created}</div>
            </button>
          ))}
          {visibleSnaps.length === 0 ? <div className="db-empty">No snapshots</div> : null}
        </div>
      </div>

      <div className="db-col db-col-wide">
        <div className="db-head">Tree</div>
        <div className="db-tree">
          {snapshotId ? (
            <div className="db-empty">
              Tree view placeholder for <span className="accent">{snapshotId}</span>
            </div>
          ) : (
            <div className="db-empty">Select a snapshot to browse</div>
          )}
        </div>
      </div>
    </div>
  );
}

