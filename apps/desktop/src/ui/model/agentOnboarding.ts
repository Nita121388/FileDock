export type AgentBootstrapConfig = {
  serverBaseUrl: string;
  token?: string | null;
  deviceId?: string | null;
  deviceToken?: string | null;
};

export type AgentAuthPreviewKind =
  | "invalid_partial_device"
  | "device_only"
  | "device_and_bootstrap"
  | "register_then_device"
  | "register_and_keep_bootstrap"
  | "register_without_bootstrap";

export type AgentAuthPreview = {
  kind: AgentAuthPreviewKind;
  hasUsableAuth: boolean;
  expectsAutoRegister: boolean;
  persistsBootstrapToken: boolean;
};

export function sanitizeProfileName(input: string, fallback = "backup"): string {
  const trimmed = input.trim().toLowerCase();
  const collapsed = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-");
  return collapsed || fallback;
}

export function suggestProfileName(folder: string, fallback = "backup"): string {
  const trimmed = folder.trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  const candidate = parts[parts.length - 1] ?? "";
  return sanitizeProfileName(candidate, fallback);
}

export function suggestDeviceName(profile: string, fallback = "desktop-backup"): string {
  const trimmed = profile.trim();
  return trimmed || fallback;
}

export function buildAgentAuthPreview(
  config: AgentBootstrapConfig,
  keepBootstrapToken: boolean
): AgentAuthPreview {
  const token = (config.token ?? "").trim();
  const deviceId = (config.deviceId ?? "").trim();
  const deviceToken = (config.deviceToken ?? "").trim();
  const hasToken = token.length > 0;
  const hasDeviceId = deviceId.length > 0;
  const hasDeviceToken = deviceToken.length > 0;
  const hasDeviceAuth = hasDeviceId && hasDeviceToken;
  const hasPartialDeviceAuth = hasDeviceId !== hasDeviceToken;

  if (hasPartialDeviceAuth) {
    return {
      kind: "invalid_partial_device",
      hasUsableAuth: false,
      expectsAutoRegister: false,
      persistsBootstrapToken: hasToken && keepBootstrapToken
    };
  }

  if (hasDeviceAuth) {
    return {
      kind: hasToken && keepBootstrapToken ? "device_and_bootstrap" : "device_only",
      hasUsableAuth: true,
      expectsAutoRegister: false,
      persistsBootstrapToken: hasToken && keepBootstrapToken
    };
  }

  if (hasToken) {
    return {
      kind: keepBootstrapToken ? "register_and_keep_bootstrap" : "register_then_device",
      hasUsableAuth: true,
      expectsAutoRegister: true,
      persistsBootstrapToken: keepBootstrapToken
    };
  }

  return {
    kind: "register_without_bootstrap",
    hasUsableAuth: true,
    expectsAutoRegister: true,
    persistsBootstrapToken: false
  };
}
