import { useEffect, useMemo, useState } from "react";
import type { PaneTab } from "../../../model/layout";
import { uid } from "../../../model/layout";
import { runFiledockPlugin } from "../../../api/tauri";
import { open, save } from "@tauri-apps/plugin-dialog";

type SftpTab = Extract<PaneTab, { pane: "sftpBrowser" }>;

type Entry = {
  name: string;
  kind: "file" | "dir" | "other";
  size?: number;
  mtime_unix?: number;
};

function splitPluginDirs(s: string): string[] | undefined {
  const parts = s
    .split(":")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function joinPosix(a: string, b: string): string {
  const aa = a.endsWith("/") ? a.slice(0, -1) : a;
  const bb = b.startsWith("/") ? b.slice(1) : b;
  if (!aa) return `/${bb}`;
  if (!bb) return aa || "/";
  return `${aa}/${bb}`;
}

export default function SftpBrowserPane(props: {
  tab: SftpTab;
  onTabChange: (tab: SftpTab) => void;
  onEnqueueSftpDownload: (job: {
    runner?: import("../../../model/transfers").PluginRunConfig;
    conn: import("../../../model/transfers").SftpConn;
    remotePath: string;
    localPath: string;
  }) => void;
  onEnqueueSftpUpload: (job: {
    runner?: import("../../../model/transfers").PluginRunConfig;
    conn: import("../../../model/transfers").SftpConn;
    localPath: string;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
}) {
  const st = props.tab.state;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);

  const conn = useMemo(() => {
    return {
      host: st.host,
      port: st.port || 22,
      user: st.user,
      auth: {
        password: st.password,
        key_path: st.keyPath,
        agent: st.useAgent
      },
      known_hosts: {
        policy: st.knownHostsPolicy,
        path: st.knownHostsPath
      },
      base_path: st.basePath
    };
  }, [st]);

  async function call(op: string, args: any): Promise<any> {
    const payload = {
      op,
      conn,
      args
    };

    const resp = await runFiledockPlugin({
      name: "sftp",
      json: JSON.stringify(payload),
      timeout_secs: 60,
      filedock_path: st.filedockPath || undefined,
      plugin_dirs: splitPluginDirs(st.pluginDirs)
    });

    let parsed: any;
    try {
      parsed = JSON.parse(resp.stdout);
    } catch {
      throw new Error(`plugin returned non-JSON: ${resp.stdout.slice(0, 200)}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed?.error?.message || "plugin error");
    }
    return parsed.data;
  }

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const p = st.path && st.path.trim() ? st.path.trim() : "/";
      const data = await call("list", { path: p });
      const list = (data?.entries || []) as Entry[];
      list.sort((a, b) => {
        const ad = a.kind === "dir" ? 0 : 1;
        const bd = b.kind === "dir" ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Refresh when connection or path changes.
    // Keep it conservative (do not spam while editing host/user).
    // User can hit "Refresh" anytime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onEnterDir(name: string) {
    const next = st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    props.onTabChange({
      ...props.tab,
      state: { ...st, path: next }
    });
    await refresh();
  }

  async function onGoUp() {
    const cur = st.path && st.path.trim() ? st.path.trim() : "/";
    if (cur === "/" || cur === "") return;
    const parts = cur.split("/").filter(Boolean);
    parts.pop();
    const next = "/" + parts.join("/");
    props.onTabChange({ ...props.tab, state: { ...st, path: next === "/" ? "/" : next } });
    await refresh();
  }

  async function onDownloadFile(name: string) {
    const remote = st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    const suggested = name;
    const dest = await save({
      defaultPath: suggested
    });
    if (!dest) return;
    props.onEnqueueSftpDownload({
      runner: {
        filedock_path: st.filedockPath || undefined,
        plugin_dirs: st.pluginDirs || undefined,
        timeout_secs: 300
      },
      conn: conn as any,
      remotePath: remote,
      localPath: dest
    });
  }

  async function onUploadFile() {
    const local = await open({
      multiple: false,
      directory: false
    });
    if (!local || Array.isArray(local)) return;

    const base = local.split(/[\\/]/).pop() || `upload_${uid("file")}`;
    const remote = st.path && st.path !== "/" ? joinPosix(st.path, base) : `/${base}`;
    props.onEnqueueSftpUpload({
      runner: {
        filedock_path: st.filedockPath || undefined,
        plugin_dirs: st.pluginDirs || undefined,
        timeout_secs: 300
      },
      conn: conn as any,
      localPath: local,
      remotePath: remote,
      mkdirs: true
    });
  }

  async function onMkdir() {
    const name = prompt("New folder name?");
    if (!name) return;
    const remote = st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    setErr(null);
    setLoading(true);
    try {
      await call("mkdir", { path: remote, parents: false });
      await refresh();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onRenameEntry(ent: Entry) {
    const nextName = prompt("Rename to?", ent.name);
    if (!nextName) return;
    if (nextName.includes("/")) {
      setErr("Invalid name: must not contain '/'");
      return;
    }

    const from = st.path && st.path !== "/" ? joinPosix(st.path, ent.name) : `/${ent.name}`;
    const to = st.path && st.path !== "/" ? joinPosix(st.path, nextName) : `/${nextName}`;
    if (from === to) return;

    setErr(null);
    setLoading(true);
    try {
      await call("mv", { from, to });
      await refresh();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onMoveEntry(ent: Entry) {
    const from = st.path && st.path !== "/" ? joinPosix(st.path, ent.name) : `/${ent.name}`;
    const to = prompt("Move to (absolute POSIX path)?", from);
    if (!to) return;

    setErr(null);
    setLoading(true);
    try {
      await call("mv", { from, to });
      await refresh();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteEntry(ent: Entry) {
    const p = st.path && st.path !== "/" ? joinPosix(st.path, ent.name) : `/${ent.name}`;
    const ok = confirm(`Delete ${ent.kind} ${p}? (recursive delete is disabled)`);
    if (!ok) return;

    setErr(null);
    setLoading(true);
    try {
      await call("rm", { path: p, recursive: false });
      await refresh();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pane sftp-pane">
      <div className="pane-toolbar">
        <div className="toolbar-row">
          <label title="Host (IP or domain)">
            Host{" "}
            <input
              value={st.host}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, host: e.target.value } })}
              placeholder="example.com"
            />
          </label>
          <label title="Port">
            Port{" "}
            <input
              value={String(st.port || 22)}
              onChange={(e) =>
                props.onTabChange({
                  ...props.tab,
                  state: { ...st, port: Number(e.target.value || "22") }
                })
              }
              style={{ width: 80 }}
            />
          </label>
          <label title="Username">
            User{" "}
            <input
              value={st.user}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, user: e.target.value } })}
              placeholder="root"
            />
          </label>
        </div>

        <div className="toolbar-row">
          <label title="Password auth (optional)">
            Password{" "}
            <input
              value={st.password}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, password: e.target.value } })}
              type="password"
              placeholder="(optional)"
            />
          </label>
          <label title="Private key path (optional)">
            Key{" "}
            <input
              value={st.keyPath}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, keyPath: e.target.value } })}
              placeholder="~/.ssh/id_ed25519"
            />
          </label>
          <label title="Use SSH agent">
            Agent{" "}
            <input
              checked={st.useAgent}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, useAgent: e.target.checked } })}
              type="checkbox"
            />
          </label>
        </div>

        <div className="toolbar-row">
          <label title="Host key checking policy">
            known_hosts{" "}
            <select
              value={st.knownHostsPolicy}
              onChange={(e) =>
                props.onTabChange({
                  ...props.tab,
                  state: { ...st, knownHostsPolicy: e.target.value as any }
                })
              }
            >
              <option value="strict">strict</option>
              <option value="accept-new">accept-new</option>
              <option value="insecure">insecure</option>
            </select>
          </label>
          <label title="known_hosts path (optional)">
            known_hosts path{" "}
            <input
              value={st.knownHostsPath}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, knownHostsPath: e.target.value } })}
              placeholder="~/.ssh/known_hosts"
            />
          </label>
        </div>

        <div className="toolbar-row">
          <label title="Base path (optional)">
            Base{" "}
            <input
              value={st.basePath}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, basePath: e.target.value } })}
              placeholder="(optional)"
            />
          </label>
          <label title="Current path">
            Path{" "}
            <input
              value={st.path}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, path: e.target.value } })}
              placeholder="/"
            />
          </label>
          <button className="pane-btn" onClick={() => refresh()} disabled={loading}>
            Refresh
          </button>
          <button className="pane-btn" onClick={() => onGoUp()} disabled={loading}>
            Up
          </button>
          <button className="pane-btn" onClick={() => onMkdir()} disabled={loading}>
            Mkdir
          </button>
          <button className="pane-btn" onClick={() => onUploadFile()} disabled={loading}>
            Upload
          </button>
        </div>

        <div className="toolbar-row">
          <label title="Optional path to filedock binary (for packaged apps)">
            filedock{" "}
            <input
              value={st.filedockPath}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, filedockPath: e.target.value } })}
              placeholder="filedock"
            />
          </label>
          <label title="Optional plugin dirs (colon-separated)">
            plugin dirs{" "}
            <input
              value={st.pluginDirs}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, pluginDirs: e.target.value } })}
              placeholder="./plugins/bin"
            />
          </label>
        </div>
      </div>

      {err ? <div className="pane-error">Error: {err}</div> : null}

      <div className="pane-table">
        <div className="pane-row header">
          <div>Name</div>
          <div>Type</div>
          <div>Size</div>
          <div>Actions</div>
        </div>
        {entries.map((e) => (
          <div key={e.name} className="pane-row">
            <div className="mono">
              {e.kind === "dir" ? (
                <button className="linklike" onClick={() => onEnterDir(e.name)} disabled={loading}>
                  {e.name}/
                </button>
              ) : (
                e.name
              )}
            </div>
            <div>{e.kind}</div>
            <div className="mono">{typeof e.size === "number" ? e.size : ""}</div>
            <div>
              <div className="pane-actions">
                {e.kind === "file" ? (
                  <button className="pane-btn" onClick={() => onDownloadFile(e.name)} disabled={loading}>
                    Download
                  </button>
                ) : null}
                <button className="pane-btn" onClick={() => onRenameEntry(e)} disabled={loading}>
                  Rename
                </button>
                <button className="pane-btn" onClick={() => onMoveEntry(e)} disabled={loading}>
                  Move
                </button>
                <button className="pane-btn danger" onClick={() => onDeleteEntry(e)} disabled={loading}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
