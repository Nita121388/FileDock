export type ThemeMode = "light" | "dark" | "auto";

export interface ThemeSettings {
  mode: ThemeMode;
  builtinType: string; // maps to documentElement.dataset.theme
  radiusPx: number; // written to --radius
  fontSizePx: number; // written to --font-size-base
}

const resolveMode = (mode: ThemeMode): "light" | "dark" => {
  if (mode === "auto") {
    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "dark";
    }
  }
  return mode;
};

export function applyTheme(theme: ThemeSettings): void {
  const root = document.documentElement;
  if (!root) return;

  const resolved = resolveMode(theme.mode);

  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = theme.builtinType;

  // Keep the token surface simple: write the two sizing tokens directly.
  root.style.setProperty("--radius", `${Math.max(0, theme.radiusPx)}px`);
  root.style.setProperty("--font-size-base", `${Math.max(10, theme.fontSizePx)}px`);
}

