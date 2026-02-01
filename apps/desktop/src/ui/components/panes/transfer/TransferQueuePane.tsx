import type { TransferJob } from "../../../model/transfers";
import { useEffect, useMemo, useRef, useState } from "react";

const QUEUE_KEY = "filedock.desktop.queue.v1";

type QueueSettings = {
  concurrency: number;
  paused: boolean;
  autoRun: boolean;
  maxMBps: number;
  copyFolderFileConcurrency: number;
};

function loadQueueSettings(): QueueSettings {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return { concurrency: 2, paused: false, autoRun: false, maxMBps: 0, copyFolderFileConcurrency: 4 };
    const parsed = JSON.parse(raw) as any;
    const concurrency = Number(parsed?.concurrency);
    const paused = Boolean(parsed?.paused);
    const autoRun = Boolean(parsed?.autoRun);
    const maxMBps = Number(parsed?.maxMBps);
    const copyFolderFileConcurrency = Number(parsed?.copyFolderFileConcurrency);
    return {
      concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? Math.min(8, Math.floor(concurrency)) : 2,
      paused,
      autoRun,
      maxMBps: Number.isFinite(maxMBps) && maxMBps >= 0 ? Math.min(2048, maxMBps) : 0,
      copyFolderFileConcurrency:
        Number.isFinite(copyFolderFileConcurrency) && copyFolderFileConcurrency >= 1
          ? Math.min(8, Math.floor(copyFolderFileConcurrency))
          : 4
    };
  } catch {
    return { concurrency: 2, paused: false, autoRun: false, maxMBps: 0, copyFolderFileConcurrency: 4 };
  }
}

function saveQueueSettings(next: QueueSettings) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export default function TransferQueuePane(props: {
  transfers: TransferJob[];
  onUpdateTransfer: (id: string, updates: Partial<TransferJob>) => void;
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../../model/transfers").Conn) => void;
  onRemove: (id: string) => void;
  onRun: (id: string) => Promise<void>;
  onCancel: (id: string) => void;
}) {
  const { transfers, onUpdateTransfer, onEnqueueDownload, onRemove, onRun, onCancel } = props;
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueSettings>(() => loadQueueSettings());
  const pausedRef = useRef(queue.paused);
  const busyRef = useRef(busy);

  useEffect(() => {
    pausedRef.current = queue.paused;
    saveQueueSettings(queue);
  }, [queue]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const counts = useMemo(() => {
    return {
      queued: transfers.filter((x) => x.status === "queued").length,
      running: transfers.filter((x) => x.status === "running").length,
      failed: transfers.filter((x) => x.status === "failed").length,
      done: transfers.filter((x) => x.status === "done").length
    };
  }, [transfers]);

  const runAll = async (mode: "queued" | "failed" | "all") => {
    if (busyRef.current) return;
    if (queue.paused) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const ids = transfers
        .filter((j) => {
          if (j.status === "running") return false;
          if (mode === "queued") return j.status === "queued";
          if (mode === "failed") return j.status === "failed";
          return j.status === "queued" || j.status === "failed";
        })
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((j) => j.id);

      const limit = Math.max(1, Math.min(8, Math.floor(queue.concurrency || 1)));
      let next = 0;

      // MVP: "pause" stops scheduling new jobs; current running jobs finish.
      const worker = async () => {
        while (true) {
          if (pausedRef.current) return;
          const i = next++;
          if (i >= ids.length) return;
          await onRun(ids[i]!);
        }
      };

      const workers = Array.from({ length: Math.min(limit, ids.length) }, () => worker());
      await Promise.all(workers);
    } finally {
      setBusy(false);
      busyRef.current = false;
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
                {counts.queued} queued
              </span>
              <span className="pill pill-running">
                {counts.running} running
              </span>
              <span className="pill pill-failed">
                {counts.failed} failed
              </span>
              <span className="pill pill-done">
                {counts.done} done
              </span>
              <span className="queue-path">concurrency</span>
              <input
                className="conn-input"
                style={{ width: 70 }}
                type="number"
                min={1}
                max={8}
                step={1}
                value={queue.concurrency}
                disabled={busy}
                onChange={(e) =>
                  setQueue((q) => ({ ...q, concurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) }))
                }
                title="Max concurrent jobs"
              />
              <span className="queue-path">MB/s</span>
              <input
                className="conn-input"
                style={{ width: 80 }}
                type="number"
                min={0}
                step={1}
                value={queue.maxMBps}
                disabled={busy}
                onChange={(e) => setQueue((q) => ({ ...q, maxMBps: Math.max(0, Number(e.target.value) || 0) }))}
                title="Bandwidth limit (0 = unlimited). Applied by the desktop client."
              />
              <span className="queue-path">copy-folder</span>
              <input
                className="conn-input"
                style={{ width: 70 }}
                type="number"
                min={1}
                max={8}
                step={1}
                value={queue.copyFolderFileConcurrency}
                disabled={busy}
                onChange={(e) =>
                  setQueue((q) => ({
                    ...q,
                    copyFolderFileConcurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1))
                  }))
                }
                title="Max concurrent files within a copy-folder job"
              />
            </div>
          </div>
          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={busy || counts.running > 0}
              onClick={() => setQueue((q) => ({ ...q, paused: !q.paused }))}
              title={queue.paused ? "Resume scheduling" : "Pause scheduling (running jobs will finish)"}
            >
              {queue.paused ? "Resume" : "Pause"}
            </button>
            <button
              className="db-mini"
              disabled={busy}
              onClick={() => setQueue((q) => ({ ...q, autoRun: !q.autoRun }))}
              title={queue.autoRun ? "Disable auto-run" : "Auto-run queued jobs when possible"}
            >
              {queue.autoRun ? "Auto: ON" : "Auto: OFF"}
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("queued")} title="Run queued">
              Run queued
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("failed")} title="Retry failed">
              Retry failed
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("all")} title="Run all pending">
              Run all
            </button>
            <button className="db-mini" disabled={busy} onClick={clearDone} title="Clear done">
              Clear done
            </button>
          </div>
        </div>
      ) : null}

      {queue.autoRun && !queue.paused && !busy && counts.queued > 0 && counts.running < queue.concurrency ? (
        // Kick off queued transfers automatically.
        // Note: we render a placeholder node to run an effect below without extra state.
        <AutoRunner onTick={() => runAll("queued")} />
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
              ) : j.kind === "copy_file" ? (
                <span className="queue-path">
                  copy {j.src.serverBaseUrl} {j.srcSnapshotId}:{j.srcPath} → {j.dst.serverBaseUrl} {j.dstPath}
                </span>
              ) : (
                <span className="queue-path">
                  copy-dir {j.src.serverBaseUrl} {j.srcSnapshotId}:{j.srcDirPath || "/"} → {j.dst.serverBaseUrl}{" "}
                  {j.dstDirPath || "/"}
                </span>
              )}
            </div>
            <div className="queue-sub">
              <span className={`pill pill-${j.status}`}>{j.status}</span>
              {j.progress?.phase ? <span className="queue-path">{j.progress.phase}</span> : null}
              {typeof j.progress?.pct === "number" ? (
                <span className="pill pill-running">{j.progress.pct}%</span>
              ) : null}
              {j.kind === "copy_file" || j.kind === "copy_folder" ? (
                <>
                  {j.dstBaseSnapshotId ? (
                    <span className="queue-path">base:{String(j.dstBaseSnapshotId).slice(0, 8)}</span>
                  ) : null}
                  <select
                    className="pane-select"
                    style={{ height: 28 }}
                    disabled={busy || queue.paused || j.status === "running" || j.status === "done"}
                    value={j.conflictPolicy ?? "overwrite"}
                    onChange={(e) =>
                      onUpdateTransfer(j.id, {
                        conflictPolicy: e.target.value as any
                      })
                    }
                    title="Conflict policy when destination already has the same path"
                  >
                    <option value="overwrite">overwrite</option>
                    <option value="skip">skip</option>
                    <option value="rename">rename</option>
                  </select>
                </>
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
              disabled={busy || queue.paused || j.status === "done" || j.status === "running"}
              onClick={() => onRun(j.id)}
              title="Run transfer"
            >
              Run
            </button>
            {j.status === "running" ? (
              <button className="db-mini danger" onClick={() => onCancel(j.id)} title="Cancel">
                Cancel
              </button>
            ) : null}
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

function AutoRunner(props: { onTick: () => void }) {
  const { onTick } = props;
  useEffect(() => {
    // Schedule after paint to avoid re-entrancy during render.
    const t = window.setTimeout(() => onTick(), 0);
    return () => window.clearTimeout(t);
  }, [onTick]);
  return null;
}
