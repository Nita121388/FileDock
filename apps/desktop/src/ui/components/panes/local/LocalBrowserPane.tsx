import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openDialog, saveDialog } from "../../../api/dialog";
import { isTauri } from "../../../util/tauriEnv";
import type { PaneTab } from "../../../model/layout";
import {
  copyLocalFile,
  deleteLocalPath,
  listLocalDir,
  moveLocalPath,
  pushFolderSnapshot,
  renameLocalPath,
  type LocalDirEntry
} from "../../../api/tauri";
import { onPaneCommand } from "../../../commandBus";
import { useTranslation } from "react-i18next";
import { homeDir } from "@tauri-apps/api/path";
import type { NoticeLevel } from "../../NoticeCenter";
import type { Settings } from "../../../model/settings";
import { makeLocalTerminalTab } from "../../../model/terminalPresets";
import Icon from "../../Icon";
import { usePaneTableColumns } from "../usePaneTableColumns";
import { formatBytes } from "../../../util/formatBytes";
const BACKUP_DEVICE_KEY = "filedock.desktop.backup.device.v1";

function loadBackupDeviceName(): string {
  try {
    const raw = localStorage.getItem(BACKUP_DEVICE_KEY);
    return raw ? String(raw) : "";
  } catch {
    return "";
  }
}

function saveBackupDeviceName(name: string) {
  try {
    localStorage.setItem(BACKUP_DEVICE_KEY, name);
  } catch {
    // ignore
  }
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${rel}`;
  return `${base}/${rel}`;
}

function hasPathSep(name: string): boolean {
  return name.includes("/") || name.includes("\\");
}

function parentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return trimmed;
  return trimmed.slice(0, idx);
}

type LocalTab = Extract<PaneTab, { pane: "localBrowser" }>;
type LocalContextMenuState = { entry: LocalDirEntry; x: number; y: number } | null;

export default function LocalBrowserPane(props: {
  paneId: string;
  tab: LocalTab;
  settings: Settings;
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
  onOpenTerminal: (tab: import("../../../model/layout").PaneTab) => void;
  onTabChange: (tab: LocalTab) => void;
}) {
  const { t } = useTranslation();
  const { paneId, tab, onTabChange, onNotify, settings } = props;
  const [entries, setEntries] = useState<LocalDirEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<LocalContextMenuState>(null);
  const { draggingIndex, resetWidths, setHeaderCellRef, startResize, tableStyle } = usePaneTableColumns(
    "filedock.desktop.tableColumns.local.v1"
  );

  const basePath = tab.state.basePath;
  const relPath = tab.state.path;
  const fullPath = useMemo(() => (basePath ? joinPath(basePath, relPath) : ""), [basePath, relPath]);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const contextMenuStyle = useMemo(() => {
    if (!contextMenu) return undefined;
    const maxX = typeof window === "undefined" ? contextMenu.x : Math.max(12, window.innerWidth - 220);
    const maxY = typeof window === "undefined" ? contextMenu.y : Math.max(12, window.innerHeight - 120);
    return {
      left: Math.min(contextMenu.x, maxX),
      top: Math.min(contextMenu.y, maxY)
    };
  }, [contextMenu]);

  const refresh = useCallback(async () => {
    if (!basePath) {
      setEntries([]);
      setStatus("");
      setErr(null);
      return;
    }
    setLoading(true);
    try {
      const next = await listLocalDir(fullPath);
      const sorted = [...next].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(sorted);
      setErr(null);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setEntries([]);
      setErr(msg);
      onNotify("error", msg);
    } finally {
      setLoading(false);
    }
  }, [basePath, fullPath, onNotify]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (basePath || !isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const home = await homeDir();
        if (!cancelled && home) {
          onTabChange({ ...tab, state: { ...tab.state, basePath: home, path: "" } });
        }
      } catch {
        // Ignore; user can still choose manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [basePath, onTabChange, tab]);

  const pickFolder = useCallback(async () => {
    if (!isTauri()) {
      const msg = t("local.status.desktopOnly");
      setStatus(msg);
      onNotify("warning", msg);
      return;
    }
    setLoading(true);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("local.dialog.chooseTitle")
      });
      if (!picked || Array.isArray(picked)) return;
      setStatus("");
      onNotify("info", t("local.notice.selected", { path: picked }));
      onTabChange({ ...tab, state: { ...tab.state, basePath: picked, path: "" } });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setStatus(msg);
      setErr(msg);
      onNotify("error", msg);
    } finally {
      setLoading(false);
    }
  }, [onNotify, onTabChange, t, tab]);

  const goUp = useCallback(() => {
    if (!relPath) return;
    const idx = relPath.lastIndexOf("/");
    const next = idx === -1 ? "" : relPath.slice(0, idx);
    onTabChange({ ...tab, state: { ...tab.state, path: next } });
  }, [onTabChange, relPath, tab]);

  const copyPath = useCallback(
    async (targetPath: string) => {
      try {
        await navigator.clipboard.writeText(targetPath);
      } catch {
        window.prompt(t("common.prompt.copyPath"), targetPath);
      }
      setStatus(t("local.status.copyPath", { path: targetPath }));
    },
    [t]
  );

  const openContextMenu = useCallback((entry: LocalDirEntry, x: number, y: number) => {
    setContextMenu({ entry, x, y });
  }, []);

  const openTerminalAtPath = useCallback(
    (targetPath: string) => {
      props.onOpenTerminal(makeLocalTerminalTab(targetPath));
      setStatus(t("local.status.terminalOpened", { path: targetPath }));
    },
    [props, t]
  );

  const openTerminalForEntry = useCallback(
    (entry: LocalDirEntry) => {
      const targetPath = entry.kind === "dir" ? entry.path : parentDir(entry.path);
      if (!targetPath) return;
      openTerminalAtPath(targetPath);
    },
    [openTerminalAtPath]
  );

  const pickBackupDeviceName = useCallback(() => {
    const currentDevice = loadBackupDeviceName() || "desktop";
    const deviceNameRaw = prompt(t("local.prompt.deviceName"), currentDevice);
    if (!deviceNameRaw) return null;
    const deviceName = deviceNameRaw.trim();
    if (!deviceName) return null;
    saveBackupDeviceName(deviceName);
    return deviceName;
  }, [t]);

  const backupPath = useCallback(
    async (targetPath: string, opts?: { deleteAfter?: boolean }) => {
      if (!isTauri()) {
        const msg = t("local.status.desktopOnly");
        setStatus(msg);
        onNotify("warning", msg);
        return;
      }
      const server = settings.serverBaseUrl.trim();
      if (!server) {
        const msg = t("local.status.noServer");
        setErr(msg);
        onNotify("warning", msg);
        return;
      }
      if (!targetPath) {
        const msg = t("local.status.noFolder");
        setErr(msg);
        onNotify("warning", msg);
        return;
      }

      const deviceName = pickBackupDeviceName();
      if (!deviceName) return;

      const noteRaw = prompt(t("local.prompt.note"), targetPath);
      if (noteRaw === null) return;
      const note = noteRaw.trim() || undefined;

      if (opts?.deleteAfter) {
        const ok = confirm(t("local.confirm.deleteBackup", { device: deviceName, path: targetPath }));
        if (!ok) return;
      }

      setErr(null);
      setLoading(true);
      setStatus(t("local.status.backupRunning", { path: targetPath }));
      try {
        const resp = await pushFolderSnapshot({
          server_base_url: server,
          token: settings.token || undefined,
          device_id: settings.deviceId || undefined,
          device_token: settings.deviceToken || undefined,
          device_name: deviceName,
          folder: targetPath,
          note
        });

        if (opts?.deleteAfter) {
          await deleteLocalPath(targetPath);
        }

        const msg = resp.snapshot_id
          ? t("local.status.backupDone", { snapshot: resp.snapshot_id })
          : t("local.status.backupDoneNoId");
        setStatus(msg);
        onNotify("info", msg);
        await refresh();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        setStatus(msg);
        setErr(msg);
        onNotify("error", msg);
      } finally {
        setLoading(false);
      }
    },
    [onNotify, pickBackupDeviceName, refresh, settings, t]
  );

  const backupCurrentFolder = useCallback(async () => {
    if (!basePath) {
      const msg = t("local.status.noFolder");
      setStatus(msg);
      onNotify("warning", msg);
      return;
    }
    const folder = fullPath || basePath;
    await backupPath(folder);
  }, [basePath, backupPath, fullPath, onNotify, t]);

  const openCurrentFolderTerminal = useCallback(() => {
    if (!basePath) {
      const msg = t("local.status.noFolder");
      setStatus(msg);
      onNotify("warning", msg);
      return;
    }
    openTerminalAtPath(fullPath || basePath);
  }, [basePath, fullPath, onNotify, openTerminalAtPath, t]);

  const onEnterDir = useCallback(
    (name: string) => {
      const next = relPath ? `${relPath}/${name}` : name;
      onTabChange({ ...tab, state: { ...tab.state, path: next } });
    },
    [onTabChange, relPath, tab]
  );

  const onDownloadFile = useCallback(
    async (entry: LocalDirEntry) => {
      if (!isTauri()) {
        const msg = t("local.status.desktopOnly");
        setStatus(msg);
        onNotify("warning", msg);
        return;
      }
      const dest = await saveDialog({ defaultPath: entry.name });
      if (!dest) return;
      setErr(null);
      setLoading(true);
      try {
        await copyLocalFile(entry.path, dest);
        onNotify("info", t("local.status.copyDone", { path: dest }));
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        setErr(msg);
        onNotify("error", msg);
      } finally {
        setLoading(false);
      }
    },
    [onNotify, t]
  );

  const onRenameEntry = useCallback(
    async (entry: LocalDirEntry) => {
      const nextNameRaw = prompt(t("local.prompt.rename"), entry.name);
      if (!nextNameRaw) return;
      const nextName = nextNameRaw.trim();
      if (!nextName || nextName === entry.name) return;
      if (hasPathSep(nextName)) {
        const msg = t("local.error.invalidName");
        setErr(msg);
        onNotify("warning", msg);
        return;
      }
      setErr(null);
      setLoading(true);
      try {
        await renameLocalPath(entry.path, nextName);
        await refresh();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        setErr(msg);
        onNotify("error", msg);
      } finally {
        setLoading(false);
      }
    },
    [onNotify, refresh, t]
  );

  const onMoveEntry = useCallback(
    async (entry: LocalDirEntry) => {
      const nextPathRaw = prompt(t("local.prompt.move"), entry.path);
      if (!nextPathRaw) return;
      const nextPath = nextPathRaw.trim();
      if (!nextPath || nextPath === entry.path) return;
      setErr(null);
      setLoading(true);
      try {
        await moveLocalPath(entry.path, nextPath);
        await refresh();
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        setErr(msg);
        onNotify("error", msg);
      } finally {
        setLoading(false);
      }
    },
    [onNotify, refresh, t]
  );

  const onDeleteEntry = useCallback(
    async (entry: LocalDirEntry) => {
      await backupPath(entry.path, { deleteAfter: true });
    },
    [backupPath]
  );

  const onContextBackup = useCallback(
    async (entry: LocalDirEntry) => {
      closeContextMenu();
      await backupPath(entry.path);
    },
    [backupPath, closeContextMenu]
  );

  const onContextCopyPath = useCallback(
    async (entry: LocalDirEntry) => {
      closeContextMenu();
      await copyPath(entry.path);
    },
    [closeContextMenu, copyPath]
  );

  const onContextOpenTerminal = useCallback(
    (entry: LocalDirEntry) => {
      closeContextMenu();
      openTerminalForEntry(entry);
    },
    [closeContextMenu, openTerminalForEntry]
  );

  useEffect(() => {
    if (!contextMenu) return;

    const onPointerDown = (ev: PointerEvent) => {
      if (menuRef.current?.contains(ev.target as Node)) return;
      closeContextMenu();
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeContextMenu();
    };
    const dismiss = () => closeContextMenu();

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [closeContextMenu, contextMenu]);

  useEffect(() => {
    closeContextMenu();
  }, [closeContextMenu, fullPath]);

  useEffect(() => {
    if (loading) closeContextMenu();
  }, [closeContextMenu, loading]);

  useEffect(() => {
    return onPaneCommand((cmd) => {
      if (cmd.paneId !== paneId) return;
      switch (cmd.kind) {
        case "local.choose":
          void pickFolder();
          return;
        case "local.refresh":
          void refresh();
          return;
        case "local.up":
          goUp();
          return;
        default:
          return;
      }
    });
  }, [goUp, paneId, pickFolder, refresh]);

  const emptyMessage = !basePath ? t("local.empty.choose") : t("local.empty.noFiles");

  return (
    <div className="pane local-pane">
      <div className="pane-toolbar">
        <div className="toolbar-row">
          <span className="db-meta">{t("local.title")}</span>
          <span className="db-path" title={fullPath || t("local.pathNone")}>
            {fullPath || t("local.pathNone")}
          </span>
          <button
            className="pane-btn icon-only"
            onClick={pickFolder}
            disabled={loading}
            title={t("local.actions.chooseTitle")}
            aria-label={t("local.actions.chooseTitle")}
          >
            <Icon name="folderOpen" />
          </button>
          <button
            className="pane-btn icon-only"
            onClick={goUp}
            disabled={loading || !relPath}
            title={t("local.actions.upTitle")}
            aria-label={t("local.actions.upTitle")}
          >
            <Icon name="up" />
          </button>
          <button
            className="pane-btn icon-only"
            onClick={refresh}
            disabled={loading || !basePath}
            title={t("local.actions.refreshTitle")}
            aria-label={t("local.actions.refreshTitle")}
          >
            <Icon name="refresh" />
          </button>
          <button
            className="pane-btn icon-only"
            onClick={backupCurrentFolder}
            disabled={loading || !basePath}
            title={t("local.actions.backupTitle")}
            aria-label={t("local.actions.backupTitle")}
          >
            <Icon name="backup" />
          </button>
          <button
            className="pane-btn icon-only"
            onClick={openCurrentFolderTerminal}
            disabled={loading || !basePath}
            title={t("local.actions.terminalTitle")}
            aria-label={t("local.actions.terminalTitle")}
          >
            <Icon name="terminal" />
          </button>
        </div>
      </div>

      {status ? <div className="db-status">{status}</div> : null}
      {err ? <div className="pane-error">{err}</div> : null}

      <div className="pane-table resizable-pane-table" style={tableStyle}>
        <div className="pane-row header">
          <div ref={setHeaderCellRef(0)} className="pane-head-cell">
            <span className="pane-head-label">{t("sftp.table.name")}</span>
            <div
              className={draggingIndex === 0 ? "pane-col-resizer dragging" : "pane-col-resizer"}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("sftp.table.resize")}
              title={t("sftp.table.resize")}
              tabIndex={-1}
              onPointerDown={(ev) => startResize(0, ev)}
              onDoubleClick={resetWidths}
            />
          </div>
          <div ref={setHeaderCellRef(1)} className="pane-head-cell">
            <span className="pane-head-label">{t("sftp.table.type")}</span>
            <div
              className={draggingIndex === 1 ? "pane-col-resizer dragging" : "pane-col-resizer"}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("sftp.table.resize")}
              title={t("sftp.table.resize")}
              tabIndex={-1}
              onPointerDown={(ev) => startResize(1, ev)}
              onDoubleClick={resetWidths}
            />
          </div>
          <div ref={setHeaderCellRef(2)} className="pane-head-cell">
            <span className="pane-head-label">{t("sftp.table.size")}</span>
            <div
              className={draggingIndex === 2 ? "pane-col-resizer dragging" : "pane-col-resizer"}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("sftp.table.resize")}
              title={t("sftp.table.resize")}
              tabIndex={-1}
              onPointerDown={(ev) => startResize(2, ev)}
              onDoubleClick={resetWidths}
            />
          </div>
          <div ref={setHeaderCellRef(3)} className="pane-head-cell">
            <span className="pane-head-label">{t("sftp.table.actions")}</span>
          </div>
        </div>
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={contextMenu?.entry.path === entry.path ? "pane-row context-open" : "pane-row"}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              openContextMenu(entry, ev.clientX, ev.clientY);
            }}
          >
            <div className="sftp-name">
              <span className="db-emoji" aria-hidden="true">
                {entry.kind === "dir" ? "📁" : "📄"}
              </span>
              {entry.kind === "dir" ? (
                <button className="linklike" onClick={() => onEnterDir(entry.name)} disabled={loading} title={entry.name}>
                  {entry.name}
                </button>
              ) : (
                <span title={entry.name}>{entry.name}</span>
              )}
            </div>
            <div>{t(`sftp.kind.${entry.kind}`)}</div>
            <div className="pane-size">{entry.kind === "file" ? formatBytes(entry.size) : ""}</div>
            <div>
              <div className="pane-actions">
                <button
                  className="pane-btn icon-only"
                  onClick={() => backupPath(entry.path)}
                  disabled={loading}
                  title={t("sftp.actions.backup")}
                  aria-label={t("sftp.actions.backup")}
                >
                  <Icon name="backup" />
                </button>
                <button
                  className="pane-btn icon-only"
                  onClick={() => openTerminalForEntry(entry)}
                  disabled={loading}
                  title={t("local.actions.terminalHere")}
                  aria-label={t("local.actions.terminalHere")}
                >
                  <Icon name="terminal" />
                </button>
                {entry.kind === "file" ? (
                  <button
                    className="pane-btn icon-only"
                    onClick={() => onDownloadFile(entry)}
                    disabled={loading}
                    title={t("sftp.actions.download")}
                    aria-label={t("sftp.actions.download")}
                  >
                    <Icon name="download" />
                  </button>
                ) : null}
                <button
                  className="pane-btn icon-only"
                  onClick={() => onRenameEntry(entry)}
                  disabled={loading}
                  title={t("sftp.actions.rename")}
                  aria-label={t("sftp.actions.rename")}
                >
                  <Icon name="rename" />
                </button>
                <button
                  className="pane-btn icon-only"
                  onClick={() => onMoveEntry(entry)}
                  disabled={loading}
                  title={t("sftp.actions.move")}
                  aria-label={t("sftp.actions.move")}
                >
                  <Icon name="move" />
                </button>
                <button
                  className="pane-btn danger icon-only"
                  onClick={() => onDeleteEntry(entry)}
                  disabled={loading}
                  title={t("sftp.actions.deleteBackup")}
                  aria-label={t("sftp.actions.deleteBackup")}
                >
                  <Icon name="delete" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {contextMenu ? (
        <div
          ref={menuRef}
          className="context-menu"
          style={contextMenuStyle}
          role="menu"
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
          }}
        >
          <button className="context-menu-item" role="menuitem" onClick={() => onContextOpenTerminal(contextMenu.entry)} disabled={loading}>
            {t("local.contextMenu.terminal")}
          </button>
          <button className="context-menu-item" role="menuitem" onClick={() => void onContextBackup(contextMenu.entry)} disabled={loading}>
            {t("local.contextMenu.backup")}
          </button>
          <button className="context-menu-item" role="menuitem" onClick={() => void onContextCopyPath(contextMenu.entry)} disabled={loading}>
            {t("local.contextMenu.copyPath")}
          </button>
        </div>
      ) : null}

      {entries.length === 0 ? <div className="db-empty">{emptyMessage}</div> : null}
    </div>
  );
}
