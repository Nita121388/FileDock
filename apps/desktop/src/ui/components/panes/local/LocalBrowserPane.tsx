import { useCallback, useEffect, useMemo, useState } from "react";
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

const FORMAT_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
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

function formatBytes(size?: number | null): string {
  if (!size || size <= 0) return "0 B";
  let v = size;
  let i = 0;
  while (v >= 1024 && i < FORMAT_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const fixed = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(fixed)} ${FORMAT_UNITS[i]}`;
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${rel}`;
  return `${base}/${rel}`;
}

function hasPathSep(name: string): boolean {
  return name.includes("/") || name.includes("\\");
}

type LocalTab = Extract<PaneTab, { pane: "localBrowser" }>;

export default function LocalBrowserPane(props: {
  paneId: string;
  tab: LocalTab;
  settings: Settings;
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
  onTabChange: (tab: LocalTab) => void;
}) {
  const { t } = useTranslation();
  const { paneId, tab, onTabChange, onNotify, settings } = props;
  const [entries, setEntries] = useState<LocalDirEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const basePath = tab.state.basePath;
  const relPath = tab.state.path;
  const fullPath = useMemo(() => (basePath ? joinPath(basePath, relPath) : ""), [basePath, relPath]);

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
          <button className="pane-btn" onClick={pickFolder} disabled={loading} title={t("local.actions.chooseTitle")}>
            {t("local.actions.choose")}
          </button>
          <button className="pane-btn" onClick={goUp} disabled={loading || !relPath} title={t("local.actions.upTitle")}>
            {t("local.actions.up")}
          </button>
          <button className="pane-btn" onClick={refresh} disabled={loading || !basePath} title={t("local.actions.refreshTitle")}>
            {t("local.actions.refresh")}
          </button>
          <button className="pane-btn" onClick={backupCurrentFolder} disabled={loading || !basePath} title={t("local.actions.backupTitle")}>
            {t("local.actions.backup")}
          </button>
        </div>
      </div>

      {status ? <div className="db-status">{status}</div> : null}
      {err ? <div className="pane-error">{err}</div> : null}

      <div className="pane-table">
        <div className="pane-row header">
          <div>{t("sftp.table.name")}</div>
          <div>{t("sftp.table.type")}</div>
          <div>{t("sftp.table.size")}</div>
          <div>{t("sftp.table.actions")}</div>
        </div>
        {entries.map((entry) => (
          <div key={entry.path} className="pane-row">
            <div
              className="sftp-name"
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                copyPath(entry.path);
              }}
            >
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
                <button className="pane-btn" onClick={() => backupPath(entry.path)} disabled={loading}>
                  {t("sftp.actions.backup")}
                </button>
                {entry.kind === "file" ? (
                  <button className="pane-btn" onClick={() => onDownloadFile(entry)} disabled={loading}>
                    {t("sftp.actions.download")}
                  </button>
                ) : null}
                <button className="pane-btn" onClick={() => onRenameEntry(entry)} disabled={loading}>
                  {t("sftp.actions.rename")}
                </button>
                <button className="pane-btn" onClick={() => onMoveEntry(entry)} disabled={loading}>
                  {t("sftp.actions.move")}
                </button>
                <button className="pane-btn danger" onClick={() => onDeleteEntry(entry)} disabled={loading}>
                  {t("sftp.actions.deleteBackup")}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {entries.length === 0 ? <div className="db-empty">{emptyMessage}</div> : null}
    </div>
  );
}
