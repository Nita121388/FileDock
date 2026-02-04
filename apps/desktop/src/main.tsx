import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App";
import { applyTheme } from "./ui/theme/applyTheme";
import { loadSettings } from "./ui/model/settings";
import { initI18n } from "./ui/i18n";
import "./ui/theme/tokens.css";
import "./ui/theme/aliases.css";
import "./ui/styles.css";

// Apply theme as early as possible to avoid a flash of default styles.
const settings = loadSettings();
applyTheme(settings.theme);
initI18n(settings.locale);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
