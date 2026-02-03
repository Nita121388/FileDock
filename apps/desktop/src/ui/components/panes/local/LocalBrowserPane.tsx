import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PaneTab } from "../../../model/layout";
import { listLocalDir, type LocalDirEntry } from "../../../api/tauri";

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
  tab: LocalTab;
  onTabChange: (tab: LocalTab) => void;
}) {
  const { tab, onTabChange } = props;
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
      setStatus(`items: ${sorted.length}`);
    } catch (e: any) {
      setEntries([]);
      setStatus(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [basePath, fullPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pickFolder = useCallback(async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose local folder"
    });
    if (!picked || Array.isArray(picked)) return;
    onTabChange({ ...tab, state: { ...tab.state, basePath: picked, path: "" } });
  }, [onTabChange, tab]);

  const goUp = useCallback(() => {
    if (!relPath) return;
    const idx = relPath.lastIndexOf("/");
    const next = idx === -1 ? "" : relPath.slice(0, idx);
    onTabChange({ ...tab, state: { ...tab.state, path: next } });
  }, [onTabChange, relPath, tab]);

  return (
    <div className="db-col local-browser">
      <div className="db-head">
        Local
        <span className="db-head-right">
          <span className="db-path" title={fullPath || "No folder selected"}>
            {fullPath || "No folder selected"}
          </span>
          <button className="db-mini" onClick={pickFolder} disabled={loading} title="Choose folder">
            Choose
          </button>
          <button className="db-mini" onClick={goUp} disabled={loading || !relPath} title="Up">
            Up
          </button>
          <button className="db-mini" onClick={refresh} disabled={loading || !basePath} title="Refresh">
            Refresh
          </button>
        </span>
      </div>

      {status ? <div className="db-status">{status}</div> : null}

      <div className="db-list">
        {!basePath ? (
          <div className="db-empty">Choose a folder to browse local files.</div>
        ) : entries.length === 0 ? (
          <div className="db-empty">No files in this folder.</div>
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
              <div className="db-title">{entry.name}</div>
              <div className="db-sub">
                {entry.kind === "dir" ? "Folder" : formatBytes(entry.size)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
