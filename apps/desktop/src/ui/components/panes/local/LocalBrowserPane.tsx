import { useCallback, useEffect, useMemo, useState } from "react";
import { openDialog } from "../../../api/dialog";
import { isTauri } from "../../../util/tauriEnv";
import type { PaneTab } from "../../../model/layout";
import { listLocalDir, type LocalDirEntry } from "../../../api/tauri";
import { onPaneCommand } from "../../../commandBus";
import { useTranslation } from "react-i18next";
import { homeDir } from "@tauri-apps/api/path";
import type { NoticeLevel } from "../../NoticeCenter";

const FORMAT_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

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

type LocalTab = Extract<PaneTab, { pane: "localBrowser" }>;

export default function LocalBrowserPane(props: {
  paneId: string;
  tab: LocalTab;
  onNotify: (level: NoticeLevel, message: string, title?: string, autoCloseMs?: number) => void;
  onTabChange: (tab: LocalTab) => void;
}) {
  const { t } = useTranslation();
  const { paneId, tab, onTabChange, onNotify } = props;
  const [entries, setEntries] = useState<LocalDirEntry[]>([]);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const basePath = tab.state.basePath;
  const relPath = tab.state.path;
  const fullPath = useMemo(() => (basePath ? joinPath(basePath, relPath) : ""), [basePath, relPath]);

  const refresh = useCallback(async () => {
    if (!basePath) {
      setEntries([]);
      setStatus("");
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
      setStatus("");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setEntries([]);
      setStatus(msg);
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

  return (
    <div className="db-col local-browser">
      <div className="db-head">
        {t("local.title")}
        <span className="db-head-right">
          <span className="db-path" title={fullPath || t("local.pathNone")}>
            {fullPath || t("local.pathNone")}
          </span>
          <button className="db-mini" onClick={pickFolder} disabled={loading} title={t("local.actions.chooseTitle")}>
            {t("local.actions.choose")}
          </button>
          <button className="db-mini" onClick={goUp} disabled={loading || !relPath} title={t("local.actions.upTitle")}>
            {t("local.actions.up")}
          </button>
          <button className="db-mini" onClick={refresh} disabled={loading || !basePath} title={t("local.actions.refreshTitle")}>
            {t("local.actions.refresh")}
          </button>
        </span>
      </div>

      {status ? <div className="db-status">{status}</div> : null}

      <div className="db-list">
        {!basePath ? (
          <div className="db-empty">{t("local.empty.choose")}</div>
        ) : entries.length === 0 ? (
          <div className="db-empty">{t("local.empty.noFiles")}</div>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              className="db-item ui-item"
              onClick={() => {
                if (entry.kind !== "dir") return;
                const next = relPath ? `${relPath}/${entry.name}` : entry.name;
                onTabChange({ ...tab, state: { ...tab.state, path: next } });
              }}
              title={entry.path}
            >
              <div className="db-title">
                <span className="db-emoji" aria-hidden="true">
                  {entry.kind === "dir" ? "📁" : "📄"}
                </span>
                <span className="db-name">{entry.name}</span>
              </div>
              <div className="db-sub">
                {entry.kind === "dir" ? t("local.entry.folder") : formatBytes(entry.size)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
