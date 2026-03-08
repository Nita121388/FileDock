import type { PaneTab, SftpBrowserTabState, TerminalTabState } from "./layout";
import { uid } from "./layout";
import type { SavedTerminalPreset } from "./settings";

function defaultTerminalState(): TerminalTabState {
  return {
    mode: "local",
    title: "",
    path: "",
    host: "",
    port: 22,
    user: "",
    password: "",
    keyPath: "",
    useAgent: false,
    knownHostsPolicy: "strict",
    knownHostsPath: "",
    basePath: ""
  };
}

function joinLocalPath(base: string, rel: string): string {
  if (!rel) return base;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${rel}`;
  return `${base}/${rel}`;
}

export function makeLocalTerminalTab(path: string, title = ""): Extract<PaneTab, { pane: "terminal" }> {
  return {
    id: uid("tab"),
    pane: "terminal",
    title,
    state: {
      ...defaultTerminalState(),
      mode: "local",
      title,
      path
    }
  };
}

type SftpTerminalConfig = Pick<
  SftpBrowserTabState,
  | "host"
  | "port"
  | "user"
  | "password"
  | "keyPath"
  | "useAgent"
  | "knownHostsPolicy"
  | "knownHostsPath"
  | "basePath"
> & {
  path: string;
  title?: string;
};

export function makeSftpTerminalTab(config: SftpTerminalConfig): Extract<PaneTab, { pane: "terminal" }> {
  const title = config.title ?? "";
  return {
    id: uid("tab"),
    pane: "terminal",
    title,
    state: {
      ...defaultTerminalState(),
      mode: "sftp",
      title,
      path: config.path,
      host: config.host,
      port: config.port || 22,
      user: config.user,
      password: config.password,
      keyPath: config.keyPath,
      useAgent: config.useAgent,
      knownHostsPolicy: config.knownHostsPolicy,
      knownHostsPath: config.knownHostsPath,
      basePath: config.basePath
    }
  };
}

export function makeTerminalTabFromPreset(preset: SavedTerminalPreset): Extract<PaneTab, { pane: "terminal" }> {
  if (preset.mode === "sftp") {
    return makeSftpTerminalTab({ ...preset, title: preset.name });
  }
  return makeLocalTerminalTab(preset.path, preset.name);
}

export function terminalPresetFromPane(tab: PaneTab): SavedTerminalPreset | null {
  if (tab.pane === "localBrowser") {
    const basePath = tab.state.basePath.trim();
    if (!basePath) return null;
    return {
      name: "",
      mode: "local",
      path: joinLocalPath(basePath, tab.state.path),
      host: "",
      port: 22,
      user: "",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: ""
    };
  }

  if (tab.pane === "sftpBrowser") {
    if (!tab.state.host.trim() || !tab.state.user.trim()) return null;
    return {
      name: "",
      mode: "sftp",
      path: tab.state.path || "/",
      host: tab.state.host,
      port: tab.state.port || 22,
      user: tab.state.user,
      password: tab.state.password,
      keyPath: tab.state.keyPath,
      useAgent: tab.state.useAgent,
      knownHostsPolicy: tab.state.knownHostsPolicy,
      knownHostsPath: tab.state.knownHostsPath,
      basePath: tab.state.basePath
    };
  }

  if (tab.pane === "terminal") {
    return {
      name: "",
      mode: tab.state.mode,
      path: tab.state.path,
      host: tab.state.host,
      port: tab.state.port || 22,
      user: tab.state.user,
      password: tab.state.password,
      keyPath: tab.state.keyPath,
      useAgent: tab.state.useAgent,
      knownHostsPolicy: tab.state.knownHostsPolicy,
      knownHostsPath: tab.state.knownHostsPath,
      basePath: tab.state.basePath
    };
  }

  return null;
}
