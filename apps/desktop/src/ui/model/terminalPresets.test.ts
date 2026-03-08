import { describe, expect, it } from "vitest";

import type { PaneTab } from "./layout";
import {
  makeLocalTerminalTab,
  makeSftpTerminalTab,
  makeTerminalTabFromPreset,
  terminalPresetFromPane
} from "./terminalPresets";
import type { SavedTerminalPreset } from "./settings";

function localBrowserTab(basePath: string, path: string): PaneTab {
  return {
    id: "local-1",
    pane: "localBrowser",
    state: { basePath, path }
  };
}

function sftpBrowserTab(overrides: Partial<Extract<PaneTab, { pane: "sftpBrowser" }>['state']>): PaneTab {
  return {
    id: "sftp-1",
    pane: "sftpBrowser",
    state: {
      host: "server.example",
      port: 22,
      user: "root",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: "/srv",
      path: "/srv/app",
      filedockPath: "",
      pluginDirs: "",
      backupDeviceName: ""
    , ...overrides }
  };
}

function terminalTab(overrides: Partial<Extract<PaneTab, { pane: "terminal" }>['state']>): PaneTab {
  return {
    id: "term-1",
    pane: "terminal",
    state: {
      mode: "local",
      title: "",
      path: "/tmp",
      host: "",
      port: 22,
      user: "",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: ""
    , ...overrides }
  };
}

describe("terminalPresets", () => {
  it("builds local terminal tabs", () => {
    const tab = makeLocalTerminalTab("/srv/app", "Project Shell");
    expect(tab.pane).toBe("terminal");
    expect(tab.title).toBe("Project Shell");
    expect(tab.state).toMatchObject({
      mode: "local",
      path: "/srv/app",
      title: "Project Shell",
      port: 22,
      knownHostsPolicy: "strict"
    });
  });

  it("builds sftp terminal tabs with sane defaults", () => {
    const tab = makeSftpTerminalTab({
      title: "Prod",
      path: "/srv/app",
      host: "server.example",
      port: 0,
      user: "root",
      password: "secret",
      keyPath: "/tmp/key",
      useAgent: true,
      knownHostsPolicy: "accept-new",
      knownHostsPath: "/tmp/known_hosts",
      basePath: "/srv"
    });
    expect(tab.state).toMatchObject({
      mode: "sftp",
      title: "Prod",
      path: "/srv/app",
      host: "server.example",
      port: 22,
      user: "root",
      password: "secret",
      keyPath: "/tmp/key",
      useAgent: true,
      knownHostsPolicy: "accept-new",
      knownHostsPath: "/tmp/known_hosts",
      basePath: "/srv"
    });
  });

  it("creates terminal tabs from saved presets", () => {
    const localPreset: SavedTerminalPreset = {
      name: "Docs",
      mode: "local",
      path: "/home/nita/docs",
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
    const sftpPreset: SavedTerminalPreset = {
      ...localPreset,
      name: "Prod",
      mode: "sftp",
      path: "/srv/app",
      host: "server.example",
      user: "root",
      password: "secret",
      keyPath: "/tmp/key",
      useAgent: true,
      knownHostsPolicy: "accept-new",
      knownHostsPath: "/tmp/known_hosts",
      basePath: "/srv"
    };

    expect(makeTerminalTabFromPreset(localPreset).state).toMatchObject({
      mode: "local",
      path: "/home/nita/docs",
      title: "Docs"
    });
    expect(makeTerminalTabFromPreset(sftpPreset).state).toMatchObject({
      mode: "sftp",
      path: "/srv/app",
      host: "server.example",
      title: "Prod"
    });
  });

  it("extracts presets from local browser panes", () => {
    expect(terminalPresetFromPane(localBrowserTab("/home/nita", "projects/filedock"))).toEqual({
      name: "",
      mode: "local",
      path: "/home/nita/projects/filedock",
      host: "",
      port: 22,
      user: "",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: ""
    });
    expect(terminalPresetFromPane(localBrowserTab("", "projects/filedock"))).toBeNull();
  });

  it("extracts presets from sftp and terminal panes", () => {
    expect(terminalPresetFromPane(sftpBrowserTab({ path: "/srv/releases" }))).toEqual({
      name: "",
      mode: "sftp",
      path: "/srv/releases",
      host: "server.example",
      port: 22,
      user: "root",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: "/srv"
    });
    expect(terminalPresetFromPane(sftpBrowserTab({ host: "", user: "" }))).toBeNull();

    expect(
      terminalPresetFromPane(
        terminalTab({
          mode: "sftp",
          path: "/srv/current",
          host: "server.example",
          user: "deploy",
          basePath: "/srv"
        })
      )
    ).toEqual({
      name: "",
      mode: "sftp",
      path: "/srv/current",
      host: "server.example",
      port: 22,
      user: "deploy",
      password: "",
      keyPath: "",
      useAgent: false,
      knownHostsPolicy: "strict",
      knownHostsPath: "",
      basePath: "/srv"
    });
  });
});
