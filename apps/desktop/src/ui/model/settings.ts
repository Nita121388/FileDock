export interface Settings {
  serverBaseUrl: string;
  token: string;
  deviceId: string;
  deviceToken: string;
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
  locale: "auto",
  theme: {
    mode: "dark",
    builtinType: "filedock-flat",
    radiusPx: 6,
    fontSizePx: 14
  }
};

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
