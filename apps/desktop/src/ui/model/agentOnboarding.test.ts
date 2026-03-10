import { describe, expect, it } from "vitest";
import {
  buildAgentAuthPreview,
  sanitizeProfileName,
  suggestDeviceName,
  suggestProfileName
} from "./agentOnboarding";

describe("agentOnboarding", () => {
  it("sanitizes profile names into CLI-safe slugs", () => {
    expect(sanitizeProfileName("  My Photos / 2026  ")).toBe("my-photos-2026");
    expect(sanitizeProfileName("___")).toBe("backup");
    expect(sanitizeProfileName("camera.roll")).toBe("camera.roll");
  });

  it("suggests profile names from the chosen folder", () => {
    expect(suggestProfileName("/home/nita/Documents/Photos")).toBe("photos");
    expect(suggestProfileName("C:\\Users\\Nita\\Desktop\\Project Alpha")).toBe("project-alpha");
    expect(suggestProfileName("/", "agent")).toBe("agent");
  });

  it("suggests device names from the profile", () => {
    expect(suggestDeviceName("laptop-documents")).toBe("laptop-documents");
    expect(suggestDeviceName("   ")).toBe("desktop-backup");
  });

  it("classifies the auth persistence plan for onboarding", () => {
    expect(
      buildAgentAuthPreview(
        { serverBaseUrl: "http://127.0.0.1:8787", token: "bootstrap-token" },
        false
      )
    ).toMatchObject({
      kind: "register_then_device",
      expectsAutoRegister: true,
      persistsBootstrapToken: false,
      hasUsableAuth: true
    });

    expect(
      buildAgentAuthPreview(
        {
          serverBaseUrl: "http://127.0.0.1:8787",
          token: "bootstrap-token",
          deviceId: "dev-1",
          deviceToken: "devtok"
        },
        true
      )
    ).toMatchObject({
      kind: "device_and_bootstrap",
      expectsAutoRegister: false,
      persistsBootstrapToken: true,
      hasUsableAuth: true
    });

    expect(
      buildAgentAuthPreview(
        { serverBaseUrl: "http://127.0.0.1:8787", deviceId: "dev-1" },
        false
      )
    ).toMatchObject({
      kind: "invalid_partial_device",
      hasUsableAuth: false
    });
  });
});
