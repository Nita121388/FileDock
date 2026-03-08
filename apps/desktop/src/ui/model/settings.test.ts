import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSavedNodePreset,
  normalizeSavedNodes,
  normalizeSavedTerminalPreset,
  normalizeSavedTerminals,
  saveSettings,
  type Settings
} from "./settings";

const SETTINGS_KEY = "filedock.desktop.settings.v1";

describe("settings normalization", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes saved node presets and trims required fields", () => {
    expect(
      normalizeSavedNodePreset({
        name: "  Main  ",
        serverBaseUrl: "  https://filedock.example  ",
        token: 123,
        deviceId: "dev-1",
        deviceToken: null
      })
    ).toEqual({
      name: "Main",
      serverBaseUrl: "https://filedock.example",
      token: "",
      deviceId: "dev-1",
      deviceToken: ""
    });
    expect(normalizeSavedNodePreset({ name: "", serverBaseUrl: "https://filedock.example" })).toBeNull();
    expect(normalizeSavedNodePreset({ name: "Main", serverBaseUrl: "   " })).toBeNull();
  });

  it("deduplicates saved node presets by name", () => {
    expect(
      normalizeSavedNodes([
        { name: "Main", serverBaseUrl: "https://one.example" },
        { name: "Main", serverBaseUrl: "https://two.example" },
        { name: "Backup", serverBaseUrl: "https://backup.example", token: "abc" }
      ])
    ).toEqual([
      {
        name: "Main",
        serverBaseUrl: "https://one.example",
        token: "",
        deviceId: "",
        deviceToken: ""
      },
      {
        name: "Backup",
        serverBaseUrl: "https://backup.example",
        token: "abc",
        deviceId: "",
        deviceToken: ""
      }
    ]);
  });

  it("normalizes saved terminal presets and validates sftp requirements", () => {
    expect(
      normalizeSavedTerminalPreset({
        name: "Remote",
        mode: "sftp",
        path: "/srv/app",
        host: "  server.example  ",
        port: "22",
        user: "  root  ",
        password: 123,
        keyPath: "/tmp/key",
        useAgent: true,
        knownHostsPolicy: "accept-new",
        knownHostsPath: "/tmp/known_hosts",
        basePath: "/srv"
      })
    ).toEqual({
      name: "Remote",
      mode: "sftp",
      path: "/srv/app",
      host: "server.example",
      port: 22,
      user: "root",
      password: "",
      keyPath: "/tmp/key",
      useAgent: true,
      knownHostsPolicy: "accept-new",
      knownHostsPath: "/tmp/known_hosts",
      basePath: "/srv"
    });
    expect(
      normalizeSavedTerminalPreset({
        name: "Broken",
        mode: "sftp",
        path: "/",
        host: "",
        user: "root"
      })
    ).toBeNull();
  });

  it("deduplicates saved terminal presets by name", () => {
    expect(
      normalizeSavedTerminals([
        { name: "Local", mode: "local", path: "/tmp" },
        { name: "Local", mode: "local", path: "/home/nita" },
        { name: "Remote", mode: "sftp", path: "/srv", host: "server", user: "root" }
      ])
    ).toEqual([
      {
        name: "Local",
        mode: "local",
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
      },
      {
        name: "Remote",
        mode: "sftp",
        path: "/srv",
        host: "server",
        port: 22,
        user: "root",
        password: "",
        keyPath: "",
        useAgent: false,
        knownHostsPolicy: "strict",
        knownHostsPath: "",
        basePath: ""
      }
    ]);
  });
});

describe("settings persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to defaults when storage is empty or invalid", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem(SETTINGS_KEY, "not-json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("loads persisted settings with trimming and fallback defaults", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        serverBaseUrl: "  https://filedock.example/  ",
        token: "server-token",
        deviceId: "dev-1",
        deviceToken: "device-token",
        savedNodes: [
          { name: "Main", serverBaseUrl: " https://filedock.example " },
          { name: "Main", serverBaseUrl: "https://duplicate.example" }
        ],
        savedTerminals: [
          { name: "Remote", mode: "sftp", path: "/srv", host: " remote ", user: " root ", port: 2022 },
          { name: "Broken", mode: "sftp", path: "/srv", host: "", user: "root" }
        ],
        locale: "zh-CN",
        theme: {
          mode: "auto",
          builtinType: "  filedock-neo  ",
          radiusPx: 12,
          fontSizePx: 15
        }
      })
    );

    expect(loadSettings()).toEqual({
      serverBaseUrl: "https://filedock.example/",
      token: "server-token",
      deviceId: "dev-1",
      deviceToken: "device-token",
      savedNodes: [
        {
          name: "Main",
          serverBaseUrl: "https://filedock.example",
          token: "",
          deviceId: "",
          deviceToken: ""
        }
      ],
      savedTerminals: [
        {
          name: "Remote",
          mode: "sftp",
          path: "/srv",
          host: "remote",
          port: 2022,
          user: "root",
          password: "",
          keyPath: "",
          useAgent: false,
          knownHostsPolicy: "strict",
          knownHostsPath: "",
          basePath: ""
        }
      ],
      locale: "zh-CN",
      theme: {
        mode: "auto",
        builtinType: "filedock-neo",
        radiusPx: 12,
        fontSizePx: 15
      }
    });
  });

  it("saves settings back to localStorage", () => {
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      serverBaseUrl: "https://filedock.example",
      savedNodes: [
        {
          name: "Main",
          serverBaseUrl: "https://filedock.example",
          token: "server-token",
          deviceId: "dev-1",
          deviceToken: "device-token"
        }
      ]
    };
    saveSettings(next);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null")).toEqual(next);
  });
});
