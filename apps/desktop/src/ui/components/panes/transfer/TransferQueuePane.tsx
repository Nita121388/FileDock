import type { TransferJob } from "../../../model/transfers";
import { useState } from "react";

export default function TransferQueuePane(props: {
  transfers: TransferJob[];
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../../model/transfers").Conn) => void;
  onRemove: (id: string) => void;
  onRun: (id: string) => Promise<void>;
}) {
  const { transfers, onEnqueueDownload, onRemove, onRun } = props;
  const [busy, setBusy] = useState(false);

  const runAll = async (mode: "queued" | "failed" | "all") => {
    if (busy) return;
    setBusy(true);
    try {
      const ids = transfers
        .filter((j) => {
          if (j.status === "running") return false;
          if (mode === "queued") return j.status === "queued";
          if (mode === "failed") return j.status === "failed";
          return j.status === "queued" || j.status === "failed";
        })
        .map((j) => j.id);

      // MVP: sequential execution keeps UI predictable and avoids overloading the server.
      for (const id of ids) {
        await onRun(id);
      }
    } finally {
      setBusy(false);
    }
  };

  const clearDone = () => {
    for (const j of transfers) {
      if (j.status === "done") onRemove(j.id);
    }
  };

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

      {transfers.length > 0 ? (
        <div className="queue-row" style={{ justifyContent: "space-between" }}>
          <div className="queue-main">
            <div className="queue-title">Queue</div>
            <div className="queue-sub">
              <span className="pill pill-queued">
                {transfers.filter((x) => x.status === "queued").length} queued
              </span>
              <span className="pill pill-running">
                {transfers.filter((x) => x.status === "running").length} running
              </span>
              <span className="pill pill-failed">
                {transfers.filter((x) => x.status === "failed").length} failed
              </span>
              <span className="pill pill-done">
                {transfers.filter((x) => x.status === "done").length} done
              </span>
            </div>
          </div>
          <div className="queue-actions">
            <button className="db-mini" disabled={busy} onClick={() => runAll("queued")} title="Run queued">
              Run queued
            </button>
            <button className="db-mini" disabled={busy} onClick={() => runAll("failed")} title="Retry failed">
              Retry failed
            </button>
            <button className="db-mini" disabled={busy} onClick={() => runAll("all")} title="Run all pending">
              Run all
            </button>
            <button className="db-mini" disabled={busy} onClick={clearDone} title="Clear done">
              Clear done
            </button>
          </div>
        </div>
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
              {j.progress?.phase ? <span className="queue-path">{j.progress.phase}</span> : null}
              {typeof j.progress?.pct === "number" ? (
                <span className="pill pill-running">{j.progress.pct}%</span>
              ) : null}
              {j.error ? <span className="queue-err">{j.error}</span> : null}
            </div>
            {typeof j.progress?.pct === "number" ? (
              <div className="queue-bar" aria-label="progress">
                <div className="queue-bar-fill" style={{ width: `${Math.max(0, Math.min(100, j.progress.pct))}%` }} />
              </div>
            ) : null}
          </div>

          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={busy || j.status === "done" || j.status === "running"}
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
