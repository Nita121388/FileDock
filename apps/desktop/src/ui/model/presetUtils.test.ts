import { describe, expect, it } from "vitest";

import type { SavedNodePreset, SavedTerminalPreset } from "./settings";
import {
  classifyServiceError,
  isSameSavedNodeConfig,
  isSameSavedTerminalConfig,
  parseServerConfigImport,
  suggestTerminalPresetName
} from "./presetUtils";

describe("presetUtils", () => {
  it("parses imported server config payloads", () => {
    expect(
      parseServerConfigImport({
        server_base_url: "  https://filedock.example  ",
        token: "token",
        device_id: "dev-1",
        device_token: "device-token"
      })
    ).toEqual({
      serverBaseUrl: "https://filedock.example",
      token: "token",
      deviceId: "dev-1",
      deviceToken: "device-token"
    });
    expect(parseServerConfigImport({ server_base_url: "   " })).toBeNull();
    expect(parseServerConfigImport({ token: "missing-url" })).toBeNull();
  });

  it("matches saved node configs against trimmed connection settings", () => {
    const preset: SavedNodePreset = {
      name: "Main",
      serverBaseUrl: "https://filedock.example",
      token: "token",
      deviceId: "dev-1",
      deviceToken: "device-token"
    };
    expect(
      isSameSavedNodeConfig(preset, {
        serverBaseUrl: " https://filedock.example ",
        token: "token",
        deviceId: "dev-1",
        deviceToken: "device-token"
      })
    ).toBe(true);
    expect(
      isSameSavedNodeConfig(preset, {
        serverBaseUrl: "https://other.example",
        token: "token",
        deviceId: "dev-1",
        deviceToken: "device-token"
      })
    ).toBe(false);
  });

  it("compares saved terminal presets field-by-field", () => {
    const base: SavedTerminalPreset = {
      name: "Prod",
      mode: "sftp",
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
    };
    expect(isSameSavedTerminalConfig(base, { ...base })).toBe(true);
    expect(isSameSavedTerminalConfig(base, { ...base, port: 2022 })).toBe(false);
  });

  it("suggests readable preset names", () => {
    expect(
      suggestTerminalPresetName(
        {
          name: "",
          mode: "local",
          path: "/home/nita/projects/filedock/",
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
        { localDefault: "Current Folder", vps: "VPS" }
      )
    ).toBe("filedock");
    expect(
      suggestTerminalPresetName(
        {
          name: "",
          mode: "sftp",
          path: "/srv/app",
          host: "server.example",
          port: 22,
          user: "deploy",
          password: "",
          keyPath: "",
          useAgent: false,
          knownHostsPolicy: "strict",
          knownHostsPath: "",
          basePath: "/srv"
        },
        { localDefault: "Current Folder", vps: "VPS" }
      )
    ).toBe("deploy@server.example /srv/app");
  });

  it("classifies connection failures as offline", () => {
    expect(classifyServiceError("Failed to fetch")).toBe("offline");
    expect(classifyServiceError("connect ECONNREFUSED 127.0.0.1:8787")).toBe("offline");
    expect(classifyServiceError("unexpected 500 response")).toBe("error");
  });
});
