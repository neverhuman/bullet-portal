import { useEffect, useRef, useState } from "react";
import { SURFACES } from "../surfaces";

const DESTINATIONS = [
  { id: "shift-brief", title: "Shift Brief", answers: "Overview of every surface and its current evidence", unknownReason: undefined },
  ...SURFACES,
];

function isEditing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null
  );
}

export function CommandPalette({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = DESTINATIONS.filter((item) =>
    `${item.title} ${item.answers}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const active = matches[Math.min(selected, Math.max(0, matches.length - 1))];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const command = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditing(event.target);
      if (command || slash) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const modal = dialog.current;
    setQuery("");
    setSelected(0);
    modal?.showModal();
    input.current?.focus();
    return () => {
      modal?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && active) {
      dialog.current?.querySelector<HTMLElement>(`#palette-${active.id}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, active?.id]);

  function navigate(id: string) {
    window.location.hash = `#/${id}`;
    onOpenChange(false);
  }

  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-labelledby="palette-title"
      onCancel={(event) => { event.preventDefault(); onOpenChange(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}
    >
      <div className="palette-inner">
        <div className="palette-heading">
          <h2 id="palette-title">Where do you want to go?</h2>
          <button aria-label="Close navigation" onClick={() => onOpenChange(false)}>Esc</button>
        </div>
        <input
          ref={input}
          role="combobox"
          aria-label="Find a surface"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="palette-results"
          aria-activedescendant={active ? `palette-${active.id}` : undefined}
          placeholder="Search missions, sessions, gates…"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (matches.length) setSelected((selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
            } else if (event.key === "Enter" && active) {
              event.preventDefault();
              navigate(active.id);
            }
          }}
        />
        <div id="palette-results" role="listbox" aria-label="Portal surfaces">
          {matches.map((item) => (
            <button
              id={`palette-${item.id}`}
              key={item.id}
              role="option"
              aria-selected={active?.id === item.id}
              tabIndex={-1}
              className="palette-option"
              onClick={() => navigate(item.id)}
            >
              <span><strong>{item.title}</strong><small>{item.answers}</small></span>
              {item.unknownReason ? <span className="palette-unavailable">No projection</span> : <span aria-hidden="true">↗</span>}
            </button>
          ))}
        </div>
        {matches.length === 0 && <p role="status">No matching surfaces. Try “session” or “gate”.</p>}
        <p className="palette-hint"><kbd>↑ ↓</kbd> choose <kbd>Enter</kbd> open <kbd>Esc</kbd> close · navigation only</p>
      </div>
    </dialog>
  );
}
