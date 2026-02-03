import { useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceView } from "./components/WorkspaceView";
import {
  DEFAULT_APP_STATE,
  type AppState,
  type TabState,
  newTab,
  removeTab
} from "./model/state";
import { activeTab as activeLeafTab, findLeaf, setLeafPane, type LayoutNode, type PaneKind } from "./model/layout";
import { loadState, saveState } from "./model/storage";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "./model/settings";
import {
  basename,
  loadTransfers,
  saveTransfers,
  uid,
  type Conn,
  type PluginRunConfig,
  type SftpConn,
  type TransferJob,
  type TransferProgress,
  type TransferStatus
} from "./model/transfers";
import {
  apiGetBytes,
  apiGetUint8Array,
  chunksPresence,
  createSnapshot,
  getChunkBytes,
  getTree,
  getManifest,
  putChunk,
  putManifest
} from "./api/client";
import { chunkBytes } from "./util/chunking";
import {
  cancelFiledockPluginRun,
  copySnapshotFileToSftp,
  importSftpFileToSnapshot,
  runFiledockPlugin
} from "./api/tauri";
import { applyTheme } from "./theme/applyTheme";
import CommandPalette, { type CommandItem } from "./components/CommandPalette";
import { emitPaneCommand } from "./commandBus";

const QUEUE_KEY = "filedock.desktop.queue.v1";

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState() ?? DEFAULT_APP_STATE);
  const [settings, setSettings] = useState<Settings>(() => loadSettings() ?? DEFAULT_SETTINGS);
  const [transfers, setTransfers] = useState<TransferJob[]>(() => loadTransfers());
  const [showPrefs, setShowPrefs] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const abortersRef = useRef<Map<string, AbortController>>(new Map());
  const runAllBusyRef = useRef(false);
  const presenceCacheRef = useRef<
    Map<
      string,
      {
        haveLRU: Map<string, true>;
        missingUntilMs: Map<string, number>;
      }
    >
  >(new Map());
  const inflightChunksRef = useRef<Map<string, Map<string, Promise<void>>>>(new Map());

  const connKey = (c: Conn): string => {
    // Key caches by connection identity, not just base URL, to avoid accidental cross-auth reuse.
    return `${c.serverBaseUrl}::${c.token}::${c.deviceId}::${c.deviceToken}`;
  };

  const getPresenceCache = (dst: Conn) => {
    const key = connKey(dst);
    let ent = presenceCacheRef.current.get(key);
    if (!ent) {
      ent = { haveLRU: new Map(), missingUntilMs: new Map() };
      presenceCacheRef.current.set(key, ent);
    }
    return ent;
  };

  const getInflightChunks = (dst: Conn) => {
    const key = connKey(dst);
    let ent = inflightChunksRef.current.get(key);
    if (!ent) {
      ent = new Map();
      inflightChunksRef.current.set(key, ent);
    }
    return ent;
  };

  const cacheTouch = (lru: Map<string, true>, k: string) => {
    if (lru.has(k)) lru.delete(k);
    lru.set(k, true);
  };

  const cacheMarkHave = (dst: Conn, hash: string) => {
    const ent = getPresenceCache(dst);
    cacheTouch(ent.haveLRU, hash);
    ent.missingUntilMs.delete(hash);
    const MAX_HAVE = 50000;
    while (ent.haveLRU.size > MAX_HAVE) {
      const it = ent.haveLRU.keys().next();
      if (it.done) break;
      ent.haveLRU.delete(it.value);
    }
  };

  const cacheMarkMissingShort = (dst: Conn, hash: string) => {
    const ent = getPresenceCache(dst);
    // Only cache "missing" briefly; it might appear shortly after due to other jobs/devices.
    ent.missingUntilMs.set(hash, Date.now() + 30_000);
    const MAX_MISS = 20000;
    while (ent.missingUntilMs.size > MAX_MISS) {
      const it = ent.missingUntilMs.keys().next();
      if (it.done) break;
      ent.missingUntilMs.delete(it.value);
    }
  };

  const getRateLimitBytesPerSec = (): number => {
    try {
      const raw = localStorage.getItem("filedock.desktop.queue.v1");
      if (!raw) return 0;
      const parsed = JSON.parse(raw) as any;
      const mbps = Number(parsed?.maxMBps);
      if (!Number.isFinite(mbps) || mbps <= 0) return 0;
      return mbps * 1024 * 1024;
    } catch {
      return 0;
    }
  };

  const getCopyFolderFileConcurrency = (): number => {
    try {
      const raw = localStorage.getItem("filedock.desktop.queue.v1");
      if (!raw) return 4;
      const parsed = JSON.parse(raw) as any;
      const n = Number(parsed?.copyFolderFileConcurrency);
      if (!Number.isFinite(n) || n < 1) return 4;
      return Math.min(8, Math.floor(n));
    } catch {
      return 4;
    }
  };

  const getQueueConcurrency = (): number => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return 2;
      const parsed = JSON.parse(raw) as any;
      const concurrency = Number(parsed?.concurrency);
      if (!Number.isFinite(concurrency) || concurrency < 1) return 2;
      return Math.min(8, Math.floor(concurrency));
    } catch {
      return 2;
    }
  };

  const findFirstLeaf = (node: LayoutNode): string | null => {
    if (node.kind === "leaf") return node.id;
    return findFirstLeaf(node.a) ?? findFirstLeaf(node.b);
  };

  const getActiveLeafId = (tab: TabState): string | null => {
    return findFirstLeaf(tab.root);
  };

  const ensureMissingOnDestShared = async (dst: Conn, hashes: string[], signal: AbortSignal) => {
    const ent = getPresenceCache(dst);
    const now = Date.now();
    const unknown: string[] = [];
    const missing: string[] = [];

    for (const h of hashes) {
      if (ent.haveLRU.has(h)) {
        cacheTouch(ent.haveLRU, h);
        continue;
      }
      const until = ent.missingUntilMs.get(h);
      if (until && until > now) {
        missing.push(h);
        continue;
      }
      if (until) ent.missingUntilMs.delete(h);
      unknown.push(h);
    }

    const batchSize = 1000;
    for (let i = 0; i < unknown.length; i += batchSize) {
      const batch = unknown.slice(i, i + batchSize);
      const resp = await chunksPresence(dst, { hashes: batch }, signal);
      const miss = new Set(resp.missing);
      for (const h of batch) {
        if (miss.has(h)) {
          missing.push(h);
          cacheMarkMissingShort(dst, h);
        } else {
          cacheMarkHave(dst, h);
        }
      }
    }

    return missing;
  };

  const awaitWithAbort = async <T,>(p: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        const onAbort = () => rej(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  };

  const putChunkDedup = async (dst: Conn, hash: string, bytes: Uint8Array, signal: AbortSignal) => {
    const inflight = getInflightChunks(dst);
    const existing = inflight.get(hash);
    if (existing) {
      // Followers should still respond to cancellation quickly.
      await awaitWithAbort(existing, signal);
      return;
    }

    const p = (async () => {
      try {
        await putChunk(dst, hash, bytes, signal);
        cacheMarkHave(dst, hash);
      } finally {
        inflight.delete(hash);
      }
    })();

    inflight.set(hash, p);
    await p;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const makeLimiter = (bytesPerSec: number) => {
    if (!bytesPerSec || bytesPerSec <= 0) return null;
    const start = performance.now();
    return async (doneBytes: number) => {
      const idealMs = (doneBytes / bytesPerSec) * 1000;
      const elapsedMs = performance.now() - start;
      if (idealMs > elapsedMs) await sleep(idealMs - elapsedMs);
    };
  };

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    saveTransfers(transfers);
  }, [transfers]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setShowPrefs((v) => {
          const next = !v;
          if (next) setShowCommand(false);
          return next;
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommand(true);
        setShowPrefs(false);
        return;
      }
      if (e.key === "Escape") {
        setShowPrefs(false);
        setShowCommand(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeTab: TabState = useMemo(() => {
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    return t ?? state.tabs[0];
  }, [state]);

  const activePane = useMemo(() => {
    const leafId = getActiveLeafId(activeTab);
    if (!leafId) return null;
    const leaf = findLeaf(activeTab.root, leafId);
    if (!leaf) return null;
    return activeLeafTab(leaf);
  }, [activeTab]);

  const setActiveTab = (tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  };

  const updateActiveRoot = (updater: (root: LayoutNode) => LayoutNode) => {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, root: updater(t.root) } : t))
    }));
  };

  const setActiveLeafPane = (pane: PaneKind) => {
    const leafId = getActiveLeafId(activeTab);
    if (!leafId) return;
    updateActiveRoot((root) => setLeafPane(root, leafId, pane));
  };

  const goToNextWorkspace = (dir: 1 | -1) => {
    const idx = state.tabs.findIndex((t) => t.id === activeTab.id);
    if (idx < 0) return;
    const next = (idx + dir + state.tabs.length) % state.tabs.length;
    const target = state.tabs[next];
    if (target) setActiveTab(target.id);
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

  const openPrefs = () => {
    setShowPrefs(true);
    setShowCommand(false);
  };

  const toggleTheme = () => {
    setSettings((s) => ({
      ...s,
      theme: {
        ...s.theme,
        mode: s.theme.mode === "dark" ? "light" : "dark"
      }
    }));
  };

  const runTransfers = async (mode: "queued" | "failed" | "all") => {
    if (runAllBusyRef.current) return;
    runAllBusyRef.current = true;
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

      const limit = Math.max(1, Math.min(8, Math.floor(getQueueConcurrency() || 1)));
      let next = 0;
      const worker = async () => {
        while (true) {
          const i = next++;
          if (i >= ids.length) return;
          await runTransfer(ids[i]!);
        }
      };

      const workers = Array.from({ length: Math.min(limit, ids.length) }, () => worker());
      await Promise.all(workers);
    } finally {
      runAllBusyRef.current = false;
    }
  };

  const clearDoneTransfers = () => {
    setTransfers((xs) => xs.filter((x) => x.status !== "done"));
  };

  const cancelRunningTransfers = () => {
    for (const j of transfers) {
      if (j.status === "running") cancelTransfer(j.id);
    }
  };

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [
      {
        id: "prefs",
        title: "Preferences",
        hint: "Open preferences",
        shortcut: "Ctrl/⌘ + ,",
        run: openPrefs
      },
      {
        id: "new-tab",
        title: "New workspace tab",
        run: onNewTab
      },
      {
        id: "toggle-theme",
        title: settings.theme.mode === "dark" ? "Switch to light theme" : "Switch to dark theme",
        hint: `Current: ${settings.theme.mode}`,
        run: toggleTheme
      }
    ];

    items.push(
      {
        id: "view-device",
        title: "View: Server Device",
        keywords: "view device server",
        run: () => setActiveLeafPane("deviceBrowser")
      },
      {
        id: "view-local",
        title: "View: Local",
        keywords: "view local",
        run: () => setActiveLeafPane("localBrowser")
      },
      {
        id: "view-sftp",
        title: "View: SFTP",
        keywords: "view sftp vps",
        run: () => setActiveLeafPane("sftpBrowser")
      },
      {
        id: "view-queue",
        title: "View: Transfer Queue",
        keywords: "view queue transfers",
        run: () => setActiveLeafPane("transferQueue")
      },
      {
        id: "view-notes",
        title: "View: Notes",
        keywords: "view notes",
        run: () => setActiveLeafPane("notes")
      }
    );

    items.push(
      {
        id: "queue-run-queued",
        title: "Queue: Run queued transfers",
        keywords: "queue run queued",
        run: () => runTransfers("queued")
      },
      {
        id: "queue-retry-failed",
        title: "Queue: Retry failed transfers",
        keywords: "queue retry failed",
        run: () => runTransfers("failed")
      },
      {
        id: "queue-run-all",
        title: "Queue: Run all pending",
        keywords: "queue run all pending",
        run: () => runTransfers("all")
      },
      {
        id: "queue-cancel-running",
        title: "Queue: Cancel running transfers",
        keywords: "queue cancel running",
        run: cancelRunningTransfers
      },
      {
        id: "queue-clear-done",
        title: "Queue: Clear done transfers",
        keywords: "queue clear done",
        run: clearDoneTransfers
      }
    );

    const paneId = activePane?.id ?? "";
    if (activePane?.pane === "deviceBrowser") {
      items.push(
        {
          id: "device-refresh",
          title: "Device: Refresh snapshots",
          keywords: "device refresh snapshots",
          run: () => emitPaneCommand({ kind: "device.refresh", paneId })
        },
        {
          id: "device-upload",
          title: "Device: Upload file",
          keywords: "device upload",
          run: () => emitPaneCommand({ kind: "device.upload", paneId })
        },
        {
          id: "device-toggle-history",
          title: "Device: Toggle history list",
          keywords: "device history toggle",
          run: () => emitPaneCommand({ kind: "device.toggleHistory", paneId })
        },
        {
          id: "device-view-all",
          title: "Device: View all files",
          keywords: "device all files",
          run: () => emitPaneCommand({ kind: "device.viewAll", paneId })
        },
        {
          id: "device-view-history",
          title: "Device: View history snapshot",
          keywords: "device history snapshot",
          run: () => emitPaneCommand({ kind: "device.viewHistory", paneId })
        },
        {
          id: "device-up",
          title: "Device: Up",
          keywords: "device up parent",
          run: () => emitPaneCommand({ kind: "device.up", paneId })
        },
        {
          id: "device-restore",
          title: "Device: Restore snapshot",
          keywords: "device restore snapshot",
          run: () => emitPaneCommand({ kind: "device.restore", paneId })
        },
        {
          id: "device-cancel-restore",
          title: "Device: Cancel restore",
          keywords: "device cancel restore",
          run: () => emitPaneCommand({ kind: "device.cancelRestore", paneId })
        },
        {
          id: "device-queue-selected",
          title: "Device: Queue selected files",
          keywords: "device queue selected",
          run: () => emitPaneCommand({ kind: "device.queueSelected", paneId })
        },
        {
          id: "device-select-all",
          title: "Device: Select all",
          keywords: "device select all",
          run: () => emitPaneCommand({ kind: "device.selectAll", paneId })
        },
        {
          id: "device-clear-selection",
          title: "Device: Clear selection",
          keywords: "device clear selection",
          run: () => emitPaneCommand({ kind: "device.clearSelection", paneId })
        }
      );
    }

    if (activePane?.pane === "localBrowser") {
      items.push(
        {
          id: "local-choose",
          title: "Local: Choose folder",
          keywords: "local choose folder",
          run: () => emitPaneCommand({ kind: "local.choose", paneId })
        },
        {
          id: "local-up",
          title: "Local: Up",
          keywords: "local up parent",
          run: () => emitPaneCommand({ kind: "local.up", paneId })
        },
        {
          id: "local-refresh",
          title: "Local: Refresh",
          keywords: "local refresh",
          run: () => emitPaneCommand({ kind: "local.refresh", paneId })
        }
      );
    }

    if (activePane?.pane === "sftpBrowser") {
      items.push(
        {
          id: "sftp-refresh",
          title: "SFTP: Refresh",
          keywords: "sftp refresh",
          run: () => emitPaneCommand({ kind: "sftp.refresh", paneId })
        },
        {
          id: "sftp-up",
          title: "SFTP: Up",
          keywords: "sftp up parent",
          run: () => emitPaneCommand({ kind: "sftp.up", paneId })
        },
        {
          id: "sftp-mkdir",
          title: "SFTP: Mkdir",
          keywords: "sftp mkdir",
          run: () => emitPaneCommand({ kind: "sftp.mkdir", paneId })
        },
        {
          id: "sftp-upload",
          title: "SFTP: Upload file",
          keywords: "sftp upload",
          run: () => emitPaneCommand({ kind: "sftp.upload", paneId })
        }
      );
    }

    if (activePane?.pane === "transferQueue") {
      items.push(
        {
          id: "queue-run-selected",
          title: "Queue: Run selected transfers",
          keywords: "queue run selected",
          run: () => emitPaneCommand({ kind: "queue.runSelected", paneId })
        },
        {
          id: "queue-cancel-selected",
          title: "Queue: Cancel selected transfers",
          keywords: "queue cancel selected",
          run: () => emitPaneCommand({ kind: "queue.cancelSelected", paneId })
        },
        {
          id: "queue-remove-selected",
          title: "Queue: Remove selected transfers",
          keywords: "queue remove selected",
          run: () => emitPaneCommand({ kind: "queue.removeSelected", paneId })
        },
        {
          id: "queue-select-failed",
          title: "Queue: Select failed transfers",
          keywords: "queue select failed",
          run: () => emitPaneCommand({ kind: "queue.selectFailed", paneId })
        },
        {
          id: "queue-select-queued",
          title: "Queue: Select queued transfers",
          keywords: "queue select queued",
          run: () => emitPaneCommand({ kind: "queue.selectQueued", paneId })
        },
        {
          id: "queue-clear-selection",
          title: "Queue: Clear selection",
          keywords: "queue clear selection",
          run: () => emitPaneCommand({ kind: "queue.clearSelection", paneId })
        }
      );
    }

    for (const [idx, t] of state.tabs.entries()) {
      items.push({
        id: `workspace-${t.id}`,
        title: `Switch to ${t.name || "Workspace"} ${idx + 1}`,
        hint: `Workspace ${idx + 1}`,
        run: () => setActiveTab(t.id)
      });
    }

    if (state.tabs.length > 1) {
      items.push(
        {
          id: "workspace-next",
          title: "Next workspace tab",
          keywords: "workspace next tab",
          run: () => goToNextWorkspace(1)
        },
        {
          id: "workspace-prev",
          title: "Previous workspace tab",
          keywords: "workspace previous tab",
          run: () => goToNextWorkspace(-1)
        }
      );
    }

    if (state.tabs.length > 1) {
      items.push({
        id: "close-tab",
        title: "Close active workspace tab",
        hint: `Close ${activeTab.name || "workspace"}`,
        run: () => onCloseTab(activeTab.id)
      });
    }

    return items;
  }, [
    activePane?.id,
    activePane?.pane,
    activeTab.id,
    activeTab.name,
    cancelRunningTransfers,
    clearDoneTransfers,
    goToNextWorkspace,
    onNewTab,
    onCloseTab,
    openPrefs,
    runTransfers,
    setActiveLeafPane,
    setActiveTab,
    settings.theme.mode,
    state.tabs,
    toggleTheme
  ]);

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

  const enqueueSftpDownload = (req: {
    runner?: PluginRunConfig;
    conn: SftpConn;
    remotePath: string;
    localPath: string;
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "sftp_download",
      createdAt: Date.now(),
      status: "queued",
      runner: req.runner,
      conn: req.conn,
      remotePath: req.remotePath,
      localPath: req.localPath
    } as any;
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueSftpUpload = (req: {
    runner?: PluginRunConfig;
    conn: SftpConn;
    localPath: string;
    remotePath: string;
    mkdirs?: boolean;
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "sftp_upload",
      createdAt: Date.now(),
      status: "queued",
      runner: req.runner,
      conn: req.conn,
      localPath: req.localPath,
      remotePath: req.remotePath,
      mkdirs: req.mkdirs ?? true
    } as any;
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueSnapshotToSftp = (req: {
    src: Conn;
    snapshotId: string;
    snapshotPath: string;
    runner?: PluginRunConfig;
    conn: SftpConn;
    remotePath: string;
    mkdirs?: boolean;
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "snapshot_to_sftp",
      createdAt: Date.now(),
      status: "queued",
      src: req.src,
      snapshotId: req.snapshotId,
      snapshotPath: req.snapshotPath,
      runner: req.runner,
      conn: req.conn,
      remotePath: req.remotePath,
      mkdirs: req.mkdirs ?? true
    } as any;
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueSftpToSnapshot = (req: {
    runner?: PluginRunConfig;
    conn: SftpConn;
    remotePath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "sftp_to_snapshot",
      createdAt: Date.now(),
      status: "queued",
      runner: req.runner,
      conn: req.conn,
      remotePath: req.remotePath,
      dst: req.dst,
      dstDeviceName: req.dstDeviceName,
      dstDeviceId: req.dstDeviceId,
      dstBaseSnapshotId: req.dstBaseSnapshotId,
      dstPath: req.dstPath,
      conflictPolicy: req.conflictPolicy ?? "overwrite"
    } as any;
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
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
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
      dstPath: req.dstPath,
      dstBaseSnapshotId: req.dstBaseSnapshotId,
      conflictPolicy: req.conflictPolicy ?? "overwrite"
    };
    setTransfers((xs) => [job, ...xs]);
  };

  const enqueueCopyFolder = (req: {
    src: Conn;
    srcSnapshotId: string;
    srcDirPath: string;
    dst: Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstDirPath: string;
    dstBaseSnapshotId?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
  }) => {
    const job: TransferJob = {
      id: uid("xfer"),
      kind: "copy_folder",
      createdAt: Date.now(),
      status: "queued",
      src: req.src,
      dst: req.dst,
      srcSnapshotId: req.srcSnapshotId,
      srcDirPath: req.srcDirPath,
      dstDeviceName: req.dstDeviceName,
      dstDeviceId: req.dstDeviceId,
      dstDirPath: req.dstDirPath,
      dstBaseSnapshotId: req.dstBaseSnapshotId,
      conflictPolicy: req.conflictPolicy ?? "overwrite",
      nextIndex: 0,
      filePaths: undefined
    } as any;
    setTransfers((xs) => [job, ...xs]);
  };

  const removeTransfer = (id: string) => setTransfers((xs) => xs.filter((x) => x.id !== id));
  const setTransferStatus = (id: string, status: TransferStatus) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
  };
  const setTransferProgress = (id: string, progress: TransferProgress | undefined) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, progress } : x)));
  };
  const setTransferError = (id: string, error: string | undefined) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? { ...x, error } : x)));
  };

  const patchTransfer = (id: string, patch: (j: TransferJob) => TransferJob) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? patch(x) : x)));
  };

  const updateTransfer = (id: string, updates: Partial<TransferJob>) => {
    setTransfers((xs) => xs.map((x) => (x.id === id ? ({ ...x, ...updates } as TransferJob) : x)));
  };

  function isAbortError(e: unknown): boolean {
    const any = e as any;
    return any?.name === "AbortError" || String(any?.message ?? "").toLowerCase().includes("aborted");
  }

  const withRetry = async <T,>(fn: () => Promise<T>, tries = 3): Promise<T> => {
    let last: unknown = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        // Stop retry loops on user cancel.
        if (isAbortError(e)) throw e;
        last = e;
        const ms = Math.min(3000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    throw last;
  };

  const newAborter = (id: string): AbortController => {
    // Replace any previous controller for the same job id.
    const prev = abortersRef.current.get(id);
    if (prev) {
      try {
        prev.abort();
      } catch {
        // ignore
      }
    }
    const ac = new AbortController();
    abortersRef.current.set(id, ac);
    return ac;
  };

  const clearAborter = (id: string) => {
    abortersRef.current.delete(id);
  };

  const cancelTransfer = (id: string) => {
    const ac = abortersRef.current.get(id);
    const job = transfers.find((x) => x.id === id);
    if (
      job &&
      (job.kind === "sftp_download" ||
        job.kind === "sftp_upload" ||
        job.kind === "snapshot_to_sftp" ||
        job.kind === "sftp_to_snapshot")
    ) {
      // Best-effort: signal the backend to kill the plugin process if it is running.
      cancelFiledockPluginRun(id).catch(() => {});
    }
    if (!ac) return;
    try {
      ac.abort();
    } finally {
      // Status update happens in the transfer catch handler.
    }
  };

  const connToConn = (c: Conn): Conn => ({
    serverBaseUrl: c.serverBaseUrl,
    token: c.token,
    deviceId: c.deviceId,
    deviceToken: c.deviceToken
  });

  const downloadNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "download") return;
    if (job.status === "running" || job.status === "done") return;
    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    try {
      const eff = job.conn ? connToConn(job.conn) : settings;
      const limiter = makeLimiter(getRateLimitBytesPerSec());
      setTransferProgress(id, { phase: "downloading", pct: 0 });
      const buf = await withRetry(async () => {
        return await apiGetUint8Array(
          eff,
          `/v1/snapshots/${encodeURIComponent(job.snapshotId)}/file`,
          { path: job.path },
          (done, total) => {
            const pct = total && total > 0 ? Math.floor((done / total) * 100) : undefined;
            setTransferProgress(id, { phase: "downloading", doneBytes: done, totalBytes: total ?? undefined, pct });
          },
          ac.signal,
          limiter ? async (_chunkBytes, doneBytes) => limiter(doneBytes) : undefined
        );
      });
      setTransferProgress(id, { phase: "saving", pct: 100 });
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const blob = new Blob([ab]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = job.fileName || "download";
      a.click();
      URL.revokeObjectURL(url);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  function splitPluginDirs(s: string | undefined): string[] | undefined {
    const raw = (s ?? "").trim();
    if (!raw) return undefined;
    const parts = raw
      .split(":")
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.length ? parts : undefined;
  }

  const sftpDownloadNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "sftp_download") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    setTransferProgress(id, { phase: "sftp download", pct: undefined });

    try {
      const payload = {
        op: "download",
        conn: job.conn,
        args: { remote_path: job.remotePath, local_path: job.localPath }
      };
      await runFiledockPlugin({
        name: "sftp",
        json: JSON.stringify(payload),
        timeout_secs: job.runner?.timeout_secs ?? 300,
        filedock_path: job.runner?.filedock_path,
        plugin_dirs: splitPluginDirs(job.runner?.plugin_dirs),
        run_id: id
      });

      if (ac.signal.aborted) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const sftpUploadNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "sftp_upload") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    setTransferProgress(id, { phase: "sftp upload", pct: undefined });

    try {
      const payload = {
        op: "upload",
        conn: job.conn,
        args: { local_path: job.localPath, remote_path: job.remotePath, mkdirs: job.mkdirs ?? true }
      };
      await runFiledockPlugin({
        name: "sftp",
        json: JSON.stringify(payload),
        timeout_secs: job.runner?.timeout_secs ?? 300,
        filedock_path: job.runner?.filedock_path,
        plugin_dirs: splitPluginDirs(job.runner?.plugin_dirs),
        run_id: id
      });

      if (ac.signal.aborted) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const snapshotToSftpNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "snapshot_to_sftp") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    setTransferProgress(id, { phase: "snapshot -> sftp", pct: undefined });

    try {
      await copySnapshotFileToSftp({
        run_id: id,
        server_base_url: job.src.serverBaseUrl,
        token: job.src.token || undefined,
        device_id: job.src.deviceId || undefined,
        device_token: job.src.deviceToken || undefined,
        snapshot_id: job.snapshotId,
        path: job.snapshotPath,
        sftp_conn: job.conn,
        remote_path: job.remotePath,
        runner: {
          filedock_path: job.runner?.filedock_path,
          plugin_dirs: job.runner?.plugin_dirs,
          timeout_secs: job.runner?.timeout_secs ?? 600
        },
        mkdirs: job.mkdirs ?? true
      });

      if (ac.signal.aborted) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const sftpToSnapshotNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "sftp_to_snapshot") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);
    setTransferProgress(id, { phase: "sftp -> snapshot", pct: undefined });

    try {
      await importSftpFileToSnapshot({
        run_id: id,
        server_base_url: job.dst.serverBaseUrl,
        token: job.dst.token || undefined,
        device_id: job.dst.deviceId || undefined,
        device_token: job.dst.deviceToken || undefined,
        dst_device_name: job.dstDeviceName,
        dst_device_id: job.dstDeviceId || undefined,
        dst_base_snapshot_id: job.dstBaseSnapshotId || undefined,
        dst_path: job.dstPath,
        conflict_policy: job.conflictPolicy ?? "overwrite",
        sftp_conn: job.conn,
        remote_path: job.remotePath,
        runner: {
          filedock_path: job.runner?.filedock_path,
          plugin_dirs: job.runner?.plugin_dirs,
          timeout_secs: job.runner?.timeout_secs ?? 900
        }
      }, (p) => {
        setTransferProgress(id, {
          phase: p.phase || "sftp -> snapshot",
          doneBytes: typeof p.done_bytes === "number" ? p.done_bytes : undefined,
          totalBytes: typeof p.total_bytes === "number" ? p.total_bytes : undefined,
          pct: typeof p.pct === "number" ? p.pct : undefined
        });
      });

      if (ac.signal.aborted) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const copyNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "copy_file") return;
    if (job.status === "running" || job.status === "done") return;
    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);

    const srcSettings = connToConn(job.src);
    const dstSettings = connToConn(job.dst);

    try {
      // Optional: base the destination on an existing snapshot manifest (copy-on-write into a new snapshot).
      const baseFiles: { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }[] =
        [];
      if (job.dstBaseSnapshotId) {
        setTransferProgress(id, { phase: "loading destination base", pct: 0 });
        try {
          const base = await getManifest(dstSettings, job.dstBaseSnapshotId, ac.signal);
          for (const f of base.files ?? []) {
            if (!f?.path || !Array.isArray(f.chunks)) continue;
            baseFiles.push({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
            });
          }
        } catch {
          // ignore
        }
      }

      const fileMap = new Map<
        string,
        { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }
      >();
      for (const f of baseFiles) fileMap.set(f.path, f);

      const pol = job.conflictPolicy ?? "overwrite";
      const choosePath = (p: string): string | null => {
        if (!fileMap.has(p)) return p;
        if (pol === "skip") return null;
        if (pol === "overwrite") return p;
        // rename
        const dot = p.lastIndexOf(".");
        const base = dot > 0 ? p.slice(0, dot) : p;
        const ext = dot > 0 ? p.slice(dot) : "";
        for (let i = 2; i < 1000; i++) {
          const cand = `${base} (${i})${ext}`;
          if (!fileMap.has(cand)) return cand;
        }
        return p;
      };

      const finalPath = choosePath(job.dstPath);
      if (finalPath === null) {
        // Conflict policy decided to skip and the file already exists in the destination base manifest.
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
        );
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const bytesPerSec = getRateLimitBytesPerSec();
      const dlLimiter = makeLimiter(bytesPerSec);
      const ulLimiter = makeLimiter(bytesPerSec);

      // Prefer chunk-level copy (fetch missing chunks by hash) when the source manifest has chunk lists.
      // Falls back to file download+chunk when needed.
      setTransferProgress(id, { phase: "loading source manifest", pct: 0 });
      let srcMeta:
        | { size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }
        | null = null;
      try {
        const m = await getManifest(srcSettings, job.srcSnapshotId, ac.signal);
        const e = (m.files ?? []).find((x) => x?.path === job.srcPath);
        if (e && Array.isArray(e.chunks) && e.chunks.length > 0) {
          srcMeta = {
            size: e.size,
            mtime_unix: e.mtime_unix,
            chunks: e.chunks.map((c) => ({ hash: c.hash, size: c.size }))
          };
        }
      } catch {
        // ignore
      }

      let newSize = 0;
      let newMtime = now;
      let newChunks: { hash: string; size: number }[] = [];

      const destKnownHave = new Set<string>();
      const destKnownMissing = new Set<string>();
      const ensureMissingOnDest = async (hashes: string[]) => {
        const unknown: string[] = [];
        for (const h of hashes) {
          if (destKnownHave.has(h) || destKnownMissing.has(h)) continue;
          unknown.push(h);
        }
        if (unknown.length > 0) {
          const miss = new Set(await ensureMissingOnDestShared(dstSettings, unknown, ac.signal));
          for (const h of unknown) {
            if (miss.has(h)) destKnownMissing.add(h);
            else destKnownHave.add(h);
          }
        }
        const missing: string[] = [];
        for (const h of hashes) if (destKnownMissing.has(h)) missing.push(h);
        return missing;
      };

      if (srcMeta) {
        newSize = srcMeta.size;
        newMtime = srcMeta.mtime_unix;
        newChunks = srcMeta.chunks;

        // Presence (batched) on destination.
        setTransferProgress(id, { phase: "checking chunks", pct: 0 });
        const hashes = newChunks.map((c) => c.hash);
        const missing = new Set(await ensureMissingOnDest(hashes));

        const missingBytesTotal = newChunks.reduce((acc, c) => acc + (missing.has(c.hash) ? c.size : 0), 0);
        let missingBytesDone = 0;
        let dlDone = 0;
        let ulDone = 0;

        // Fetch missing chunks from source, upload to destination.
        const toCopy = newChunks.filter((c) => missing.has(c.hash));
        const maxChunkConcurrency = Math.min(4, Math.max(1, toCopy.length));
        let idx = 0;
        await Promise.all(
          Array.from({ length: maxChunkConcurrency }, async () => {
            while (idx < toCopy.length) {
              const c = toCopy[idx++]!;
              setTransferProgress(id, {
                phase: `copying chunks (${Math.min(idx, toCopy.length)}/${toCopy.length})`,
                doneBytes: missingBytesDone,
                totalBytes: missingBytesTotal,
                pct: missingBytesTotal > 0 ? Math.floor((missingBytesDone / missingBytesTotal) * 100) : 100
              });

              const bytes = await withRetry(async () => {
                return await getChunkBytes(srcSettings, c.hash, ac.signal);
              });
              dlDone += bytes.byteLength;
              if (dlLimiter) await dlLimiter(dlDone);

          await withRetry(async () => {
            await putChunkDedup(dstSettings, c.hash, bytes, ac.signal);
          });
          ulDone += bytes.byteLength;
          if (ulLimiter) await ulLimiter(ulDone);

              missingBytesDone += c.size;
              setTransferProgress(id, {
                phase: `copying chunks (${Math.min(idx, toCopy.length)}/${toCopy.length})`,
                doneBytes: missingBytesDone,
                totalBytes: missingBytesTotal,
                pct: missingBytesTotal > 0 ? Math.floor((missingBytesDone / missingBytesTotal) * 100) : 100
              });
            }
          })
        );
      } else {
        // Fallback: download the file bytes, chunk locally, and upload missing chunks.
        setTransferProgress(id, { phase: "downloading", pct: 0 });
        const buf = await withRetry(async () => {
          return await apiGetUint8Array(
            srcSettings,
            `/v1/snapshots/${encodeURIComponent(job.srcSnapshotId)}/file`,
            { path: job.srcPath },
            (done, total) => {
              const pct = total && total > 0 ? Math.floor((done / total) * 100) : undefined;
              setTransferProgress(id, { phase: "downloading", doneBytes: done, totalBytes: total ?? undefined, pct });
            },
            ac.signal,
            dlLimiter ? async (_chunkBytes, doneBytes) => dlLimiter(doneBytes) : undefined
          );
        });

        setTransferProgress(id, { phase: "hashing", pct: 0 });
        const refs = chunkBytes(buf);
        const hashes = refs.map((c) => c.hash);
        newSize = buf.length;
        newChunks = refs.map((c) => ({ hash: c.hash, size: c.size }));

        setTransferProgress(id, { phase: "checking", pct: 0 });
        const missing = new Set(await ensureMissingOnDest(hashes));

        setTransferProgress(id, { phase: "uploading", pct: 0 });
        let offset = 0;
        let uploaded = 0;
        for (const c of refs) {
          const end = offset + c.size;
          if (missing.has(c.hash)) {
            await withRetry(async () => {
              await putChunkDedup(dstSettings, c.hash, buf.subarray(offset, end), ac.signal);
            });
            uploaded++;
          }
          offset = end;
          if (ulLimiter) await ulLimiter(offset);
          const pct = refs.length > 0 ? Math.floor((offset / buf.length) * 100) : 100;
          setTransferProgress(id, { phase: `uploading (${uploaded}/${missing.size} chunks)`, pct });
        }
      }

      // Create snapshot + manifest on destination (copy-on-write).
      setTransferProgress(id, { phase: "finalizing", pct: 0 });
      const snap = await createSnapshot(
        dstSettings,
        {
          device_name: job.dstDeviceName,
          device_id: job.dstDeviceId ?? null,
          root_path: job.dstBaseSnapshotId ? `(transfer from ${job.dstBaseSnapshotId})` : "(transfer)"
        },
        ac.signal
      );

      fileMap.set(finalPath, {
        path: finalPath,
        size: newSize,
        mtime_unix: newMtime,
        chunks: newChunks
      });

      const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));
      await putManifest(
        dstSettings,
        snap.snapshot_id,
        {
          snapshot_id: snap.snapshot_id,
          created_unix: now,
          files: files.map((f) => ({
            path: f.path,
            size: f.size,
            mtime_unix: f.mtime_unix,
            chunk_hash: null,
            chunks: f.chunks
          }))
        },
        ac.signal
      );

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const copyFolderNow = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind !== "copy_folder") return;
    if (job.status === "running" || job.status === "done") return;

    const ac = newAborter(id);
    setTransferStatus(id, "running");
    setTransferError(id, undefined);

    const srcSettings = connToConn(job.src);
    const dstSettings = connToConn(job.dst);
    let dstSnapshotId = job.dstSnapshotId;
    let filesList: string[] = (job.filePaths ?? []) as any;
    let nextIndex: number = job.nextIndex ?? 0;
    let manifestFiles: { path: string; size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }[] =
      [];

    try {
      // 1) Ensure destination snapshot exists.
      if (!dstSnapshotId) {
        setTransferProgress(id, { phase: "creating snapshot", pct: 0 });
        const snap = await createSnapshot(
          dstSettings,
          {
            device_name: job.dstDeviceName,
            device_id: job.dstDeviceId ?? null,
            root_path: job.dstBaseSnapshotId ? `(transfer-folder from ${job.dstBaseSnapshotId})` : "(transfer-folder)"
          },
          ac.signal
        );
        patchTransfer(id, (x) => ({ ...(x as any), dstSnapshotId: snap.snapshot_id }));
        dstSnapshotId = snap.snapshot_id;
      }

      // 1.5) Load destination manifest (for resume / skip already-copied files).
      setTransferProgress(id, { phase: "loading destination manifest", pct: 0 });
      try {
        const m = await getManifest(dstSettings, dstSnapshotId!, ac.signal);
        manifestFiles = (m.files ?? [])
          .filter((f) => f && typeof f.path === "string" && Array.isArray(f.chunks))
          .map((f) => ({
            path: f.path,
            size: f.size,
            mtime_unix: f.mtime_unix,
            chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
          }));
      } catch {
        // Manifest may not exist yet; treat as empty.
        manifestFiles = [];
      }

      // If this job is based on another snapshot and the destination snapshot is empty, seed it now.
      if (manifestFiles.length === 0 && job.dstBaseSnapshotId) {
        setTransferProgress(id, { phase: "seeding base manifest", pct: 0 });
        try {
          const base = await getManifest(dstSettings, job.dstBaseSnapshotId, ac.signal);
          manifestFiles = (base.files ?? [])
            .filter((f) => f && typeof f.path === "string" && Array.isArray(f.chunks))
            .map((f) => ({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunks: (f.chunks ?? []).map((c) => ({ hash: c.hash, size: c.size }))
            }));
          await putManifest(
            dstSettings,
            dstSnapshotId!,
            {
              snapshot_id: dstSnapshotId!,
              created_unix: Math.floor(Date.now() / 1000),
              files: manifestFiles.map((f) => ({
                path: f.path,
                size: f.size,
                mtime_unix: f.mtime_unix,
                chunk_hash: null,
                chunks: f.chunks
              }))
            },
            ac.signal
          );
        } catch {
          // ignore
        }
      }

      const doneSet = new Set(manifestFiles.map((f) => f.path));
      const pol = job.conflictPolicy ?? "overwrite";

      const uniquePath = (p: string): string => {
        if (!doneSet.has(p)) return p;
        const dot = p.lastIndexOf(".");
        const base = dot > 0 ? p.slice(0, dot) : p;
        const ext = dot > 0 ? p.slice(dot) : "";
        for (let i = 2; i < 1000; i++) {
          const cand = `${base} (${i})${ext}`;
          if (!doneSet.has(cand)) return cand;
        }
        return p;
      };

      // 2) Enumerate all files under the source directory (once; persist for resume).
      if (!filesList || filesList.length === 0) {
        setTransferProgress(id, { phase: "enumerating files", pct: 0 });
        const files: string[] = [];
        const stack: string[] = [job.srcDirPath || ""];
        while (stack.length > 0) {
          const cur = stack.pop()!;
          const tr = await getTree(srcSettings, job.srcSnapshotId, cur, ac.signal);
          for (const e of tr.entries) {
            const child = cur ? `${cur}/${e.name}` : e.name;
            if (e.kind === "dir") stack.push(child);
            else files.push(child);
          }
          if (stack.length + files.length > 200000) throw new Error("too many files for desktop copy");
        }
        files.sort();
        patchTransfer(id, (x) => ({ ...(x as any), filePaths: files, nextIndex: 0 }));
        filesList = files;
        nextIndex = 0;
      }

      const total = filesList.length;

      const bytesPerSec = getRateLimitBytesPerSec();

      // Destination chunk cache to reduce repeat presence checks across many files.
      const destKnownHave = new Set<string>();
      const destKnownMissing = new Set<string>();
      const ensureMissingOnDest = async (hashes: string[]) => {
        const unknown: string[] = [];
        for (const h of hashes) {
          if (destKnownHave.has(h) || destKnownMissing.has(h)) continue;
          unknown.push(h);
        }
        if (unknown.length > 0) {
          const miss = new Set(await ensureMissingOnDestShared(dstSettings, unknown, ac.signal));
          for (const h of unknown) {
            if (miss.has(h)) destKnownMissing.add(h);
            else destKnownHave.add(h);
          }
        }
        const missing: string[] = [];
        for (const h of hashes) if (destKnownMissing.has(h)) missing.push(h);
        return missing;
      };

      // Best-effort optimization: use the source manifest chunk lists to transfer by chunks (no full-file download).
      // Falls back to file download if the source manifest is unavailable or missing chunk metadata.
      let srcChunkMap: Map<
        string,
        { size: number; mtime_unix: number; chunks: { hash: string; size: number }[] }
      > = new Map();
      try {
        setTransferProgress(id, { phase: "loading source manifest", pct: 0 });
        const sm = await getManifest(srcSettings, job.srcSnapshotId, ac.signal);
        for (const f of sm.files ?? []) {
          if (!f?.path || !Array.isArray(f.chunks) || f.chunks.length === 0) continue;
          srcChunkMap.set(f.path, {
            size: f.size,
            mtime_unix: f.mtime_unix,
            chunks: f.chunks.map((c) => ({ hash: c.hash, size: c.size }))
          });
        }
      } catch {
        srcChunkMap = new Map();
      }

      // 3) Copy files with bounded per-job concurrency.
      // Data transfer can happen concurrently, but manifest updates + writes are serialized for correctness and resume.
      let manifestLock = Promise.resolve<void>(undefined);
      const withManifestLock = async <T,>(fn: () => Promise<T>) => {
        const prev = manifestLock;
        let release!: () => void;
        manifestLock = new Promise<void>((res) => {
          release = res;
        });
        await prev;
        try {
          return await fn();
        } finally {
          release();
        }
      };

      let contigNext = nextIndex;
      const completed = new Set<number>();
      let filesDoneCount = contigNext;
      const markCompletedLocked = (i: number) => {
        if (i < contigNext) return;
        if (completed.has(i)) return;
        completed.add(i);
        filesDoneCount++;
        while (completed.has(contigNext)) {
          completed.delete(contigNext);
          contigNext++;
        }
        patchTransfer(id, (x) => ({ ...(x as any), nextIndex: contigNext }));
      };
      const markCompleted = async (i: number) => {
        await withManifestLock(async () => {
          markCompletedLocked(i);
        });
      };

      const phasePrefix = () => (total > 0 ? `[${Math.min(filesDoneCount, total)}/${total}] ` : "");

      const writeManifestNow = async () => {
        await putManifest(
          dstSettings,
          dstSnapshotId!,
          {
            snapshot_id: dstSnapshotId!,
            created_unix: Math.floor(Date.now() / 1000),
            files: manifestFiles.map((f) => ({
              path: f.path,
              size: f.size,
              mtime_unix: f.mtime_unix,
              chunk_hash: null,
              chunks: f.chunks
            }))
          },
          ac.signal
        );
      };

      const processOne = async (i: number) => {
        const srcFilePath = filesList[i]!;
        const rel = job.srcDirPath ? srcFilePath.slice(job.srcDirPath.length + 1) : srcFilePath;
        let dstFilePath = job.dstDirPath ? `${job.dstDirPath}/${rel}` : rel;

        // Choose a final destination path (and reserve it) under a lock to avoid rename collisions.
        const plan = await withManifestLock(async () => {
          if (doneSet.has(dstFilePath)) {
            if (pol === "skip") return { kind: "skip" as const, dstFilePath };
            if (pol === "rename") {
              dstFilePath = uniquePath(dstFilePath);
            } else if (pol === "overwrite") {
              // Remove existing entry before rewriting.
              manifestFiles = manifestFiles.filter((f) => f.path !== dstFilePath);
              doneSet.delete(dstFilePath);
            }
          }
          // Reserve so parallel workers won't pick the same name while the upload is in flight.
          doneSet.add(dstFilePath);
          return { kind: "copy" as const, dstFilePath };
        });

        if (plan.kind === "skip") {
          const pct = total > 0 ? Math.floor(((i + 1) / total) * 100) : 0;
          setTransferProgress(id, { phase: `${phasePrefix()}skipping ${plan.dstFilePath}`, pct });
          await markCompleted(i);
          return;
        }

        dstFilePath = plan.dstFilePath;

        const srcMeta = srcChunkMap.get(srcFilePath);
        if (srcMeta) {
          // Chunk-level copy: download missing chunks by hash and upload to destination.
          const hashes = srcMeta.chunks.map((c) => c.hash);
          setTransferProgress(id, {
            phase: `${phasePrefix()}checking chunks ${srcFilePath}`,
            pct: total > 0 ? Math.floor((i / total) * 100) : 0
          });
          const missing = new Set(await ensureMissingOnDest(hashes));

          const missingBytesTotal = srcMeta.chunks.reduce((acc, c) => acc + (missing.has(c.hash) ? c.size : 0), 0);
          let missingBytesDone = 0;
          let dlDone = 0;
          let ulDone = 0;
          const dlLimiter = makeLimiter(bytesPerSec);
          const ulLimiter = makeLimiter(bytesPerSec);

          const toCopy = srcMeta.chunks.filter((c) => missing.has(c.hash));
          const maxChunkConcurrency = Math.min(4, Math.max(1, toCopy.length));
          let idx = 0;
          await Promise.all(
            Array.from({ length: maxChunkConcurrency }, async () => {
              while (idx < toCopy.length) {
                const c = toCopy[idx++]!;
                const frac = missingBytesTotal > 0 ? missingBytesDone / missingBytesTotal : 1;
                const pct = total > 0 ? Math.floor(((i + frac) / total) * 100) : 0;
                setTransferProgress(id, {
                  phase: `${phasePrefix()}copying chunks (${Math.min(idx, toCopy.length)}/${toCopy.length}) (${srcFilePath})`,
                  doneBytes: missingBytesDone,
                  totalBytes: missingBytesTotal,
                  pct
                });

                const bytes = await withRetry(async () => {
                  return await getChunkBytes(srcSettings, c.hash, ac.signal);
                });
                dlDone += bytes.byteLength;
                if (dlLimiter) await dlLimiter(dlDone);

                await withRetry(async () => {
                  await putChunkDedup(dstSettings, c.hash, bytes, ac.signal);
                });
                ulDone += bytes.byteLength;
                if (ulLimiter) await ulLimiter(ulDone);

                missingBytesDone += c.size;
                const frac2 = missingBytesTotal > 0 ? missingBytesDone / missingBytesTotal : 1;
                const pct2 = total > 0 ? Math.floor(((i + frac2) / total) * 100) : 0;
                setTransferProgress(id, {
                  phase: `${phasePrefix()}copying chunks (${Math.min(idx, toCopy.length)}/${toCopy.length}) (${srcFilePath})`,
                  doneBytes: missingBytesDone,
                  totalBytes: missingBytesTotal,
                  pct: pct2
                });
              }
            })
          );

          // Serialize manifest update + write so we don't race with other files.
          await withManifestLock(async () => {
            manifestFiles.push({
              path: dstFilePath,
              size: srcMeta.size,
              mtime_unix: srcMeta.mtime_unix,
              chunks: srcMeta.chunks
            });
            await writeManifestNow();
            markCompletedLocked(i);
          });
          return;
        }

        const dlLimiter = makeLimiter(bytesPerSec);
        const buf = await withRetry(async () => {
          return await apiGetUint8Array(
            srcSettings,
            `/v1/snapshots/${encodeURIComponent(job.srcSnapshotId)}/file`,
            { path: srcFilePath },
            (done, totalBytes) => {
              const frac = totalBytes && totalBytes > 0 ? done / totalBytes : 0;
              const pct = total > 0 ? Math.floor(((i + frac) / total) * 100) : 0;
              setTransferProgress(id, {
                phase: `${phasePrefix()}downloading ${srcFilePath}`,
                doneBytes: done,
                totalBytes: totalBytes ?? undefined,
                pct
              });
            },
            ac.signal,
            dlLimiter ? async (_chunk, doneBytes) => dlLimiter(doneBytes) : undefined
          );
        });

        setTransferProgress(id, {
          phase: `${phasePrefix()}hashing ${srcFilePath}`,
          pct: total > 0 ? Math.floor(((i + 0.5) / total) * 100) : 0
        });
        const refs = chunkBytes(buf);
        const hashes = refs.map((c) => c.hash);
        const manifestChunks = refs.map((c) => ({ hash: c.hash, size: c.size }));

        // Presence on destination.
        const missing = new Set(await ensureMissingOnDest(hashes));

        // Upload missing chunks.
        const ulLimiter = makeLimiter(bytesPerSec);
        let offset = 0;
        let uploaded = 0;
        for (const c of refs) {
          const end = offset + c.size;
          if (missing.has(c.hash)) {
            await withRetry(async () => {
              await putChunkDedup(dstSettings, c.hash, buf.subarray(offset, end), ac.signal);
            });
            uploaded++;
          }
          offset = end;
          if (ulLimiter) await ulLimiter(offset);
          const pct = total > 0 ? Math.floor(((i + offset / Math.max(1, buf.length)) / total) * 100) : 0;
          setTransferProgress(id, { phase: `${phasePrefix()}uploading ${srcFilePath} (${uploaded}/${missing.size} chunks)`, pct });
        }

        // Serialize manifest update + write so we don't race with other files.
        await withManifestLock(async () => {
          const now = Math.floor(Date.now() / 1000);
          manifestFiles.push({
            path: dstFilePath,
            size: buf.length,
            mtime_unix: now,
            chunks: manifestChunks
          });
          await writeManifestNow();
          markCompletedLocked(i);
        });
      };

      const maxFileConcurrency = Math.min(getCopyFolderFileConcurrency(), Math.max(1, total - contigNext));
      let firstErr: any = null;
      let nextToStart = contigNext;
      await Promise.all(
        Array.from({ length: maxFileConcurrency }, async () => {
          while (true) {
            if (firstErr) return;
            const i = nextToStart++;
            if (i >= total) return;
            try {
              await processOne(i);
            } catch (e: any) {
              if (!firstErr) firstErr = e;
              try {
                ac.abort();
              } catch {
                // ignore
              }
              return;
            }
          }
        })
      );
      if (firstErr) throw firstErr;

      setTransferProgress(id, { phase: "writing manifest", pct: 99 });
      await putManifest(
        dstSettings,
        dstSnapshotId!,
        {
          snapshot_id: dstSnapshotId!,
          created_unix: Math.floor(Date.now() / 1000),
          files: manifestFiles.map((e) => ({
            path: e.path,
            size: e.size,
            mtime_unix: e.mtime_unix,
            chunk_hash: null,
            chunks: e.chunks
          }))
        },
        ac.signal
      );

      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "done", error: undefined, progress: undefined } : x))
      );
    } catch (e: any) {
      if (isAbortError(e)) {
        setTransfers((xs) =>
          xs.map((x) => (x.id === id ? { ...x, status: "failed", error: "canceled", progress: undefined } : x))
        );
        return;
      }
      const msg = String(e?.message ?? e);
      setTransfers((xs) =>
        xs.map((x) => (x.id === id ? { ...x, status: "failed", error: msg, progress: undefined } : x))
      );
    } finally {
      clearAborter(id);
    }
  };

  const runTransfer = async (id: string) => {
    const job = transfers.find((x) => x.id === id);
    if (!job) return;
    if (job.kind === "download") return downloadNow(id);
    if (job.kind === "copy_file") return copyNow(id);
    if (job.kind === "copy_folder") return copyFolderNow(id);
    if (job.kind === "sftp_download") return sftpDownloadNow(id);
    if (job.kind === "sftp_upload") return sftpUploadNow(id);
    if (job.kind === "snapshot_to_sftp") return snapshotToSftpNow(id);
    if (job.kind === "sftp_to_snapshot") return sftpToSnapshotNow(id);
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
          <div
            className="tab-label"
            title="Workspace = a tab + its view state. Use multiple tabs to switch tasks."
            aria-hidden="true"
          >
            Workspaces
          </div>
          {state.tabs.map((t) => (
            <div
              key={t.id}
              className={t.id === activeTab.id ? "tab ui-item active" : "tab ui-item"}
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

        <button className="btn" title="Preferences (Ctrl/⌘ + ,)" onClick={openPrefs}>
          Prefs
        </button>

        <button className="btn" title="Toggle theme" onClick={toggleTheme}>
          {settings.theme.mode === "dark" ? "Dark" : "Light"}
        </button>

        <button className="btn primary" onClick={onNewTab} title="New tab">
          + Tab
        </button>
      </div>

      <CommandPalette open={showCommand} onClose={() => setShowCommand(false)} commands={commands} />

      {showPrefs ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Preferences">
          <div className="modal-panel prefs-panel">
            <div className="modal-header prefs-header">
              <div className="prefs-title">Preferences</div>
              <button className="btn" onClick={() => setShowPrefs(false)} title="Close">
                Close
              </button>
            </div>

            <div className="modal-body prefs-body">
              <div className="prefs-row">
                <label className="prefs-label">Theme mode</label>
                <select
                  className="prefs-input"
                  value={settings.theme.mode}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      theme: { ...s.theme, mode: e.target.value as any }
                    }))
                  }
                >
                  <option value="dark">dark</option>
                  <option value="light">light</option>
                  <option value="auto">auto</option>
                </select>
              </div>

              <div className="prefs-row">
                <label className="prefs-label">Radius</label>
                <input
                  className="prefs-range"
                  type="range"
                  min={0}
                  max={12}
                  value={settings.theme.radiusPx}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      theme: { ...s.theme, radiusPx: Number(e.target.value) }
                    }))
                  }
                />
                <div className="prefs-hint">{settings.theme.radiusPx}px</div>
              </div>

              <div className="prefs-row">
                <label className="prefs-label">Font size</label>
                <input
                  className="prefs-range"
                  type="range"
                  min={12}
                  max={18}
                  value={settings.theme.fontSizePx}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      theme: { ...s.theme, fontSizePx: Number(e.target.value) }
                    }))
                  }
                />
                <div className="prefs-hint">{settings.theme.fontSizePx}px</div>
              </div>
            </div>

            <div className="modal-footer prefs-footer">
              <button
                className="btn"
                title="Copy preferences JSON"
                onClick={async () => {
                  const json = JSON.stringify(settings, null, 2);
                  try {
                    await navigator.clipboard.writeText(json);
                  } catch {
                    // Fallback: prompt copy.
                    window.prompt("Copy settings JSON:", json);
                  }
                }}
              >
                Export JSON
              </button>

              <button
                className="btn"
                title="Paste preferences JSON (replaces current settings)"
                onClick={() => {
                  const pasted = window.prompt("Paste settings JSON:");
                  if (!pasted) return;
                  try {
                    const parsed = JSON.parse(pasted);
                    // Reuse the loader's validation logic by persisting and reloading.
                    localStorage.setItem("filedock.desktop.settings.v1", JSON.stringify(parsed));
                    setSettings(loadSettings());
                  } catch {
                    window.alert("Invalid JSON");
                  }
                }}
              >
                Import JSON
              </button>
            </div>
          </div>
          <button className="modal-backdrop" aria-label="Close" onClick={() => setShowPrefs(false)} />
        </div>
      ) : null}

      <div className="workspace" role="main">
        <WorkspaceView
          tab={activeTab}
          settings={settings}
          transfers={transfers}
          onEnqueueDownload={enqueueDownload}
          onEnqueueSftpDownload={enqueueSftpDownload}
          onEnqueueSftpUpload={enqueueSftpUpload}
          onEnqueueSnapshotToSftp={enqueueSnapshotToSftp}
          onEnqueueSftpToSnapshot={enqueueSftpToSnapshot}
          onEnqueueCopy={enqueueCopy}
          onEnqueueCopyFolder={enqueueCopyFolder}
          onRemoveTransfer={removeTransfer}
          onRunTransfer={runTransfer}
          onCancelTransfer={cancelTransfer}
          onUpdateTransfer={updateTransfer}
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
        <span className="kbd">Source</span> switch Local / Server / SFTP / Queue / Notes
        <span className="kbd">+ Tab</span> new workspace
        <span className="kbd">Persist</span> state saved locally per tab
      </div>
    </div>
  );
}
