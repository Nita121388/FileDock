import "@xterm/xterm/css/xterm.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PaneTab } from "../../../model/layout";
import { isTauri } from "../../../util/tauriEnv";
import {
  closeTerminal,
  listenTerminalExit,
  listenTerminalOutput,
  resizeTerminal,
  startTerminal,
  writeTerminal
} from "../../../api/tauri";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

type TerminalTab = Extract<PaneTab, { pane: "terminal" }>;

type TerminalStatus = "idle" | "connecting" | "ready" | "closed" | "error";

type TerminalConn = {
  host: string;
  port: number;
  user: string;
  auth: {
    password: string;
    key_path: string;
    agent: boolean;
  };
  known_hosts: {
    policy: "strict" | "accept-new" | "insecure";
    path: string;
  };
  base_path: string;
};

function normalizePosixPath(input: string): string {
  let p = input.trim();
  if (!p) p = ".";
  const isAbs = p.startsWith("/");
  const parts = p.split("/");
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return isAbs ? "/" : ".";
  const joined = out.join("/");
  return isAbs ? `/${joined}` : joined;
}

function resolveRemotePath(basePath: string, rawPath: string): string {
  const cleaned = normalizePosixPath(rawPath || ".");
  const base = normalizePosixPath(basePath || "");
  if (base !== "." && base !== "/") {
    return normalizePosixPath(`${base}/${cleaned}`);
  }
  if (base === "/") {
    return cleaned === "." ? "/" : normalizePosixPath(`/${cleaned}`);
  }
  return cleaned === "." ? "/" : normalizePosixPath(cleaned);
}

export default function TerminalPane(props: { tab: TerminalTab; onTabChange: (tab: TerminalTab) => void }) {
  const { t } = useTranslation();
  const { tab } = props;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [error, setError] = useState<string>("");
  const [restartToken, setRestartToken] = useState(0);

  const ready = status === "ready";
  const isDesktop = isTauri();

  const conn = useMemo<TerminalConn | null>(() => {
    if (tab.state.mode !== "sftp") return null;
    return {
      host: tab.state.host,
      port: tab.state.port || 22,
      user: tab.state.user,
      auth: {
        password: tab.state.password,
        key_path: tab.state.keyPath,
        agent: tab.state.useAgent
      },
      known_hosts: {
        policy: tab.state.knownHostsPolicy,
        path: tab.state.knownHostsPath
      },
      base_path: tab.state.basePath
    };
  }, [tab.state]);

  const resolveCwd = useCallback(() => {
    if (tab.state.mode === "sftp") {
      return resolveRemotePath(tab.state.basePath, tab.state.path);
    }
    return tab.state.path || "";
  }, [tab.state]);

  const connect = useCallback(async () => {
    if (!isDesktop) return;
    const term = termRef.current;
    if (!term) return;

    term.reset();
    setError("");
    setStatus("connecting");

    const cols = term.cols || DEFAULT_COLS;
    const rows = term.rows || DEFAULT_ROWS;

    try {
      const resp = await startTerminal({
        kind: tab.state.mode === "sftp" ? "ssh" : "local",
        cols,
        rows,
        cwd: resolveCwd(),
        conn: conn ?? undefined
      });
      sessionIdRef.current = resp.session_id;
      resizeTerminal(resp.session_id, cols, rows).catch(() => undefined);
      setStatus("ready");
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("error");
    }
  }, [conn, isDesktop, resolveCwd, tab.state.mode]);

  useEffect(() => {
    if (!isDesktop) return;
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 12,
      theme: {
        background: "#0b0f14",
        foreground: "#e6edf3",
        cursor: "#e6edf3"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const onData = term.onData((data) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      writeTerminal(sessionId, data).catch(() => {
        // ignore write errors; handled via exit event
      });
    });

    return () => {
      onData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [isDesktop]);

  useEffect(() => {
    if (!isDesktop) return;
    connect();

    return () => {
      const sessionId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sessionId) closeTerminal(sessionId).catch(() => undefined);
      setStatus("closed");
    };
  }, [connect, isDesktop, restartToken, tab.id]);

  useEffect(() => {
    if (!isDesktop) return;
    const sessionId = sessionIdRef.current;
    const term = termRef.current;
    if (!sessionId || !term) return;

    let unlistenOutput: (() => void | Promise<void>) | null = null;
    let unlistenExit: (() => void | Promise<void>) | null = null;

    (async () => {
      unlistenOutput = await listenTerminalOutput((payload) => {
        if (payload.session_id !== sessionId) return;
        term.write(payload.data);
      });
      unlistenExit = await listenTerminalExit((payload) => {
        if (payload.session_id !== sessionId) return;
        setStatus("closed");
      });
    })();

    return () => {
      if (unlistenOutput) void unlistenOutput();
      if (unlistenExit) void unlistenExit();
    };
  }, [isDesktop, status]);

  useEffect(() => {
    if (!isDesktop) return;
    if (!containerRef.current) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    const observer = new ResizeObserver(() => {
      fit.fit();
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;
      resizeTerminal(sessionId, term.cols || DEFAULT_COLS, term.rows || DEFAULT_ROWS).catch(() => undefined);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isDesktop]);

  const statusLabel = useMemo(() => {
    if (!isDesktop) return t("terminal.status.desktopOnly");
    if (status === "connecting") return t("terminal.status.connecting");
    if (status === "closed") return t("terminal.status.closed");
    if (status === "error") return t("terminal.status.error");
    if (status === "ready") return t("terminal.status.ready");
    return "";
  }, [isDesktop, status, t]);

  return (
    <div className="terminal-pane">
      <div className="terminal-toolbar">
        <div className="terminal-title">{tab.state.title || t("terminal.title")}</div>
        <div className={`terminal-status status-${status}`}>{statusLabel}</div>
        <div className="terminal-spacer" />
        <button
          className="pane-btn"
          onClick={() => setRestartToken((v) => v + 1)}
          disabled={!isDesktop}
        >
          {t("terminal.actions.reconnect")}
        </button>
      </div>
      <div
        className={`terminal-body ${ready ? "" : "terminal-body-inactive"}`}
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
      />
      {!isDesktop ? (
        <div className="terminal-overlay">{t("terminal.status.desktopOnly")}</div>
      ) : null}
      {status === "error" && error ? <div className="terminal-overlay">{error}</div> : null}
    </div>
  );
}
