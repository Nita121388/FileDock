import { useEffect, useMemo, useState } from "react";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  DEFAULT_APP_STATE,
  type AppState,
  type TabState,
  newTab,
  removeTab
} from "./model/state";
import { loadState, saveState } from "./model/storage";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./model/settings";
import { basename, loadTransfers, saveTransfers, uid, type Conn, type TransferJob } from "./model/transfers";
import {
  apiGetBytes,
  chunksPresence,
  createSnapshot,
  putChunk,
  putManifest
} from "./api/client";
import { chunkBytes } from "./util/chunking";

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? DEFAULT_APP_STATE);
  const [settings, setSettings] = useState<Settings>(() => loadSettings() ?? DEFAULT_SETTINGS);
  const [transfers, setTransfers] = useState<TransferJob[]>(() => loadTransfers());

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveTransfers(transfers);
  }, [transfers]);

  const activeTab: TabState = useMemo(() => {
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    return t ?? state.tabs[0];
  }, [state]);

  const setActiveTab = (tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  };

  const onNewTab = () => {
    setState((s) => {
      const t = newTab("Workspace");
      return {
        ...s,
        tabs: [...s.tabs, t],
        activeTabId: t.id
      };
    });
  };

  const onCloseTab = (tabId: string) => {
    setState((s) => {
      const next = removeTab(s, tabId);
      return next;
    });
  };

  const enqueueDownload = (snapshotId: string, path: string, conn?: Conn) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "download",
      createdAt: Date.now(),
      status: "queued",
      conn,
      snapshotId,
      path,
      fileName: basename(path)
    };
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueCopy = (req: {
    src: Conn;
    srcSnapshotId: string;
    srcPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "copy_file",
      createdAt: Date.now(),
      status: "queued",
      src: req.src,
      dst: req.dst,
      srcSnapshotId: req.srcSnapshotId,
      srcPath: req.srcPath,
      dstDeviceName: req.dstDeviceName,
      dstDeviceId: req.dstDeviceId,
      dstPath: req.dstPath
    };
    setTransfers((xs) => [job, ...xs]);
  };

  const removeTransfer = (id: string) => setTransfers((xs) => xs.filter((x) => x.id !== id));
  const setTransferStatus = (id: string, status: import("./model/transfers").TransferStatus) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
  };

  const connToSettings = (c: Conn): Settings => ({
    serverBaseUrl: c.serverBaseUrl,
    token: c.token,
    deviceId: c.deviceId,
    deviceToken: c.deviceToken
  });

  const downloadNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "download") return;
    setTransferStatus(id, "running");
    try {
      const eff = job.conn ? connToSettings(job.conn) : settings;
      const blob = await apiGetBytes(
        eff,
        `/v1/snapshots/${encodeURIComponent(job.snapshotId)}/file`,
        { path: job.path }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = job.fileName || "download";
      a.click();
      URL.revokeObjectURL(url);
      setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined } : x)));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg } : x)));
    }
  };

  const copyNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "copy_file") return;
    setTransferStatus(id, "running");

    const srcSettings = connToSettings(job.src);
    const dstSettings = connToSettings(job.dst);

    try {
      // 1) Download bytes from source server.
      const blob = await apiGetBytes(
        srcSettings,
        `/v1/snapshots/${encodeURIComponent(job.srcSnapshotId)}/file`,
        { path: job.srcPath }
      );
      const buf = new Uint8Array(await blob.arrayBuffer());

      // 2) Chunk + hash.
      const refs = chunkBytes(buf);
      const hashes = refs.map((c) => c.hash);

      // 3) Presence (batched) on destination.
      const missing = new Set<string>();
      const batchSize = 1000;
      for (let i = 0; i < hashes.length; i += batchSize) {
        const batch = hashes.slice(i, i + batchSize);
        const resp = await chunksPresence(dstSettings, { hashes: batch });
        for (const h of resp.missing) missing.add(h);
      }

      // 4) Upload missing chunks.
      let offset = 0;
      for (const c of refs) {
        const end = offset + c.size;
        if (missing.has(c.hash)) {
          await putChunk(dstSettings, c.hash, buf.subarray(offset, end));
        }
        offset = end;
      }

      // 5) Create snapshot + manifest on destination.
      const now = Math.floor(Date.now() / 1000);
      const snap = await createSnapshot(dstSettings, {
        device_name: job.dstDeviceName,
        device_id: job.dstDeviceId ?? null,
        root_path: "(transfer)"
      });
      await putManifest(dstSettings, snap.snapshot_id, {
        snapshot_id: snap.snapshot_id,
        created_unix: now,
        files: [
          {
            path: job.dstPath,
            size: buf.length,
            mtime_unix: now,
            chunk_hash: null,
            chunks: refs
          }
        ]
      });

      setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined } : x)));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg } : x)));
    }
  };

  const runTransfer = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind === "download") return downloadNow(id);
    if (job.kind === "copy_file") return copyNow(id);
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>FileDock</h1>
          <div className="meta">desktop UI shell</div>
        </div>

        <div className="conn">
          <input
            className="conn-input"
            value={settings.serverBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, serverBaseUrl: e.target.value }))}
            placeholder="http://127.0.0.1:8787"
            title="Server base URL"
          />
          <input
            className="conn-input"
            value={settings.token}
            onChange={(e) => setSettings((s) => ({ ...s, token: e.target.value }))}
            placeholder="token (optional)"
            title="X-FileDock-Token (optional)"
          />
          <input
            className="conn-input"
            value={settings.deviceId}
            onChange={(e) => setSettings((s) => ({ ...s, deviceId: e.target.value }))}
            placeholder="device id (optional)"
            title="X-FileDock-Device-Id (optional)"
          />
          <input
            className="conn-input"
            value={settings.deviceToken}
            onChange={(e) => setSettings((s) => ({ ...s, deviceToken: e.target.value }))}
            placeholder="device token (optional)"
            title="X-FileDock-Device-Token (optional)"
          />
        </div>

        <div className="tabs" role="tablist" aria-label="Workspaces">
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeTab.id ? "tab active" : "tab"}
              role="tab"
              aria-selected={t.id === activeTab.id}
              tabIndex={0}
              onClick={() => setActiveTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(t.id);
              }}
            >
              <span className="dot" />
              <span>{t.name}</span>
              {state.tabs.length > 1 ? (
                <button
                  className="tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(t.id);
                  }}
                >
                  x
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button className="btn primary" onClick={onNewTab} title="New tab">
          + Tab
        </button>
      </div>

      <div className="workspace" role="main">
        <WorkspaceView
          tab={activeTab}
          settings={settings}
          transfers={transfers}
          onEnqueueDownload={enqueueDownload}
          onEnqueueCopy={enqueueCopy}
          onRemoveTransfer={removeTransfer}
          onRunTransfer={runTransfer}
          onSetDeviceAuth={(deviceId, deviceToken) =>
            setSettings((s) => ({ ...s, deviceId, deviceToken }))
          }
          onTabChange={(tab) => {
            setState((s) => ({
              ...s,
              tabs: s.tabs.map((x) => (x.id === tab.id ? tab : x))
            }));
          }}
        />
      </div>

      <div className="statusbar">
        <span className="kbd">Split</span> via pane toolbar
        <span className="kbd">Drag</span> gutters to resize
        <span className="kbd">Persist</span> layouts saved locally per tab
      </div>
    </div>
  );
}
