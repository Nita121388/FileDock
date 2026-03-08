import type { SavedNodePreset, SavedTerminalPreset, Settings } from "./settings";

export type ServerConfigImport = {
  serverBaseUrl: string;
  token?: string | null;
  deviceId?: string | null;
  deviceToken?: string | null;
};

export function parseServerConfigImport(input: unknown): ServerConfigImport | null {
  if (!input || typeof input !== "object") return null;
  const serverConfig = input as Record<string, unknown>;
  if (typeof serverConfig.server_base_url !== "string") return null;
  const serverBaseUrl = serverConfig.server_base_url.trim();
  if (!serverBaseUrl) return null;
  const token = typeof serverConfig.token === "string" ? serverConfig.token : null;
  const deviceId = typeof serverConfig.device_id === "string" ? serverConfig.device_id : null;
  const deviceToken = typeof serverConfig.device_token === "string" ? serverConfig.device_token : null;
  return { serverBaseUrl, token, deviceId, deviceToken };
}

export function isSameSavedNodeConfig(
  node: SavedNodePreset,
  conn: Pick<Settings, "serverBaseUrl" | "token" | "deviceId" | "deviceToken">
): boolean {
  return (
    node.serverBaseUrl === conn.serverBaseUrl.trim() &&
    node.token === conn.token &&
    node.deviceId === conn.deviceId &&
    node.deviceToken === conn.deviceToken
  );
}

export function isSameSavedTerminalConfig(preset: SavedTerminalPreset, other: SavedTerminalPreset): boolean {
  return (
    preset.mode === other.mode &&
    preset.path === other.path &&
    preset.host === other.host &&
    preset.port === other.port &&
    preset.user === other.user &&
    preset.password === other.password &&
    preset.keyPath === other.keyPath &&
    preset.useAgent === other.useAgent &&
    preset.knownHostsPolicy === other.knownHostsPolicy &&
    preset.knownHostsPath === other.knownHostsPath &&
    preset.basePath === other.basePath
  );
}

export function suggestTerminalPresetName(
  preset: SavedTerminalPreset,
  labels: { localDefault: string; vps: string }
): string {
  if (preset.mode === "local") {
    const trimmed = preset.path.replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || labels.localDefault;
  }
  const user = preset.user ? `${preset.user}@` : "";
  const host = preset.host || labels.vps;
  const path = preset.path && preset.path !== "/" ? ` ${preset.path}` : "";
  return `${user}${host}${path}`.trim();
}

export function classifyServiceError(message: string): "offline" | "error" {
  return /failed to fetch|networkerror|load failed|econnrefused|err_connection_refused|fetch failed/i.test(message)
    ? "offline"
    : "error";
}
