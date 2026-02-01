import { useEffect, useState } from "react";

const KEY = "filedock.desktop.notes.v1";

export default function NotesPane() {
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
        This pane is a scratchpad. (Later: device/snapshot details, filters, settings.)
      </div>
      <textarea
        className="notes-area"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Write notes here..."
      />
    </div>
  );
}

