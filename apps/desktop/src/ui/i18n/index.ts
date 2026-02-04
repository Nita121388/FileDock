import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import type { LocaleSetting } from "../model/settings";

export type ResolvedLocale = "en" | "zh-CN";

const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN }
} as const;

export function resolveLocale(locale: LocaleSetting): ResolvedLocale {
  if (locale === "en" || locale === "zh-CN") return locale;

  const candidates: string[] = [];
  if (typeof navigator !== "undefined") {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  }

  for (const lang of candidates) {
    const norm = String(lang).toLowerCase();
    if (norm.startsWith("zh")) return "zh-CN";
    if (norm.startsWith("en")) return "en";
  }

  return "en";
}

function setDocumentLang(lang: ResolvedLocale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
}

export function initI18n(locale: LocaleSetting) {
  if (!i18next.isInitialized) {
    i18next
      .use(initReactI18next)
      .init({
        resources,
        lng: resolveLocale(locale),
        fallbackLng: "en",
        supportedLngs: ["en", "zh-CN"],
        interpolation: { escapeValue: false },
        initImmediate: false
      });
  } else {
    setLanguage(locale);
  }

  setDocumentLang(i18next.language as ResolvedLocale);
  return i18next;
}

export function setLanguage(locale: LocaleSetting): ResolvedLocale {
  const resolved = resolveLocale(locale);
  i18next.changeLanguage(resolved);
  setDocumentLang(resolved);
  return resolved;
}

export { i18next };
