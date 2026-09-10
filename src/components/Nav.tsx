import { useState } from "react";
import { SHIFT_BRIEF_ROUTE, SURFACES, type RouteId } from "../surfaces";
import { CommandPalette } from "./CommandPalette";
import "./OperatorNavigation.css";

const GROUPS = [
  { title: "Operate", ids: ["control-tower", "mission-graph", "fleet", "live-attempt", "session-supervisor"] },
  { title: "Understand", ids: ["context-lineage", "cognitive-router", "fusion-lab", "quota-capacity", "struggle-cockpit"] },
  { title: "Assure", ids: ["behavior-center", "workspace-hygiene", "merge-rail", "quality-lab", "incidents-audit"] },
];

export function Nav({ current }: { current: RouteId }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  return (
    <aside className="operator-nav">
      <a className="brand" href="#/shift-brief" aria-label="Bullet Farm home">
        <span className="brand-mark" aria-hidden="true">B</span>
        <span>BULLET<span className="brand-caption">FARM / OPERATIONS</span></span>
      </a>
      <button className="palette-trigger" onClick={() => setPaletteOpen(true)}>
        Jump to a surface <kbd>Ctrl K</kbd>
      </button>
    <nav className="nav" aria-label="portal surfaces">
      <a
        href={`#/${SHIFT_BRIEF_ROUTE}`}
        className={current === SHIFT_BRIEF_ROUTE ? "nav-current" : undefined}
        aria-current={current === SHIFT_BRIEF_ROUTE ? "page" : undefined}
        data-testid={`nav-${SHIFT_BRIEF_ROUTE}`}
      >
        <span className="nav-index" aria-hidden="true">00</span> Shift Brief
      </a>
      {GROUPS.map((group) => (
        <div className="nav-group" key={group.title}>
          <p className="nav-group-title">{group.title}</p>
          {group.ids.map((id) => {
            const surface = SURFACES.find((item) => item.id === id)!;
            return (
        <a
          key={surface.id}
          href={`#/${surface.id}`}
          className={surface.id === current ? "nav-current" : undefined}
          aria-current={surface.id === current ? "page" : undefined}
          data-testid={`nav-${surface.id}`}
        >
          <span className="nav-index" aria-hidden="true">{surface.spec.split(".")[1].padStart(2, "0")}</span>
          {surface.title}
        </a>
            );
          })}
        </div>
      ))}
    </nav>
      <p className="nav-note">Many minds.<br />One verified line to main.</p>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </aside>
  );
}
