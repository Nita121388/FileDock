export interface SavedNodePreset {
  name: string;
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
}

export interface SavedTerminalPreset {
  name: string;
  mode: "local" | "sftp";
  path: string;
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath: string;
  useAgent: boolean;
  knownHostsPolicy: "strict" | "accept-new" | "insecure";
  knownHostsPath: string;
  basePath: string;
}

export interface Settings {
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
  savedNodes: SavedNodePreset[];
  savedTerminals: SavedTerminalPreset[];
  locale: LocaleSetting;
  theme: {
    mode: "light" | "dark" | "auto";
    builtinType: string;
    radiusPx: number;
    fontSizePx: number;
  };
}

export type LocaleSetting = "auto" | "en" | "zh-CN";

const KEY = "filedock.desktop.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  serverBaseUrl: "http://127.0.0.1:8787",
  token: "",
  deviceId: "",
  deviceToken: "",
  savedNodes: [],
  savedTerminals: [],
  locale: "auto",
  theme: {
    mode: "dark",
    builtinType: "filedock-flat",
    radiusPx: 4,
    fontSizePx: 13
  }
};

function normalizeSavedNodePreset(input: unknown): SavedNodePreset | null {
  if (!input || typeof input !== "object") return null;
  const node = input as Partial<SavedNodePreset>;
  const name = typeof node.name === "string" ? node.name.trim() : "";
  const serverBaseUrl = typeof node.serverBaseUrl === "string" ? node.serverBaseUrl.trim() : "";
  if (!name || !serverBaseUrl) return null;
  return {
    name,
    serverBaseUrl,
    token: typeof node.token === "string" ? node.token : "",
    deviceId: typeof node.deviceId === "string" ? node.deviceId : "",
    deviceToken: typeof node.deviceToken === "string" ? node.deviceToken : ""
  };
}

function normalizeSavedNodes(input: unknown): SavedNodePreset[] {
  if (!Array.isArray(input)) return [];
  const out: SavedNodePreset[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const node = normalizeSavedNodePreset(item);
    if (!node || seen.has(node.name)) continue;
    seen.add(node.name);
    out.push(node);
  }
  return out;
}

function normalizeSavedTerminalPreset(input: unknown): SavedTerminalPreset | null {
  if (!input || typeof input !== "object") return null;
  const preset = input as Partial<SavedTerminalPreset>;
  const name = typeof preset.name === "string" ? preset.name.trim() : "";
  if (!name) return null;
  const mode = preset.mode === "sftp" ? "sftp" : "local";
  const knownHostsPolicy = preset.knownHostsPolicy;
  const policy: "strict" | "accept-new" | "insecure" =
    knownHostsPolicy === "accept-new" || knownHostsPolicy === "insecure" ? knownHostsPolicy : "strict";
  const path = typeof preset.path === "string" ? preset.path : "";
  const host = typeof preset.host === "string" ? preset.host.trim() : "";
  const user = typeof preset.user === "string" ? preset.user.trim() : "";
  if (mode === "sftp" && (!host || !user)) return null;

  return {
    name,
    mode,
    path,
    host,
    port: Number.isFinite(preset.port) ? Number(preset.port) : 22,
    user,
    password: typeof preset.password === "string" ? preset.password : "",
    keyPath: typeof preset.keyPath === "string" ? preset.keyPath : "",
    useAgent: typeof preset.useAgent === "boolean" ? preset.useAgent : false,
    knownHostsPolicy: policy,
    knownHostsPath: typeof preset.knownHostsPath === "string" ? preset.knownHostsPath : "",
    basePath: typeof preset.basePath === "string" ? preset.basePath : ""
  };
}

function normalizeSavedTerminals(input: unknown): SavedTerminalPreset[] {
  if (!Array.isArray(input)) return [];
  const out: SavedTerminalPreset[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const preset = normalizeSavedTerminalPreset(item);
    if (!preset || seen.has(preset.name)) continue;
    seen.add(preset.name);
    out.push(preset);
  }
  return out;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      serverBaseUrl: typeof parsed.serverBaseUrl === "string" && parsed.serverBaseUrl.trim()
        ? parsed.serverBaseUrl.trim()
        : DEFAULT_SETTINGS.serverBaseUrl,
      token: typeof parsed.token === "string" ? parsed.token : "",
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      deviceToken: typeof parsed.deviceToken === "string" ? parsed.deviceToken : "",
      savedNodes: normalizeSavedNodes((parsed as any).savedNodes),
      savedTerminals: normalizeSavedTerminals((parsed as any).savedTerminals),
      locale:
        parsed.locale === "auto" || parsed.locale === "en" || parsed.locale === "zh-CN"
          ? parsed.locale
          : DEFAULT_SETTINGS.locale,
      theme: {
        mode: parsed.theme?.mode === "light" || parsed.theme?.mode === "dark" || parsed.theme?.mode === "auto"
          ? parsed.theme.mode
          : DEFAULT_SETTINGS.theme.mode,
        builtinType: typeof parsed.theme?.builtinType === "string" && parsed.theme.builtinType.trim()
          ? parsed.theme.builtinType.trim()
          : DEFAULT_SETTINGS.theme.builtinType,
        radiusPx: Number.isFinite(parsed.theme?.radiusPx) ? Number(parsed.theme?.radiusPx) : DEFAULT_SETTINGS.theme.radiusPx,
        fontSizePx: Number.isFinite(parsed.theme?.fontSizePx) ? Number(parsed.theme?.fontSizePx) : DEFAULT_SETTINGS.theme.fontSizePx
      }
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}
