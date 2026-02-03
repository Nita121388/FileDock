import { useEffect, useMemo, useRef, useState } from "react";

export type CommandItem = {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
};

export default function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}) {
  const { open, onClose, commands } = props;
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return commands;
    return commands
      .map((c) => {
        const hay = `${c.title} ${c.hint ?? ""} ${c.keywords ?? ""} ${c.id}`.toLowerCase();
        return { c, score: hay.includes(query) ? 10 : 0 };
      })
      .filter((x) => x.score > 0)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[active];
        if (!cmd) return;
        Promise.resolve(cmd.run()).finally(() => onClose());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, active, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Command palette">
      <button className="modal-backdrop" aria-label="Close" onClick={onClose} />

      <div className="cmd-panel">
        <div className="cmd-header">
          <input
            ref={inputRef}
            className="cmd-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type a command…"
            aria-label="Search commands"
          />
          <div className="cmd-kbd">
            <span className="kbd">Enter</span> run <span className="kbd">Esc</span> close
          </div>
        </div>

        <div className="cmd-list" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? <div className="cmd-empty">No matches.</div> : null}
          {filtered.map((c, idx) => (
            <button
              key={c.id}
              className={idx === active ? "cmd-item active" : "cmd-item"}
              role="option"
              aria-selected={idx === active}
              onMouseEnter={() => setActive(idx)}
              onClick={() => Promise.resolve(c.run()).finally(() => onClose())}
              title={c.hint}
            >
              <div className="cmd-main">
                <div className="cmd-title">{c.title}</div>
                {c.hint ? <div className="cmd-hint">{c.hint}</div> : null}
              </div>
              {c.shortcut ? <div className="cmd-shortcut">{c.shortcut}</div> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

