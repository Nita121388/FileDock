import type { TransferJob } from "../../../model/transfers";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { saveDialog } from "../../../api/dialog";
import type { PluginRunConfig, SftpConn } from "../../../model/transfers";
import { onPaneCommand } from "../../../commandBus";
import { useTranslation } from "react-i18next";

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
  paneId: string;
  transfers: TransferJob[];
  onUpdateTransfer: (id: string, updates: Partial<TransferJob>) => void;
  onEnqueueDownload: (snapshotId: string, path: string, conn?: import("../../../model/transfers").Conn) => void;
  onEnqueueSftpDownload: (job: { runner?: PluginRunConfig; conn: SftpConn; remotePath: string; localPath: string }) => void;
  onEnqueueSftpUpload: (job: {
    runner?: PluginRunConfig;
    conn: SftpConn;
    localPath: string;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
  onRemove: (id: string) => void;
  onRun: (id: string) => Promise<void>;
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation();
  const {
    paneId,
    transfers,
    onUpdateTransfer,
    onEnqueueDownload,
    onEnqueueSftpDownload,
    onRemove,
    onRun,
    onCancel
  } = props;
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueSettings>(() => loadQueueSettings());
  const [selected, setSelected] = useState<string[]>([]);
  const [lastSelIndex, setLastSelIndex] = useState<number | null>(null);
  const pausedRef = useRef(queue.paused);
  const busyRef = useRef(busy);

  useEffect(() => {
    pausedRef.current = queue.paused;
    saveQueueSettings(queue);
  }, [queue]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    setSelected((prev) => prev.filter((id) => transfers.some((t) => t.id === id)));
  }, [transfers]);

  const counts = useMemo(() => {
    return {
      queued: transfers.filter((x) => x.status === "queued").length,
      running: transfers.filter((x) => x.status === "running").length,
      failed: transfers.filter((x) => x.status === "failed").length,
      done: transfers.filter((x) => x.status === "done").length
    };
  }, [transfers]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleSelect = (idx: number, id: string, ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();

    setSelected((prev) => {
      const prevSet = new Set(prev);
      const shift = ev.shiftKey;
      const multi = ev.ctrlKey || ev.metaKey;

      if (shift && lastSelIndex !== null) {
        const a = Math.min(lastSelIndex, idx);
        const b = Math.max(lastSelIndex, idx);
        for (let i = a; i <= b; i++) prevSet.add(transfers[i]!.id);
        return Array.from(prevSet);
      }

      if (multi) {
        if (prevSet.has(id)) prevSet.delete(id);
        else prevSet.add(id);
        return Array.from(prevSet);
      }

      if (prevSet.size === 1 && prevSet.has(id)) return prev;
      return [id];
    });

    setLastSelIndex(idx);
  };

  const clearSelection = () => {
    setSelected([]);
    setLastSelIndex(null);
  };

  const selectFailed = () => {
    const ids = transfers.filter((t) => t.status === "failed").map((t) => t.id);
    setSelected(ids);
    setLastSelIndex(ids.length > 0 ? ids.length - 1 : null);
  };

  const selectQueued = () => {
    const ids = transfers.filter((t) => t.status === "queued").map((t) => t.id);
    setSelected(ids);
    setLastSelIndex(ids.length > 0 ? ids.length - 1 : null);
  };

  const runSelected = async () => {
    if (busyRef.current || queue.paused) return;
    const ids = selected.filter((id) => {
      const j = transfers.find((t) => t.id === id);
      return j && j.status !== "running" && j.status !== "done";
    });
    for (const id of ids) {
      await onRun(id);
    }
  };

  const cancelSelected = () => {
    for (const id of selected) {
      const j = transfers.find((t) => t.id === id);
      if (j?.status === "running") onCancel(id);
    }
  };

  const removeSelected = () => {
    for (const id of selected) onRemove(id);
    clearSelection();
  };

  useEffect(() => {
    return onPaneCommand((cmd) => {
      if (cmd.paneId !== paneId) return;
      switch (cmd.kind) {
        case "queue.runSelected":
          void runSelected();
          return;
        case "queue.cancelSelected":
          cancelSelected();
          return;
        case "queue.removeSelected":
          removeSelected();
          return;
        case "queue.selectFailed":
          selectFailed();
          return;
        case "queue.selectQueued":
          selectQueued();
          return;
        case "queue.clearSelection":
          clearSelection();
          return;
        default:
          return;
      }
    });
  }, [
    cancelSelected,
    clearSelection,
    paneId,
    queue.paused,
    removeSelected,
    runSelected,
    selectFailed,
    selectQueued,
    selected,
    transfers
  ]);

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
        if (t.includes("application/x-filedock-file") || t.includes("application/x-filedock-sftp-file")) e.preventDefault();
      }}
      onDrop={(e) => {
        const rawSftp = e.dataTransfer.getData("application/x-filedock-sftp-file");
        const raw = e.dataTransfer.getData("application/x-filedock-file");
        if (!raw && !rawSftp) return;
        e.preventDefault();
        if (rawSftp) {
          void (async () => {
            try {
              const parsed = JSON.parse(rawSftp) as any;
              const remotePath = String(parsed?.remotePath ?? "");
              const conn = parsed?.conn as SftpConn | undefined;
              const runner = parsed?.runner as PluginRunConfig | undefined;
              if (!remotePath || !conn) return;
              const base = remotePath.split("/").filter(Boolean).pop() || "download";
              const dest = await saveDialog({ defaultPath: base });
              if (!dest) return;
              onEnqueueSftpDownload({ runner, conn, remotePath, localPath: dest });
            } catch {
              // ignore
            }
          })();
          return;
        }

        if (raw) {
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
        }
      }}
    >
      {transfers.length === 0 ? (
        <div className="db-empty">{t("queue.empty")}</div>
      ) : null}

      {transfers.length > 0 ? (
        <div className="queue-row" style={{ justifyContent: "space-between" }}>
          <div className="queue-main">
            <div className="queue-title">{t("queue.title")}</div>
            <div className="queue-sub">
              <span className="pill pill-queued">
                {t("queue.counts.queued", { count: counts.queued })}
              </span>
              <span className="pill pill-running">
                {t("queue.counts.running", { count: counts.running })}
              </span>
              <span className="pill pill-failed">
                {t("queue.counts.failed", { count: counts.failed })}
              </span>
              <span className="pill pill-done">
                {t("queue.counts.done", { count: counts.done })}
              </span>
              <span className="queue-path">{t("queue.labels.concurrency")}</span>
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
                title={t("queue.titles.maxJobs")}
              />
              <span className="queue-path">{t("queue.labels.mbps")}</span>
              <input
                className="conn-input"
                style={{ width: 80 }}
                type="number"
                min={0}
                step={1}
                value={queue.maxMBps}
                disabled={busy}
                onChange={(e) => setQueue((q) => ({ ...q, maxMBps: Math.max(0, Number(e.target.value) || 0) }))}
                title={t("queue.titles.bandwidth")}
              />
              <span className="queue-path">{t("queue.labels.copyFolder")}</span>
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
                title={t("queue.titles.copyFolder")}
              />
            </div>
          </div>
          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={busy || counts.running > 0}
              onClick={() => setQueue((q) => ({ ...q, paused: !q.paused }))}
              title={queue.paused ? t("queue.actionTitles.resume") : t("queue.actionTitles.pause")}
            >
              {queue.paused ? t("queue.actions.resume") : t("queue.actions.pause")}
            </button>
            <button
              className="db-mini"
              disabled={busy}
              onClick={() => setQueue((q) => ({ ...q, autoRun: !q.autoRun }))}
              title={queue.autoRun ? t("queue.actionTitles.autoOn") : t("queue.actionTitles.autoOff")}
            >
              {queue.autoRun ? t("queue.actions.autoOn") : t("queue.actions.autoOff")}
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("queued")} title={t("queue.actionTitles.runQueued")}>
              {t("queue.actions.runQueued")}
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("failed")} title={t("queue.actionTitles.retryFailed")}>
              {t("queue.actions.retryFailed")}
            </button>
            <button className="db-mini" disabled={busy || queue.paused} onClick={() => runAll("all")} title={t("queue.actionTitles.runAll")}>
              {t("queue.actions.runAll")}
            </button>
            <button className="db-mini" disabled={busy} onClick={clearDone} title={t("queue.actionTitles.clearDone")}>
              {t("queue.actions.clearDone")}
            </button>
          </div>
        </div>
      ) : null}

      {queue.autoRun && !queue.paused && !busy && counts.queued > 0 && counts.running < queue.concurrency ? (
        // Kick off queued transfers automatically.
        // Note: we render a placeholder node to run an effect below without extra state.
        <AutoRunner onTick={() => runAll("queued")} />
      ) : null}

      {transfers.map((j, idx) => (
        <div key={j.id} className={`queue-row${selectedSet.has(j.id) ? " active" : ""}`}>
          <button
            className="db-mini"
            onClick={(ev) => toggleSelect(idx, j.id, ev)}
            title={selectedSet.has(j.id) ? t("queue.selection.deselect") : t("queue.selection.select")}
          >
            {selectedSet.has(j.id) ? "[x]" : "[ ]"}
          </button>
          <div className="queue-main">
            <div className="queue-title">
              <span className="accent">{j.id}</span>{" "}
              {j.kind === "download" ? (
                <span className="queue-path">
                  {t("queue.item.download", { snapshotId: j.snapshotId, path: j.path })}
                </span>
              ) : j.kind === "copy_file" ? (
                <span className="queue-path">
                  {t("queue.item.copy", {
                    srcBase: j.src.serverBaseUrl,
                    srcSnapshot: j.srcSnapshotId,
                    srcPath: j.srcPath,
                    dstBase: j.dst.serverBaseUrl,
                    dstPath: j.dstPath
                  })}
                </span>
              ) : j.kind === "snapshot_to_sftp" ? (
                <span className="queue-path">
                  {t("queue.item.snapshotToSftp", {
                    srcBase: j.src.serverBaseUrl,
                    snapshotId: j.snapshotId,
                    snapshotPath: j.snapshotPath,
                    user: j.conn.user,
                    host: j.conn.host,
                    remotePath: j.remotePath
                  })}
                </span>
              ) : j.kind === "sftp_to_snapshot" ? (
                <span className="queue-path">
                  {t("queue.item.sftpToSnapshot", {
                    user: j.conn.user,
                    host: j.conn.host,
                    remotePath: j.remotePath,
                    dstBase: j.dst.serverBaseUrl,
                    dstPath: j.dstPath
                  })}
                </span>
              ) : j.kind === "sftp_download" ? (
                <span className="queue-path">
                  {t("queue.item.sftpDownload", {
                    user: j.conn.user,
                    host: j.conn.host,
                    remotePath: j.remotePath,
                    localPath: j.localPath
                  })}
                </span>
              ) : j.kind === "sftp_upload" ? (
                <span className="queue-path">
                  {t("queue.item.sftpUpload", {
                    localPath: j.localPath,
                    user: j.conn.user,
                    host: j.conn.host,
                    remotePath: j.remotePath
                  })}
                </span>
              ) : (
                <span className="queue-path">
                  {t("queue.item.copyFolder", {
                    srcBase: j.src.serverBaseUrl,
                    srcSnapshot: j.srcSnapshotId,
                    srcDir: j.srcDirPath || "/",
                    dstBase: j.dst.serverBaseUrl,
                    dstDir: j.dstDirPath || "/"
                  })}
                </span>
              )}
            </div>
            <div className="queue-sub">
              <span className={`pill pill-${j.status}`}>{t(`queue.status.${j.status}`)}</span>
              {j.progress?.phase ? <span className="queue-path">{j.progress.phase}</span> : null}
              {typeof j.progress?.pct === "number" ? (
                <span className="pill pill-running">{j.progress.pct}%</span>
              ) : null}
              {j.kind === "copy_file" || j.kind === "copy_folder" || j.kind === "sftp_to_snapshot" ? (
                <>
                  {"dstBaseSnapshotId" in j && j.dstBaseSnapshotId ? (
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
                    title={t("queue.conflict.title")}
                  >
                    <option value="overwrite">{t("queue.conflict.overwrite")}</option>
                    <option value="skip">{t("queue.conflict.skip")}</option>
                    <option value="rename">{t("queue.conflict.rename")}</option>
                  </select>
                </>
              ) : null}
              {j.error ? <span className="queue-err">{j.error}</span> : null}
            </div>
            {typeof j.progress?.pct === "number" ? (
              <div className="queue-bar" aria-label={t("queue.progressAria")}>
                <div className="queue-bar-fill" style={{ width: `${Math.max(0, Math.min(100, j.progress.pct))}%` }} />
              </div>
            ) : null}
          </div>

          <div className="queue-actions">
            <button
              className="db-mini"
              disabled={busy || queue.paused || j.status === "done" || j.status === "running"}
              onClick={() => onRun(j.id)}
              title={t("queue.actionTitles.run")}
            >
              {t("queue.actions.run")}
            </button>
            {j.status === "running" ? (
              <button className="db-mini danger" onClick={() => onCancel(j.id)} title={t("queue.actionTitles.cancel")}>
                {t("queue.actions.cancel")}
              </button>
            ) : null}
            <button className="db-mini" onClick={() => onRemove(j.id)} title={t("queue.actionTitles.remove")}>
              {t("queue.actions.remove")}
            </button>
          </div>
        </div>
      ))}

      <div className="queue-hint">
        {t("queue.hint")}
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
