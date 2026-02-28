import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PaneTab } from "../../../model/layout";
import { uid } from "../../../model/layout";
import { runFiledockPlugin } from "../../../api/tauri";
import { openDialog, saveDialog } from "../../../api/dialog";
import { onPaneCommand } from "../../../commandBus";
import type { Settings } from "../../../model/settings";

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

function cleanRelPath(p: string): string {
  return p
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

function safeSeg(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return "vps";
  return trimmed.replace(/[\\/]/g, "_").replace(/\.\.+/g, "_");
}

export default function SftpBrowserPane(props: {
  paneId: string;
  tab: SftpTab;
  settings: Settings;
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
  onEnqueueSftpToSnapshot: (job: {
    runner?: import("../../../model/transfers").PluginRunConfig;
    conn: import("../../../model/transfers").SftpConn;
    remotePath: string;
    dst: import("../../../model/transfers").Conn;
    dstDeviceName: string;
    dstDeviceId?: string;
    dstBaseSnapshotId?: string;
    dstRootPath?: string;
    dstPath: string;
    conflictPolicy?: "overwrite" | "skip" | "rename";
    note?: string;
    deleteSource?: boolean;
  }) => void;
  onEnqueueSnapshotToSftp: (job: {
    src: import("../../../model/transfers").Conn;
    snapshotId: string;
    snapshotPath: string;
    runner?: import("../../../model/transfers").PluginRunConfig;
    conn: import("../../../model/transfers").SftpConn;
    remotePath: string;
    mkdirs?: boolean;
  }) => void;
}) {
  const { paneId, settings } = props;
  const { t } = useTranslation();
  const st = props.tab.state;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const runner = useMemo(() => {
    return {
      filedock_path: st.filedockPath || undefined,
      plugin_dirs: st.pluginDirs || undefined,
      timeout_secs: 300
    };
  }, [st.filedockPath, st.pluginDirs]);

  const dstConn = useMemo(
    () => ({
      serverBaseUrl: settings.serverBaseUrl,
      token: settings.token,
      deviceId: settings.deviceId,
      deviceToken: settings.deviceToken
    }),
    [settings]
  );

  const backupDeviceDefault = useMemo(() => {
    const host = safeSeg(st.host || "vps");
    const user = st.user ? `${safeSeg(st.user)}@` : "";
    const port = st.port && st.port !== 22 ? `:${st.port}` : "";
    return `sftp:${user}${host}${port}`;
  }, [st.host, st.port, st.user]);

  const backupBasePrefix = useMemo(() => {
    const host = safeSeg(st.host || "vps");
    const user = st.user ? `${safeSeg(st.user)}@` : "";
    const port = st.port && st.port !== 22 ? `-p${st.port}` : "";
    return `sftp/${user}${host}${port}`;
  }, [st.host, st.port, st.user]);

  const deleteBasePrefix = useMemo(() => {
    return `__deleted__/${backupBasePrefix}`;
  }, [backupBasePrefix]);

  const call = useCallback(async (op: string, args: any): Promise<any> => {
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
      throw new Error(t("sftp.error.pluginNonJson", { output: resp.stdout.slice(0, 200) }));
    }
    if (!parsed.ok) {
      throw new Error(parsed?.error?.message || t("sftp.error.plugin"));
    }
    return parsed.data;
  }, [conn, st.filedockPath, st.pluginDirs, t]);

  const refresh = useCallback(async () => {
    setErr(null);
    setStatus("");
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
  }, [call, st.path]);

  const getRemotePath = useCallback(
    (name: string) => {
      return st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    },
    [st.path]
  );

  const copyPath = useCallback(
    async (targetPath: string) => {
      try {
        await navigator.clipboard.writeText(targetPath);
      } catch {
        window.prompt(t("common.prompt.copyPath"), targetPath);
      }
      setStatus(t("sftp.status.copyPath", { path: targetPath }));
    },
    [t]
  );

  const pickBackupDeviceName = useCallback(() => {
    const current = st.backupDeviceName?.trim() || backupDeviceDefault;
    const next = prompt(t("sftp.prompt.backupDeviceName"), current);
    if (!next) return null;
    const trimmed = next.trim();
    if (!trimmed) return null;
    if (trimmed !== st.backupDeviceName) {
      props.onTabChange({ ...props.tab, state: { ...st, backupDeviceName: trimmed } });
    }
    return trimmed;
  }, [backupDeviceDefault, props, st, t]);

  const ensureServer = useCallback(() => {
    const base = settings.serverBaseUrl?.trim() || "";
    if (!base) {
      setErr(t("sftp.error.noServerBase"));
      return false;
    }
    return true;
  }, [settings.serverBaseUrl, t]);

  const queueBackup = useCallback(
    async (ent: Entry, opts: { deleteSource?: boolean }) => {
      if (ent.kind === "other") {
        setErr(t("sftp.error.backupFileOnly"));
        return;
      }
      if (!ensureServer()) return;

      const deviceName = pickBackupDeviceName();
      if (!deviceName) return;

      const remote = getRemotePath(ent.name);
      const rel = cleanRelPath(remote);
      if (!rel) {
        setErr(t("sftp.error.invalidRemotePath"));
        return;
      }

      const prefix = opts.deleteSource ? deleteBasePrefix : backupBasePrefix;
      const dstPath = joinPosix(prefix, rel).replace(/^\//, "");
      const noteDefault = opts.deleteSource ? `DELETE ${remote}` : remote;
      const noteRaw = prompt(t("sftp.prompt.note"), noteDefault);
      if (noteRaw === null) return;
      const note = noteRaw.trim() || undefined;

      if (opts.deleteSource) {
        const ok1 = confirm(t("sftp.confirm.delete", { kind: t(`sftp.kind.${ent.kind}`), path: remote }));
        if (!ok1) return;
        const ok2 = confirm(
          t("sftp.confirm.deleteBackup", { path: remote, device: deviceName, dst: dstPath })
        );
        if (!ok2) return;
      }

      props.onEnqueueSftpToSnapshot({
        runner,
        conn: conn as any,
        remotePath: remote,
        dst: dstConn,
        dstDeviceName: deviceName,
        dstPath,
        dstRootPath: prefix,
        note,
        deleteSource: opts.deleteSource ?? false
      });

      setErr(null);
      setStatus(
        opts.deleteSource
          ? t("sftp.status.queuedDeleteBackup", { src: remote, dst: dstPath })
          : t("sftp.status.queuedBackup", { src: remote, dst: dstPath })
      );
    },
    [
      backupBasePrefix,
      deleteBasePrefix,
      conn,
      dstConn,
      ensureServer,
      getRemotePath,
      pickBackupDeviceName,
      props,
      runner,
      t
    ]
  );

  useEffect(() => {
    // Refresh when connection or path changes.
    // Keep it conservative (do not spam while editing host/user).
    // User can hit "Refresh" anytime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEnterDir = useCallback(async (name: string) => {
    const next = st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    props.onTabChange({
      ...props.tab,
      state: { ...st, path: next }
    });
    await refresh();
  }, [props, refresh, st]);

  const onGoUp = useCallback(async () => {
    const cur = st.path && st.path.trim() ? st.path.trim() : "/";
    if (cur === "/" || cur === "") return;
    const parts = cur.split("/").filter(Boolean);
    parts.pop();
    const next = "/" + parts.join("/");
    props.onTabChange({ ...props.tab, state: { ...st, path: next === "/" ? "/" : next } });
    await refresh();
  }, [props, refresh, st]);

  const onDownloadFile = useCallback(async (name: string) => {
    const remote = st.path && st.path !== "/" ? joinPosix(st.path, name) : `/${name}`;
    const suggested = name;
    const dest = await saveDialog({
      defaultPath: suggested
    });
    if (!dest) return;
    props.onEnqueueSftpDownload({
      runner,
      conn: conn as any,
      remotePath: remote,
      localPath: dest
    });
  }, [conn, props, runner, st.path]);

  const onUploadFile = useCallback(async () => {
    const local = await openDialog({
      multiple: false,
      directory: false
    });
    if (!local || Array.isArray(local)) return;

    const base = local.split(/[\\/]/).pop() || `upload_${uid("file")}`;
    const remote = st.path && st.path !== "/" ? joinPosix(st.path, base) : `/${base}`;
    props.onEnqueueSftpUpload({
      runner,
      conn: conn as any,
      localPath: local,
      remotePath: remote,
      mkdirs: true
    });
  }, [conn, props, runner, st.path]);

  const onMkdir = useCallback(async () => {
    const name = prompt(t("sftp.prompt.newFolder"));
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
  }, [call, refresh, st.path, t]);

  const onRenameEntry = useCallback(async (ent: Entry) => {
    const nextName = prompt(t("sftp.prompt.rename"), ent.name);
    if (!nextName) return;
    if (nextName.includes("/")) {
      setErr(t("sftp.error.invalidName"));
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
  }, [call, refresh, st.path, t]);

  const onMoveEntry = useCallback(async (ent: Entry) => {
    const from = st.path && st.path !== "/" ? joinPosix(st.path, ent.name) : `/${ent.name}`;
    const to = prompt(t("sftp.prompt.move"), from);
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
  }, [call, refresh, st.path, t]);

  const onDeleteEntry = useCallback(async (ent: Entry) => {
    await queueBackup(ent, { deleteSource: true });
  }, [queueBackup]);

  useEffect(() => {
    return onPaneCommand((cmd) => {
      if (cmd.paneId !== paneId) return;
      switch (cmd.kind) {
        case "sftp.refresh":
          void refresh();
          return;
        case "sftp.up":
          void onGoUp();
          return;
        case "sftp.mkdir":
          void onMkdir();
          return;
        case "sftp.upload":
          void onUploadFile();
          return;
        default:
          return;
      }
    });
  }, [onGoUp, onMkdir, onUploadFile, paneId, refresh]);

  return (
    <div
      className="pane sftp-pane"
      onDragOver={(e) => {
        const t = Array.from(e.dataTransfer.types);
        if (t.includes("application/x-filedock-file")) e.preventDefault();
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-filedock-file");
        if (!raw) return;
        e.preventDefault();
        try {
          const parsed = JSON.parse(raw) as any;
          const src = parsed?.src;
          const snapshotId = parsed?.snapshotId;
          const snapshotPath = parsed?.path;
          if (!src || !snapshotId || !snapshotPath) return;
          const base = String(snapshotPath).split("/").filter(Boolean).pop() || "upload";
          const defaultRemote = st.path && st.path !== "/" ? joinPosix(st.path, base) : `/${base}`;
          const remote = prompt(t("sftp.prompt.uploadRemote"), defaultRemote);
          if (!remote) return;
          props.onEnqueueSnapshotToSftp({
            src,
            snapshotId,
            snapshotPath,
            runner,
            conn: conn as any,
            remotePath: remote,
            mkdirs: true
          });
        } catch {
          // ignore
        }
      }}
    >
      <div className="pane-toolbar">
        <div className="toolbar-row">
          <label title={t("sftp.titles.host")}>
            {t("sftp.labels.host")}{" "}
            <input
              value={st.host}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, host: e.target.value } })}
              placeholder={t("sftp.placeholders.host")}
            />
          </label>
          <label title={t("sftp.titles.port")}>
            {t("sftp.labels.port")}{" "}
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
          <label title={t("sftp.titles.user")}>
            {t("sftp.labels.user")}{" "}
            <input
              value={st.user}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, user: e.target.value } })}
              placeholder={t("sftp.placeholders.user")}
            />
          </label>
        </div>

        <div className="toolbar-row">
          <label title={t("sftp.titles.password")}>
            {t("sftp.labels.password")}{" "}
            <input
              value={st.password}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, password: e.target.value } })}
              type="password"
              placeholder={t("sftp.placeholders.optional")}
            />
          </label>
          <label title={t("sftp.titles.key")}>
            {t("sftp.labels.key")}{" "}
            <input
              value={st.keyPath}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, keyPath: e.target.value } })}
              placeholder={t("sftp.placeholders.keyPath")}
            />
          </label>
          <label title={t("sftp.titles.agent")}>
            {t("sftp.labels.agent")}{" "}
            <input
              checked={st.useAgent}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, useAgent: e.target.checked } })}
              type="checkbox"
            />
          </label>
        </div>

        <div className="toolbar-row">
          <label title={t("sftp.titles.currentPath")}>
            {t("sftp.labels.path")}{" "}
            <input
              value={st.path}
              onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, path: e.target.value } })}
              placeholder={t("sftp.placeholders.path")}
            />
          </label>
          <button className="pane-btn" onClick={() => refresh()} disabled={loading}>
            {t("sftp.actions.refresh")}
          </button>
          <button className="pane-btn" onClick={() => onGoUp()} disabled={loading}>
            {t("sftp.actions.up")}
          </button>
          <button className="pane-btn" onClick={() => onMkdir()} disabled={loading}>
            {t("sftp.actions.mkdir")}
          </button>
          <button className="pane-btn" onClick={() => onUploadFile()} disabled={loading}>
            {t("sftp.actions.upload")}
          </button>
          <button
            className="pane-btn"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? t("sftp.actions.advancedHide") : t("sftp.actions.advancedShow")}
          </button>
        </div>

        {showAdvanced ? (
          <div className="sftp-advanced">
            <div className="toolbar-row">
              <label title={t("sftp.titles.knownHostsPolicy")}>
                {t("sftp.labels.knownHosts")}{" "}
                <select
                  value={st.knownHostsPolicy}
                  onChange={(e) =>
                    props.onTabChange({
                      ...props.tab,
                      state: { ...st, knownHostsPolicy: e.target.value as any }
                    })
                  }
                >
                  <option value="strict">{t("sftp.knownHosts.strict")}</option>
                  <option value="accept-new">{t("sftp.knownHosts.acceptNew")}</option>
                  <option value="insecure">{t("sftp.knownHosts.insecure")}</option>
                </select>
              </label>
              <label title={t("sftp.titles.knownHostsPath")}>
                {t("sftp.labels.knownHostsPath")}{" "}
                <input
                  value={st.knownHostsPath}
                  onChange={(e) =>
                    props.onTabChange({ ...props.tab, state: { ...st, knownHostsPath: e.target.value } })
                  }
                  placeholder={t("sftp.placeholders.knownHostsPath")}
                />
              </label>
            </div>

            <div className="toolbar-row">
              <label title={t("sftp.titles.basePath")}>
                {t("sftp.labels.base")}{" "}
                <input
                  value={st.basePath}
                  onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, basePath: e.target.value } })}
                  placeholder={t("sftp.placeholders.basePath")}
                />
              </label>
            </div>

            <div className="toolbar-row">
              <label title={t("sftp.titles.filedock")}>
                {t("sftp.labels.filedock")}{" "}
                <input
                  value={st.filedockPath}
                  onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, filedockPath: e.target.value } })}
                  placeholder={t("sftp.placeholders.filedock")}
                />
              </label>
              <label title={t("sftp.titles.pluginDirs")}>
                {t("sftp.labels.pluginDirs")}{" "}
                <input
                  value={st.pluginDirs}
                  onChange={(e) => props.onTabChange({ ...props.tab, state: { ...st, pluginDirs: e.target.value } })}
                  placeholder={t("sftp.placeholders.pluginDirs")}
                />
              </label>
            </div>
          </div>
        ) : null}
      </div>

      {status ? <div className="db-status">{status}</div> : null}
      {err ? <div className="pane-error">{t("sftp.error.prefix", { message: err })}</div> : null}

      <div className="pane-table">
        <div className="pane-row header">
          <div>{t("sftp.table.name")}</div>
          <div>{t("sftp.table.type")}</div>
          <div>{t("sftp.table.size")}</div>
          <div>{t("sftp.table.actions")}</div>
        </div>
        {entries.map((e) => (
          <div key={e.name} className="pane-row">
            <div
              className="sftp-name"
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                copyPath(getRemotePath(e.name));
              }}
            >
              <span className="db-emoji" aria-hidden="true">
                {e.kind === "dir" ? "📁" : e.kind === "file" ? "📄" : "•"}
              </span>
              {e.kind === "dir" ? (
                <button className="linklike" onClick={() => onEnterDir(e.name)} disabled={loading} title={e.name}>
                  {e.name}/
                </button>
              ) : (
                <span
                  draggable={e.kind === "file"}
                  title={e.kind === "file" ? t("sftp.drag.downloadHint") : e.name}
                  onDragStart={(ev) => {
                    if (e.kind !== "file") return;
                    const remote = st.path && st.path !== "/" ? joinPosix(st.path, e.name) : `/${e.name}`;
                    const payload = {
                      runner,
                      conn,
                      remotePath: remote
                    };
                    ev.dataTransfer.effectAllowed = "copy";
                    ev.dataTransfer.setData("application/x-filedock-sftp-file", JSON.stringify(payload));
                    ev.dataTransfer.setData("text/plain", remote);
                  }}
                >
                  {e.name}
                </span>
              )}
            </div>
            <div>{t(`sftp.kind.${e.kind}`)}</div>
            <div className="mono">{typeof e.size === "number" ? e.size : ""}</div>
            <div>
              <div className="pane-actions">
                {e.kind !== "other" ? (
                  <button className="pane-btn" onClick={() => queueBackup(e, { deleteSource: false })} disabled={loading}>
                    {t("sftp.actions.backup")}
                  </button>
                ) : null}
                {e.kind === "file" ? (
                  <button className="pane-btn" onClick={() => onDownloadFile(e.name)} disabled={loading}>
                    {t("sftp.actions.download")}
                  </button>
                ) : null}
                <button className="pane-btn" onClick={() => onRenameEntry(e)} disabled={loading}>
                  {t("sftp.actions.rename")}
                </button>
                <button className="pane-btn" onClick={() => onMoveEntry(e)} disabled={loading}>
                  {t("sftp.actions.move")}
                </button>
                {e.kind !== "other" ? (
                  <button className="pane-btn danger" onClick={() => onDeleteEntry(e)} disabled={loading}>
                    {t("sftp.actions.deleteBackup")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
