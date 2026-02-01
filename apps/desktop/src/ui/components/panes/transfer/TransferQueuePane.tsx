import type { TransferJob } from "../../../model/transfers";

export default function TransferQueuePane(props: {
  transfers: TransferJob[];
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../../model/transfers").Conn) => void;
  onRemove: (id: string) => void;
  onRun: (id: string) => Promise<void>;
}) {
  const { transfers, onEnqueueDownload, onRemove, onRun } = props;

  return (
    <div
      className="queue"
      onDragOver={(e) => {
        // Accept file items dragged from Device Browser.
        const t = Array.from(e.dataTransfer.types);
        if (t.includes("application/x-filedock-file")) e.preventDefault();
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-filedock-file");
        if (!raw) return;
        e.preventDefault();
        try {
          const parsed = JSON.parse(raw) as any;
          // New format: { src: Conn, snapshotId, path }
          if (parsed?.src && parsed.snapshotId && parsed.path) {
            onEnqueueDownload(parsed.snapshotId, parsed.path, parsed.src);
            return;
          }
          // Legacy format: { snapshotId, path }
          if (parsed?.snapshotId && parsed?.path) {
            onEnqueueDownload(parsed.snapshotId, parsed.path);
          }
        } catch {
          // ignore
        }
      }}
    >
      {transfers.length === 0 ? (
        <div className="db-empty">No transfers yet. Queue a file from Device Browser (+Q).</div>
      ) : null}

      {transfers.map((j) => (
        <div key={j.id} className="queue-row">
          <div className="queue-main">
            <div className="queue-title">
              <span className="accent">{j.id}</span>{" "}
              {j.kind === "download" ? (
                <span className="queue-path">
                  dl {j.snapshotId}:{j.path}
                </span>
              ) : (
                <span className="queue-path">
                  copy {j.src.serverBaseUrl} {j.srcSnapshotId}:{j.srcPath} → {j.dst.serverBaseUrl} {j.dstPath}
                </span>
              )}
            </div>
            <div className="queue-sub">
              <span className={`pill pill-${j.status}`}>{j.status}</span>
              {j.error ? <span className="queue-err">{j.error}</span> : null}
            </div>
          </div>

          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={j.status === "done"}
              onClick={() => onRun(j.id)}
              title="Run transfer"
            >
              Run
            </button>
            <button className="db-mini" onClick={() => onRemove(j.id)} title="Remove">
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="queue-hint">
        Next: drag files between panes to create cross-device transfers.
      </div>
    </div>
  );
}
