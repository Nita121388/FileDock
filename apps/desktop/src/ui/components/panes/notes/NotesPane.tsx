import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const KEY = "filedock.desktop.notes.v1";

export default function NotesPane() {
  const { t } = useTranslation();
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(KEY, text);
    } catch {
      // ignore
    }
  }, [text]);

  return (
    <div className="notes">
      <div className="notes-hint">
        {t("notes.hint")}
      </div>
      <textarea
        className="notes-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("notes.placeholder")}
      />
    </div>
  );
}
