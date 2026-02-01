export interface Settings {
  serverBaseUrl: string;
  token: string;
}

const KEY = "filedock.desktop.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  serverBaseUrl: "http://127.0.0.1:8787",
  token: ""
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
      token: typeof parsed.token === "string" ? parsed.token : ""
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

