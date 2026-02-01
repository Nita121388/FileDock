import { useMemo } from "react";

type Job = {
  id: string;
  from: string;
  to: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number; // 0..1
};

export default function TransferQueuePane() {
  // UI shell: mock queue.
  const jobs: Job[] = useMemo(
    () => [
      { id: "xfer_001", from: "Laptop:/Photos", to: "NAS:/backup/Photos", status: "running", progress: 0.38 },
      { id: "xfer_002", from: "Desktop:/Projects", to: "NAS:/backup/Projects", status: "queued", progress: 0.0 },
      { id: "xfer_003", from: "Laptop:/Docs", to: "NAS:/backup/Docs", status: "done", progress: 1.0 }
    ],
    []
  );

  return (
    <div className="queue">
      {jobs.map((j) => (
        <div key={j.id} className="queue-row">
          <div className="queue-main">
            <div className="queue-title">
              <span className="accent">{j.id}</span> {j.from} → {j.to}
            </div>
            <div className="queue-sub">
              <span className={`pill pill-${j.status}`}>{j.status}</span>
              <span>{Math.round(j.progress * 100)}%</span>
            </div>
          </div>
          <div className="queue-bar">
            <div className="queue-bar-fill" style={{ width: `${j.progress * 100}%` }} />
          </div>
        </div>
      ))}
      <div className="queue-hint">
        Drag files between panes to create transfers (next milestone).
      </div>
    </div>
  );
}

