import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceView } from "./components/WorkspaceView";
import NoticeCenter, { type NoticeLevel, type NoticeItem } from "./components/NoticeCenter";
import AgentOnboardingModal from "./components/AgentOnboardingModal";
import {
  DEFAULT_APP_STATE,
  type AppState,
  type TabState,
  newTab,
  removeTab
} from "./model/state";
import {
  activeTab as activeLeafTab,
  findLeaf,
  leafFromPane,
  leafFromTab,
  setLeafPane,
  splitLeafWithLeaf,
  type LayoutNode,
  type LeafNode,
  type PaneKind,
  type PaneTab,
  uid as layoutUid
} from "./model/layout";
import { loadActiveLeafByTab, loadState, saveActiveLeafByTab, saveState } from "./model/storage";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type LocaleSetting,
  type SavedNodePreset,
  type SavedTerminalPreset,
  type Settings
} from "./model/settings";
import { makeTerminalTabFromPreset, terminalPresetFromPane } from "./model/terminalPresets";
import {
  classifyServiceError,
  isSameSavedNodeConfig,
  isSameSavedTerminalConfig,
  parseServerConfigImport,
  suggestTerminalPresetName
} from "./model/presetUtils";
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
  getHealth,
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
import Icon from "./components/Icon";
import { emitPaneCommand } from "./commandBus";
import { setLanguage } from "./i18n";
import { isTauri } from "./util/tauriEnv";

const QUEUE_KEY = "filedock.desktop.queue.v1";

type ServiceStatus = {
  kind: "checking" | "online" | "offline" | "error";
  message?: string;
  version?: string;
};

export default function App() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<AppState>(() => loadState() ?? DEFAULT_APP_STATE);
  const [settings, setSettings] = useState<Settings>(() => loadSettings() ?? DEFAULT_SETTINGS);
  const [transfers, setTransfers] = useState<TransferJob[]>(() => loadTransfers());
  const [showPrefs, setShowPrefs] = useState(false);
  const [showCommand, setShowCommand] = useState(false);
  const [showQrImport, setShowQrImport] = useState(false);
  const [showAgentSetup, setShowAgentSetup] = useState(false);
  const [qrPayload, setQrPayload] = useState("");
  const [showConnHelp, setShowConnHelp] = useState(false);
  const [activeLeafByTab, setActiveLeafByTab] = useState<Record<string, string>>(() => loadActiveLeafByTab());
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>({ kind: "checking" });
  const webPreview = !isTauri();
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

  const dismissNotice = useCallback((id: string) => {
    setNotices((items) => items.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback(
    (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => {
      const id = uid("notice");
      const noticeTitle = title ?? t(`notice.${level}` as any);
      const entry: NoticeItem = { id, level, title: noticeTitle, message };
      setNotices((items) => [...items, entry]);
      const ttl =
        autoCloseMs ??
        (level === "error" ? 9000 : level === "warning" ? 6500 : 4500);
      if (ttl > 0) {
        window.setTimeout(() => dismissNotice(id), ttl);
      }
    },
    [dismissNotice, t]
  );

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
    saveActiveLeafByTab(activeLeafByTab);
  }, [activeLeafByTab]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    setLanguage(settings.locale);
  }, [settings.locale]);

  useEffect(() => {
    saveTransfers(transfers);
  }, [transfers]);

  useEffect(() => {
    let cancelled = false;
    let currentAbort: AbortController | null = null;
    const serverBaseUrl = settings.serverBaseUrl.trim();

    if (!serverBaseUrl) {
      setServiceStatus({ kind: "offline" });
      return () => {
        cancelled = true;
      };
    }

    const checkHealth = async (showChecking: boolean) => {
      if (showChecking) {
        setServiceStatus((prev) => ({
          kind: "checking",
          message: prev.message,
          version: prev.version
        }));
      }

      currentAbort?.abort();
      const aborter = new AbortController();
      currentAbort = aborter;

      try {
        const health = await getHealth(settings, aborter.signal);
        if (cancelled || aborter.signal.aborted) return;
        setServiceStatus({
          kind: health.status === "ok" ? "online" : "error",
          message: health.status === "ok" ? undefined : health.status,
          version: health.version
        });
      } catch (e: any) {
        if (cancelled || aborter.signal.aborted) return;
        const message = String(e?.message ?? e).trim();
        setServiceStatus({ kind: classifyServiceError(message), message });
      }
    };

    void checkHealth(true);
    const intervalId = window.setInterval(() => {
      void checkHealth(false);
    }, 15_000);

    return () => {
      cancelled = true;
      currentAbort?.abort();
      window.clearInterval(intervalId);
    };
  }, [settings]);

  const activeTab: TabState = useMemo(() => {
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    return t ?? state.tabs[0];
  }, [state]);

  const activeLeafId = useMemo(() => {
    const preferred = activeLeafByTab[activeTab.id];
    if (preferred && findLeaf(activeTab.root, preferred)) return preferred;
    return getActiveLeafId(activeTab);
  }, [activeLeafByTab, activeTab]);

  const activePane = useMemo(() => {
    if (!activeLeafId) return null;
    const leaf = findLeaf(activeTab.root, activeLeafId);
    if (!leaf) return null;
    return activeLeafTab(leaf);
  }, [activeLeafId, activeTab]);

  const activeTerminalPreset = useMemo(() => {
    if (!activePane) return null;
    return terminalPresetFromPane(activePane);
  }, [activePane]);

  const setActiveTab = (tabId: string) => {
    setState((s) => ({ ...s, activeTabId: tabId }));
  };

  const setActiveLeaf = (tabId: string, leafId: string) => {
    setActiveLeafByTab((prev) => ({ ...prev, [tabId]: leafId }));
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

  const openTerminalInNewPane = useCallback(
    (terminalTab: PaneTab) => {
      const leafId = getActiveLeafId(activeTab);
      if (!leafId) return;
      const leaf = leafFromTab(terminalTab);
      updateActiveRoot((root) => splitLeafWithLeaf(root, leafId, "row", leaf, 0.5));
      setActiveLeaf(activeTab.id, leaf.id);
    },
    [activeTab, getActiveLeafId, setActiveLeaf, updateActiveRoot]
  );

  const collectLeaves = (node: LayoutNode, acc: LeafNode[] = []): LeafNode[] => {
    if (node.kind === "leaf") {
      acc.push(node);
      return acc;
    }
    collectLeaves(node.a, acc);
    collectLeaves(node.b, acc);
    return acc;
  };

  const gatherColumns = (node: LayoutNode): LayoutNode[] => {
    if (node.kind === "split" && node.dir === "row") {
      return [...gatherColumns(node.a), ...gatherColumns(node.b)];
    }
    return [node];
  };

  const collectColumnLeaves = (node: LayoutNode): LeafNode[] => {
    if (node.kind === "leaf") return [node];
    if (node.dir === "col") return [...collectColumnLeaves(node.a), ...collectColumnLeaves(node.b)];
    return collectLeaves(node, []);
  };

  const collectLeavesForAddView = (root: LayoutNode): LeafNode[] => {
    const columns = gatherColumns(root);
    const colLeaves = columns.map((col) => collectColumnLeaves(col));
    const maxRows = colLeaves.reduce((m, col) => Math.max(m, col.length), 0);
    const order: LeafNode[] = [];
    for (let c = 0; c < colLeaves.length; c += 1) {
      if (colLeaves[c]?.[0]) order.push(colLeaves[c]![0]!);
    }
    for (let r = 1; r < maxRows; r += 1) {
      for (let c = colLeaves.length - 1; c >= 0; c -= 1) {
        const leaf = colLeaves[c]?.[r];
        if (leaf) order.push(leaf);
      }
    }
    return order;
  };

  const buildRowLayout = (columns: LayoutNode[]): LayoutNode => {
    if (columns.length === 1) return columns[0]!;
    const [first, ...rest] = columns;
    const ratio = 1 / columns.length;
    return {
      kind: "split",
      id: layoutUid("split"),
      dir: "row",
      ratio,
      a: first,
      b: buildRowLayout(rest)
    };
  };

  const describeLayout = (node: LayoutNode): string => {
    if (node.kind === "leaf") return `leaf(${node.id})`;
    const tag = node.dir === "row" ? "row" : "col";
    const ratio = Number.isFinite(node.ratio) ? node.ratio.toFixed(3) : "nan";
    return `${tag}(${ratio})[${describeLayout(node.a)}|${describeLayout(node.b)}]`;
  };

  const buildColLayout = (colLeaves: LeafNode[]): LayoutNode => {
    if (colLeaves.length === 1) return colLeaves[0]!;
    const [first, ...rest] = colLeaves;
    return {
      kind: "split",
      id: layoutUid("split"),
      dir: "col",
      ratio: 1 / colLeaves.length,
      a: first,
      b: buildColLayout(rest)
    };
  };

  const buildAddViewLayout = (leaves: LeafNode[]): LayoutNode => {
    const total = leaves.length;
    if (total <= 1) return leaves[0]!;
    if (total <= 5) {
      console.info("[layout:add-view] row-equal", { total });
      return buildRowLayout(leaves);
    }

    const cols = 5;
    const rows = Math.ceil(total / cols);
    const grid: Array<Array<LeafNode | null>> = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => null)
    );

    let idx = 0;
    for (let c = 0; c < cols && idx < total; c += 1) {
      grid[0]![c] = leaves[idx++]!;
    }
    for (let r = 1; r < rows && idx < total; r += 1) {
      for (let c = cols - 1; c >= 0 && idx < total; c -= 1) {
        grid[r]![c] = leaves[idx++]!;
      }
    }

    const columns: LayoutNode[] = [];
    for (let c = 0; c < cols; c += 1) {
      const colLeaves: LeafNode[] = [];
      for (let r = 0; r < rows; r += 1) {
        const leaf = grid[r]![c];
        if (leaf) colLeaves.push(leaf);
      }
      columns.push(buildColLayout(colLeaves));
    }

    console.info("[layout:add-view] grid", { total, rows, cols });
    return buildRowLayout(columns);
  };

  const addView = () => {
    const newLeaf = leafFromPane("localBrowser");
    updateActiveRoot((root) => {
      const leaves = collectLeavesForAddView(root);
      const next = buildAddViewLayout([...leaves, newLeaf]);
      console.info("[layout:add-view] built", {
        before: leaves.length,
        after: leaves.length + 1,
        layout: describeLayout(next)
      });
      return next;
    });
    setActiveLeaf(activeTab.id, newLeaf.id);
  };

  const addTerminalView = () => {
    const newLeaf = leafFromPane("terminal");
    updateActiveRoot((root) => {
      const leaves = collectLeavesForAddView(root);
      return buildAddViewLayout([...leaves, newLeaf]);
    });
    setActiveLeaf(activeTab.id, newLeaf.id);
  };

  const goToNextWorkspace = (dir: 1 | -1) => {
    const idx = state.tabs.findIndex((t) => t.id === activeTab.id);
    if (idx < 0) return;
    const next = (idx + dir + state.tabs.length) % state.tabs.length;
    const target = state.tabs[next];
    if (target) setActiveTab(target.id);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingTarget =
        !!target &&
        (target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select");
      const isMod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

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
        setShowQrImport(false);
        setShowAgentSetup(false);
      }

      if (showCommand || showPrefs || showQrImport || showAgentSetup) return;

      if (isTypingTarget) return;

      if (isMod && !e.shiftKey && !e.altKey) {
        switch (key) {
          case "1":
            e.preventDefault();
            setActiveLeafPane("deviceBrowser");
            return;
          case "2":
            e.preventDefault();
            setActiveLeafPane("localBrowser");
            return;
          case "3":
            e.preventDefault();
            setActiveLeafPane("sftpBrowser");
            return;
          case "4":
            e.preventDefault();
            setActiveLeafPane("transferQueue");
            return;
          case "5":
            e.preventDefault();
            setActiveLeafPane("notes");
            return;
          default:
            break;
        }
      }

      if (isMod && e.shiftKey && !e.altKey) {
        if (key === "[" || key === "{") {
          e.preventDefault();
          goToNextWorkspace(-1);
          return;
        }
        if (key === "]" || key === "}") {
          e.preventDefault();
          goToNextWorkspace(1);
          return;
        }
        if (key === "r") {
          if (activePane?.pane === "deviceBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "device.refresh", paneId: activePane.id });
            return;
          }
          if (activePane?.pane === "localBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "local.refresh", paneId: activePane.id });
            return;
          }
          if (activePane?.pane === "sftpBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "sftp.refresh", paneId: activePane.id });
            return;
          }
        }
        if (key === "u") {
          if (activePane?.pane === "deviceBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "device.upload", paneId: activePane.id });
            return;
          }
          if (activePane?.pane === "sftpBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "sftp.upload", paneId: activePane.id });
            return;
          }
        }
        if (key === "o") {
          if (activePane?.pane === "localBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "local.choose", paneId: activePane.id });
            return;
          }
        }
        if (key === "n") {
          if (activePane?.pane === "sftpBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "sftp.mkdir", paneId: activePane.id });
            return;
          }
        }
        if (key === "h") {
          if (activePane?.pane === "deviceBrowser") {
            e.preventDefault();
            emitPaneCommand({ kind: "device.toggleHistory", paneId: activePane.id });
            return;
          }
        }
      }

      if (!isMod && e.altKey && e.key === "ArrowUp") {
        if (activePane?.pane === "deviceBrowser") {
          e.preventDefault();
          emitPaneCommand({ kind: "device.up", paneId: activePane.id });
          return;
        }
        if (activePane?.pane === "localBrowser") {
          e.preventDefault();
          emitPaneCommand({ kind: "local.up", paneId: activePane.id });
          return;
        }
        if (activePane?.pane === "sftpBrowser") {
          e.preventDefault();
          emitPaneCommand({ kind: "sftp.up", paneId: activePane.id });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePane, goToNextWorkspace, setActiveLeafPane, showAgentSetup, showCommand, showPrefs, showQrImport]);

  const onNewTab = () => {
    setState((s) => {
      const nextTab = newTab(t("tab.workspace"));
      return {
        ...s,
        tabs: [...s.tabs, nextTab],
        activeTabId: nextTab.id
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

  const openAgentSetup = () => {
    setShowAgentSetup(true);
    setShowPrefs(false);
    setShowCommand(false);
  };

  const openQrImport = () => {
    setQrPayload("");
    setShowQrImport(true);
    setShowCommand(false);
  };

  const applyImportJson = (raw: string | null | undefined) => {
    const payload = raw?.trim();
    if (!payload) return false;
    try {
      const parsed = JSON.parse(payload);
      const serverConfig = parseServerConfigImport(parsed);
      if (serverConfig) {
        setSettings((s) => ({
          ...s,
          serverBaseUrl: serverConfig.serverBaseUrl,
          token: serverConfig.token ?? "",
          deviceId: serverConfig.deviceId ?? "",
          deviceToken: serverConfig.deviceToken ?? ""
        }));
        return true;
      }
      // Reuse the loader's validation logic by persisting and reloading.
      localStorage.setItem("filedock.desktop.settings.v1", JSON.stringify(parsed));
      setSettings(loadSettings());
      return true;
    } catch {
      window.alert(t("app.prefs.invalidJson"));
      return false;
    }
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

  const applySavedNode = useCallback(
    (name: string) => {
      const node = settings.savedNodes.find((item) => item.name === name);
      if (!node) return;
      setSettings((s) => ({
        ...s,
        serverBaseUrl: node.serverBaseUrl,
        token: node.token,
        deviceId: node.deviceId,
        deviceToken: node.deviceToken
      }));
      notify("info", t("app.conn.savedNodes.applied", { name: node.name }));
    },
    [notify, settings.savedNodes, t]
  );

  const saveCurrentNode = useCallback(() => {
    const serverBaseUrl = settings.serverBaseUrl.trim();
    if (!serverBaseUrl) {
      notify("warning", t("app.conn.savedNodes.serverRequired"));
      return;
    }
    const matched = settings.savedNodes.find((item) => isSameSavedNodeConfig(item, settings));
    const nameRaw = window.prompt(t("app.conn.savedNodes.savePrompt"), matched?.name ?? serverBaseUrl);
    if (nameRaw === null) return;
    const name = nameRaw.trim();
    if (!name) {
      notify("warning", t("app.conn.savedNodes.nameRequired"));
      return;
    }

    const nextNode: SavedNodePreset = {
      name,
      serverBaseUrl,
      token: settings.token,
      deviceId: settings.deviceId,
      deviceToken: settings.deviceToken
    };
    const existingIndex = settings.savedNodes.findIndex((item) => item.name === name);
    setSettings((s) => {
      const nextSavedNodes = [...s.savedNodes];
      const index = nextSavedNodes.findIndex((item) => item.name === name);
      if (index >= 0) {
        nextSavedNodes[index] = nextNode;
      } else {
        nextSavedNodes.push(nextNode);
      }
      return { ...s, savedNodes: nextSavedNodes };
    });
    notify("info", t(existingIndex >= 0 ? "app.conn.savedNodes.updated" : "app.conn.savedNodes.saved", { name }));
  }, [notify, settings, t]);

  const suggestTerminalPresetNameForPrompt = useCallback(
    (preset: SavedTerminalPreset) =>
      suggestTerminalPresetName(preset, {
        localDefault: t("app.conn.savedTerminals.localDefault"),
        vps: t("tab.vps")
      }),
    [t]
  );

  const applySavedTerminal = useCallback(
    (name: string) => {
      const preset = settings.savedTerminals.find((item) => item.name === name);
      if (!preset) return;
      openTerminalInNewPane(makeTerminalTabFromPreset(preset));
      notify("info", t("app.conn.savedTerminals.opened", { name: preset.name }));
    },
    [notify, openTerminalInNewPane, settings.savedTerminals, t]
  );

  const saveCurrentTerminalPreset = useCallback(() => {
    if (!activeTerminalPreset) {
      notify("warning", t("app.conn.savedTerminals.sourceRequired"));
      return;
    }

    const matched = settings.savedTerminals.find((item) => isSameSavedTerminalConfig(item, activeTerminalPreset));
    const nameRaw = window.prompt(
      t("app.conn.savedTerminals.savePrompt"),
      matched?.name ?? suggestTerminalPresetNameForPrompt(activeTerminalPreset)
    );
    if (nameRaw === null) return;

    const name = nameRaw.trim();
    if (!name) {
      notify("warning", t("app.conn.savedTerminals.nameRequired"));
      return;
    }

    const nextPreset: SavedTerminalPreset = {
      ...activeTerminalPreset,
      name
    };
    const existingIndex = settings.savedTerminals.findIndex((item) => item.name === name);
    setSettings((s) => {
      const nextSavedTerminals = [...s.savedTerminals];
      const index = nextSavedTerminals.findIndex((item) => item.name === name);
      if (index >= 0) {
        nextSavedTerminals[index] = nextPreset;
      } else {
        nextSavedTerminals.push(nextPreset);
      }
      return { ...s, savedTerminals: nextSavedTerminals };
    });
    notify(
      "info",
      t(existingIndex >= 0 ? "app.conn.savedTerminals.updated" : "app.conn.savedTerminals.saved", { name })
    );
  }, [activeTerminalPreset, notify, settings.savedTerminals, suggestTerminalPresetNameForPrompt, t]);

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
    const themeModeLabel =
      settings.theme.mode === "dark"
        ? t("app.prefs.themeOption.dark")
        : settings.theme.mode === "light"
          ? t("app.prefs.themeOption.light")
          : t("app.prefs.themeOption.auto");
    const workspaceLabel = t("tab.workspace");
    const items: CommandItem[] = [
      {
        id: "prefs",
        title: t("command.prefs.title"),
        hint: t("command.prefs.hint"),
        shortcut: "Ctrl/⌘ + ,",
        run: openPrefs
      },
      {
        id: "agent-setup",
        title: t("command.onboarding.title"),
        hint: t("command.onboarding.hint"),
        keywords: t("command.keywords.onboarding"),
        run: openAgentSetup
      },
      {
        id: "new-tab",
        title: t("command.newTab.title"),
        run: onNewTab
      },
      {
        id: "toggle-theme",
        title: settings.theme.mode === "dark" ? t("command.theme.toggleToLight") : t("command.theme.toggleToDark"),
        hint: t("command.theme.hint", { mode: themeModeLabel }),
        run: toggleTheme
      }
    ];

    items.push(
      {
        id: "view-device",
        title: t("command.view.device"),
        keywords: t("command.keywords.viewDevice"),
        shortcut: "Ctrl/⌘ + 1",
        run: () => setActiveLeafPane("deviceBrowser")
      },
      {
        id: "view-local",
        title: t("command.view.local"),
        keywords: t("command.keywords.viewLocal"),
        shortcut: "Ctrl/⌘ + 2",
        run: () => setActiveLeafPane("localBrowser")
      },
      {
        id: "view-sftp",
        title: t("command.view.sftp"),
        keywords: t("command.keywords.viewSftp"),
        shortcut: "Ctrl/⌘ + 3",
        run: () => setActiveLeafPane("sftpBrowser")
      },
      {
        id: "view-terminal",
        title: t("command.view.terminal"),
        keywords: t("command.keywords.viewTerminal"),
        run: () => setActiveLeafPane("terminal")
      },
      {
        id: "view-queue",
        title: t("command.view.queue"),
        keywords: t("command.keywords.viewQueue"),
        shortcut: "Ctrl/⌘ + 4",
        run: () => setActiveLeafPane("transferQueue")
      },
      {
        id: "view-notes",
        title: t("command.view.notes"),
        keywords: t("command.keywords.viewNotes"),
        shortcut: "Ctrl/⌘ + 5",
        run: () => setActiveLeafPane("notes")
      }
    );

    items.push(
      {
        id: "queue-run-queued",
        title: t("command.queue.runQueued"),
        keywords: t("command.keywords.queueRunQueued"),
        run: () => runTransfers("queued")
      },
      {
        id: "queue-retry-failed",
        title: t("command.queue.retryFailed"),
        keywords: t("command.keywords.queueRetryFailed"),
        run: () => runTransfers("failed")
      },
      {
        id: "queue-run-all",
        title: t("command.queue.runAll"),
        keywords: t("command.keywords.queueRunAll"),
        run: () => runTransfers("all")
      },
      {
        id: "queue-cancel-running",
        title: t("command.queue.cancelRunning"),
        keywords: t("command.keywords.queueCancelRunning"),
        run: cancelRunningTransfers
      },
      {
        id: "queue-clear-done",
        title: t("command.queue.clearDone"),
        keywords: t("command.keywords.queueClearDone"),
        run: clearDoneTransfers
      }
    );

    const paneId = activePane?.id ?? "";
    if (activePane?.pane === "deviceBrowser") {
      items.push(
        {
          id: "device-refresh",
          title: t("command.device.refresh"),
          keywords: t("command.keywords.deviceRefresh"),
          shortcut: "Ctrl/⌘ + Shift + R",
          run: () => emitPaneCommand({ kind: "device.refresh", paneId })
        },
        {
          id: "device-upload",
          title: t("command.device.upload"),
          keywords: t("command.keywords.deviceUpload"),
          shortcut: "Ctrl/⌘ + Shift + U",
          run: () => emitPaneCommand({ kind: "device.upload", paneId })
        },
        {
          id: "device-toggle-history",
          title: t("command.device.toggleHistory"),
          keywords: t("command.keywords.deviceToggleHistory"),
          shortcut: "Ctrl/⌘ + Shift + H",
          run: () => emitPaneCommand({ kind: "device.toggleHistory", paneId })
        },
        {
          id: "device-view-all",
          title: t("command.device.viewAll"),
          keywords: t("command.keywords.deviceViewAll"),
          run: () => emitPaneCommand({ kind: "device.viewAll", paneId })
        },
        {
          id: "device-view-history",
          title: t("command.device.viewHistory"),
          keywords: t("command.keywords.deviceViewHistory"),
          run: () => emitPaneCommand({ kind: "device.viewHistory", paneId })
        },
        {
          id: "device-up",
          title: t("command.device.up"),
          keywords: t("command.keywords.deviceUp"),
          shortcut: "Alt + ↑",
          run: () => emitPaneCommand({ kind: "device.up", paneId })
        },
        {
          id: "device-restore",
          title: t("command.device.restore"),
          keywords: t("command.keywords.deviceRestore"),
          run: () => emitPaneCommand({ kind: "device.restore", paneId })
        },
        {
          id: "device-cancel-restore",
          title: t("command.device.cancelRestore"),
          keywords: t("command.keywords.deviceCancelRestore"),
          run: () => emitPaneCommand({ kind: "device.cancelRestore", paneId })
        },
        {
          id: "device-queue-selected",
          title: t("command.device.queueSelected"),
          keywords: t("command.keywords.deviceQueueSelected"),
          run: () => emitPaneCommand({ kind: "device.queueSelected", paneId })
        },
        {
          id: "device-select-all",
          title: t("command.device.selectAll"),
          keywords: t("command.keywords.deviceSelectAll"),
          run: () => emitPaneCommand({ kind: "device.selectAll", paneId })
        },
        {
          id: "device-clear-selection",
          title: t("command.device.clearSelection"),
          keywords: t("command.keywords.deviceClearSelection"),
          run: () => emitPaneCommand({ kind: "device.clearSelection", paneId })
        }
      );
    }

    if (activePane?.pane === "localBrowser") {
      items.push(
        {
          id: "local-choose",
          title: t("command.local.choose"),
          keywords: t("command.keywords.localChoose"),
          shortcut: "Ctrl/⌘ + Shift + O",
          run: () => emitPaneCommand({ kind: "local.choose", paneId })
        },
        {
          id: "local-up",
          title: t("command.local.up"),
          keywords: t("command.keywords.localUp"),
          shortcut: "Alt + ↑",
          run: () => emitPaneCommand({ kind: "local.up", paneId })
        },
        {
          id: "local-refresh",
          title: t("command.local.refresh"),
          keywords: t("command.keywords.localRefresh"),
          shortcut: "Ctrl/⌘ + Shift + R",
          run: () => emitPaneCommand({ kind: "local.refresh", paneId })
        }
      );
    }

    if (activePane?.pane === "sftpBrowser") {
      items.push(
        {
          id: "sftp-refresh",
          title: t("command.sftp.refresh"),
          keywords: t("command.keywords.sftpRefresh"),
          shortcut: "Ctrl/⌘ + Shift + R",
          run: () => emitPaneCommand({ kind: "sftp.refresh", paneId })
        },
        {
          id: "sftp-up",
          title: t("command.sftp.up"),
          keywords: t("command.keywords.sftpUp"),
          shortcut: "Alt + ↑",
          run: () => emitPaneCommand({ kind: "sftp.up", paneId })
        },
        {
          id: "sftp-mkdir",
          title: t("command.sftp.mkdir"),
          keywords: t("command.keywords.sftpMkdir"),
          shortcut: "Ctrl/⌘ + Shift + N",
          run: () => emitPaneCommand({ kind: "sftp.mkdir", paneId })
        },
        {
          id: "sftp-upload",
          title: t("command.sftp.upload"),
          keywords: t("command.keywords.sftpUpload"),
          shortcut: "Ctrl/⌘ + Shift + U",
          run: () => emitPaneCommand({ kind: "sftp.upload", paneId })
        }
      );
    }

    if (activePane?.pane === "transferQueue") {
      items.push(
        {
          id: "queue-run-selected",
          title: t("command.queue.runSelected"),
          keywords: t("command.keywords.queueRunSelected"),
          run: () => emitPaneCommand({ kind: "queue.runSelected", paneId })
        },
        {
          id: "queue-cancel-selected",
          title: t("command.queue.cancelSelected"),
          keywords: t("command.keywords.queueCancelSelected"),
          run: () => emitPaneCommand({ kind: "queue.cancelSelected", paneId })
        },
        {
          id: "queue-remove-selected",
          title: t("command.queue.removeSelected"),
          keywords: t("command.keywords.queueRemoveSelected"),
          run: () => emitPaneCommand({ kind: "queue.removeSelected", paneId })
        },
        {
          id: "queue-select-failed",
          title: t("command.queue.selectFailed"),
          keywords: t("command.keywords.queueSelectFailed"),
          run: () => emitPaneCommand({ kind: "queue.selectFailed", paneId })
        },
        {
          id: "queue-select-queued",
          title: t("command.queue.selectQueued"),
          keywords: t("command.keywords.queueSelectQueued"),
          run: () => emitPaneCommand({ kind: "queue.selectQueued", paneId })
        },
        {
          id: "queue-clear-selection",
          title: t("command.queue.clearSelection"),
          keywords: t("command.keywords.queueClearSelection"),
          run: () => emitPaneCommand({ kind: "queue.clearSelection", paneId })
        }
      );
    }

    for (const [idx, tab] of state.tabs.entries()) {
      items.push({
        id: `workspace-${tab.id}`,
        title: t("command.workspace.switchTo", { name: tab.name || workspaceLabel, index: idx + 1 }),
        hint: t("command.workspace.hint", { index: idx + 1 }),
        run: () => setActiveTab(tab.id)
      });
    }

    if (state.tabs.length > 1) {
      items.push(
        {
          id: "workspace-next",
          title: t("command.workspace.next"),
          keywords: t("command.keywords.workspaceNext"),
          shortcut: "Ctrl/⌘ + Shift + ]",
          run: () => goToNextWorkspace(1)
        },
        {
          id: "workspace-prev",
          title: t("command.workspace.prev"),
          keywords: t("command.keywords.workspacePrev"),
          shortcut: "Ctrl/⌘ + Shift + [",
          run: () => goToNextWorkspace(-1)
        }
      );
    }

    if (state.tabs.length > 1) {
      items.push({
        id: "close-tab",
        title: t("command.workspace.closeActive"),
        hint: t("command.workspace.closeHint", { name: activeTab.name || workspaceLabel }),
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
    i18n.language,
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
    dstRootPath?: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
    note?: string;
    deleteSource?: boolean;
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
      dstRootPath: req.dstRootPath,
      dstPath: req.dstPath,
      conflictPolicy: req.conflictPolicy ?? "overwrite",
      note: req.note,
      deleteSource: req.deleteSource
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
        dst_root_path: job.dstRootPath || undefined,
        dst_path: job.dstPath,
        conflict_policy: job.conflictPolicy ?? "overwrite",
        note: job.note || undefined,
        delete_remote: job.deleteSource ?? false,
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

  const brandMeta = t("app.brand.meta");
  const canApplyQr = qrPayload.trim().length > 0;
  const selectedSavedNodeName =
    settings.savedNodes.find((item) => isSameSavedNodeConfig(item, settings))?.name ?? "";
  const serviceStatusText =
    serviceStatus.kind === "online"
      ? t("app.conn.serviceStatus.online")
      : serviceStatus.kind === "offline"
        ? t("app.conn.serviceStatus.offline")
        : serviceStatus.kind === "error"
          ? t("app.conn.serviceStatus.error")
          : t("app.conn.serviceStatus.checking");
  const serviceStatusTitle = [
    t("app.conn.serviceStatus.title"),
    serviceStatus.message,
    serviceStatus.kind === "online" && serviceStatus.version
      ? t("app.conn.serviceStatus.version", { version: serviceStatus.version })
      : ""
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            🗂️
          </span>
          <h1>{t("app.brand.title")}</h1>
          {brandMeta ? <div className="meta">{brandMeta}</div> : null}
        </div>

        <div className="conn">
          <input
            className="conn-input"
            value={settings.serverBaseUrl}
            onChange={(e) => setSettings((s) => ({ ...s, serverBaseUrl: e.target.value }))}
            placeholder={t("app.conn.serverBaseUrl.placeholder")}
            title={t("app.conn.serverBaseUrl.title")}
          />
          <input
            className="conn-input"
            value={settings.token}
            onChange={(e) => setSettings((s) => ({ ...s, token: e.target.value }))}
            placeholder={t("app.conn.token.placeholder")}
            title={t("app.conn.token.title")}
          />
          <select
            className="conn-input conn-select"
            value={selectedSavedNodeName}
            onChange={(e) => {
              if (!e.target.value) return;
              applySavedNode(e.target.value);
            }}
            title={t("app.conn.savedNodes.title")}
          >
            <option value="">{t("app.conn.savedNodes.placeholder")}</option>
            {settings.savedNodes.map((node) => (
              <option key={node.name} value={node.name}>
                {node.name}
              </option>
            ))}
          </select>
          <button
            className="btn icon-only"
            title={t("app.conn.savedNodes.saveTitle")}
            aria-label={t("app.conn.savedNodes.saveTitle")}
            onClick={saveCurrentNode}
          >
            <Icon name="save" />
          </button>
          <select
            className="conn-input conn-select"
            defaultValue=""
            onChange={(e) => {
              const name = e.target.value;
              if (!name) return;
              applySavedTerminal(name);
              e.currentTarget.value = "";
            }}
            title={t("app.conn.savedTerminals.title")}
          >
            <option value="">{t("app.conn.savedTerminals.placeholder")}</option>
            {settings.savedTerminals.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </select>
          <button
            className="btn icon-only"
            title={t("app.conn.savedTerminals.saveTitle")}
            aria-label={t("app.conn.savedTerminals.saveTitle")}
            onClick={saveCurrentTerminalPreset}
            disabled={!activeTerminalPreset}
          >
            <Icon name="save" />
          </button>
          <button
            className={showConnHelp ? "btn icon-only active" : "btn icon-only"}
            title={t("app.conn.helpTitle")}
            aria-label={t("app.conn.helpTitle")}
            onClick={() => setShowConnHelp((v) => !v)}
          >
            <Icon name="help" />
          </button>
          <div className={`service-pill ${serviceStatus.kind}`} title={serviceStatusTitle} aria-label={serviceStatusTitle}>
            <span className="service-pill-dot" aria-hidden="true" />
            <span className="service-pill-label">{t("app.conn.serviceStatus.label")}</span>
            <span className="service-pill-value">{serviceStatusText}</span>
            {serviceStatus.kind === "online" && serviceStatus.version ? (
              <span className="service-pill-version">
                {t("app.conn.serviceStatus.version", { version: serviceStatus.version })}
              </span>
            ) : null}
          </div>
          <button
            className="btn agent-setup-trigger"
            title={t("app.agentSetup.openTitle")}
            aria-label={t("app.agentSetup.openTitle")}
            onClick={openAgentSetup}
          >
            <Icon name="backup" />
            <span>{t("app.agentSetup.open")}</span>
          </button>
        </div>

        <div className="tabs" role="tablist" aria-label={t("app.workspaces.label")}>
          <div
            className="tab-label"
            title={t("app.workspaces.hint")}
            aria-hidden="true"
          >
            {t("app.workspaces.label")}
          </div>
          {state.tabs.map((tab) => (
            <div
              key={tab.id}
              className={tab.id === activeTab.id ? "tab ui-item active" : "tab ui-item"}
              role="tab"
              aria-selected={tab.id === activeTab.id}
              tabIndex={0}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setActiveTab(tab.id);
              }}
            >
              <span className="dot" />
              <span>{tab.name}</span>
              {state.tabs.length > 1 ? (
                <button
                  className="tab-close"
                  title={t("app.workspaces.closeTab")}
                  aria-label={t("app.workspaces.closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <Icon name="close" />
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <button
          className="btn icon-only"
          title={t("app.buttons.prefsTitle")}
          aria-label={t("app.buttons.prefsTitle")}
          onClick={openPrefs}
        >
          <Icon name="settings" />
        </button>

        <button
          className="btn icon-only"
          title={t("app.buttons.toggleThemeTitle")}
          aria-label={t("app.buttons.toggleThemeTitle")}
          onClick={toggleTheme}
        >
          <Icon name={settings.theme.mode === "dark" ? "moon" : "sun"} />
        </button>

        <button
          className="btn primary icon-only"
          onClick={onNewTab}
          title={t("app.buttons.newTabTitle")}
          aria-label={t("app.buttons.newTabTitle")}
        >
          <Icon name="plus" />
        </button>
      </div>

      {showConnHelp ? (
        <div className="conn-help" role="note">
          <div className="conn-help-title">{t("app.conn.helpTitle")}</div>
          <ul>
            <li>{t("app.conn.helpText.serverBaseUrl")}</li>
            <li>{t("app.conn.helpText.token")}</li>
            <li>{t("app.conn.helpText.savedNodes")}</li>
            <li>{t("app.conn.helpText.savedTerminals")}</li>
          </ul>
        </div>
      ) : null}

      {webPreview ? (
        <div className="preview-banner" role="note">
          <strong>{t("app.preview.title")}</strong>
          <span>{t("app.preview.desc")}</span>
        </div>
      ) : null}

      <CommandPalette open={showCommand} onClose={() => setShowCommand(false)} commands={commands} />

      {showPrefs ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("app.prefs.title")}>
          <div className="modal-panel prefs-panel">
            <div className="modal-header prefs-header">
              <div className="prefs-title">{t("app.prefs.title")}</div>
              <button
                className="btn icon-only"
                onClick={() => setShowPrefs(false)}
                title={t("common.actions.close")}
                aria-label={t("common.actions.close")}
              >
                <Icon name="close" />
              </button>
            </div>

            <div className="modal-body prefs-body">
              <div className="prefs-row">
                <label className="prefs-label">{t("app.prefs.themeMode")}</label>
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
                  <option value="dark">{t("app.prefs.themeOption.dark")}</option>
                  <option value="light">{t("app.prefs.themeOption.light")}</option>
                  <option value="auto">{t("app.prefs.themeOption.auto")}</option>
                </select>
              </div>

              <div className="prefs-row">
                <label className="prefs-label">{t("app.prefs.radius")}</label>
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
                <label className="prefs-label">{t("app.prefs.fontSize")}</label>
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

              <div className="prefs-row">
                <label className="prefs-label">{t("app.prefs.language")}</label>
                <select
                  className="prefs-input"
                  value={settings.locale}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      locale: e.target.value as LocaleSetting
                    }))
                  }
                >
                  <option value="auto">{t("app.prefs.languageOption.auto")}</option>
                  <option value="en">{t("app.prefs.languageOption.en")}</option>
                  <option value="zh-CN">{t("app.prefs.languageOption.zhCN")}</option>
                </select>
              </div>
            </div>

            <div className="modal-footer prefs-footer">
              <button
                className="btn"
                title={t("app.prefs.exportTitle")}
                onClick={async () => {
                  const json = JSON.stringify(settings, null, 2);
                  try {
                    await navigator.clipboard.writeText(json);
                  } catch {
                    // Fallback: prompt copy.
                    window.prompt(t("app.prefs.exportPrompt"), json);
                  }
                }}
              >
                {t("app.prefs.export")}
              </button>

              <button className="btn" title={t("app.agentSetup.openTitle")} onClick={openAgentSetup}>
                {t("app.agentSetup.open")}
              </button>

              <button className="btn" title={t("app.qrImport.openTitle")} onClick={openQrImport}>
                {t("app.qrImport.open")}
              </button>

              <button
                className="btn"
                title={t("app.prefs.importTitle")}
                onClick={() => {
                  const pasted = window.prompt(t("app.prefs.importPrompt"));
                  if (!pasted) return;
                  applyImportJson(pasted);
                }}
              >
                {t("app.prefs.import")}
              </button>
            </div>
          </div>
          <button className="modal-backdrop" aria-label={t("common.actions.close")} onClick={() => setShowPrefs(false)} />
        </div>
      ) : null}

      <AgentOnboardingModal
        open={showAgentSetup}
        onClose={() => setShowAgentSetup(false)}
        onNotify={notify}
        settings={settings}
        webPreview={webPreview}
      />

      {showQrImport ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("app.qrImport.title")}>
          <div className="modal-panel qr-panel">
            <div className="modal-header qr-header">
              <div className="qr-title">{t("app.qrImport.title")}</div>
              <button
                className="btn icon-only"
                onClick={() => setShowQrImport(false)}
                title={t("app.qrImport.close")}
                aria-label={t("app.qrImport.close")}
              >
                <Icon name="close" />
              </button>
            </div>

            <div className="modal-body qr-body">
              <div className="qr-preview">
                <div className="qr-preview-label">
                  <span>{t("app.qrImport.preview")}</span>
                  {webPreview ? <span className="qr-preview-note">{t("app.qrImport.webHint")}</span> : null}
                </div>
                <div className="qr-preview-box" aria-hidden="true">
                  <div className="qr-frame">
                    <span className="qr-corner tl" />
                    <span className="qr-corner tr" />
                    <span className="qr-corner bl" />
                    <span className="qr-corner br" />
                    <span className="qr-scan-line" />
                  </div>
                  <div className="qr-preview-hint">{t("app.qrImport.previewHint")}</div>
                </div>
              </div>

              <div className="qr-steps">
                <div className="qr-desc">{t("app.qrImport.desc")}</div>
                <div className="qr-steps-title">{t("app.qrImport.stepsTitle")}</div>
                <ol className="qr-step-list">
                  <li>{t("app.qrImport.step1")}</li>
                  <li>{t("app.qrImport.step2")}</li>
                  <li>{t("app.qrImport.step3")}</li>
                </ol>
                <label className="qr-paste-label" htmlFor="qr-import-payload">
                  {t("app.qrImport.pasteLabel")}
                </label>
                <textarea
                  id="qr-import-payload"
                  className="qr-input"
                  placeholder={t("app.qrImport.pastePlaceholder")}
                  value={qrPayload}
                  onChange={(e) => setQrPayload(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-footer qr-footer">
              <button className="btn" onClick={() => setShowQrImport(false)}>
                {t("app.qrImport.close")}
              </button>
              <button
                className="btn primary"
                disabled={!canApplyQr}
                onClick={() => {
                  if (applyImportJson(qrPayload)) {
                    setQrPayload("");
                    setShowQrImport(false);
                  }
                }}
              >
                {t("app.qrImport.apply")}
              </button>
            </div>
          </div>
          <button className="modal-backdrop" aria-label={t("common.actions.close")} onClick={() => setShowQrImport(false)} />
        </div>
      ) : null}

      <div className="workspace" role="main">
        <div className="workspace-shell">
          <WorkspaceView
            tab={activeTab}
            activeLeafId={activeLeafId}
            settings={settings}
            transfers={transfers}
            onNotify={notify}
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
            onOpenTerminal={openTerminalInNewPane}
            onTabChange={(tab) => {
              setState((s) => ({
                ...s,
                tabs: s.tabs.map((x) => (x.id === tab.id ? tab : x))
              }));
            }}
            onActivateLeaf={(leafId) => setActiveLeaf(activeTab.id, leafId)}
          />
          <div className="workspace-tools" role="toolbar" aria-label={t("workspace.tools.aria")}>
            <button
              className="tool-btn icon-only"
              onClick={addView}
              title={t("workspace.tools.addViewTitle")}
              aria-label={t("workspace.tools.addViewTitle")}
            >
              <Icon name="viewAdd" />
            </button>
            <button
              className="tool-btn icon-only"
              onClick={addTerminalView}
              title={t("workspace.tools.addTerminalTitle")}
              aria-label={t("workspace.tools.addTerminalTitle")}
            >
              <Icon name="terminal" />
            </button>
          </div>
        </div>
      </div>

      <NoticeCenter notices={notices} onDismiss={dismissNotice} />

      <div className="statusbar">
        <span className="kbd">{t("app.statusbar.source")}</span> {t("app.statusbar.sourceHint")}
        <span className="kbd">{t("app.statusbar.newTab")}</span> {t("app.statusbar.newTabHint")}
        <span className="kbd">{t("app.statusbar.persist")}</span> {t("app.statusbar.persistHint")}
      </div>
    </div>
  );
}
