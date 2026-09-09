import { SHIFT_BRIEF_ROUTE, SURFACES, type RouteId } from "../surfaces";

export function Nav({ current }: { current: RouteId }) {
  return (
    <nav className="nav" aria-label="portal surfaces">
      <a
        href={`#/${SHIFT_BRIEF_ROUTE}`}
        className={current === SHIFT_BRIEF_ROUTE ? "nav-current" : undefined}
        data-testid={`nav-${SHIFT_BRIEF_ROUTE}`}
      >
        Shift Brief
      </a>
      {SURFACES.map((surface) => (
        <a
          key={surface.id}
          href={`#/${surface.id}`}
          className={surface.id === current ? "nav-current" : undefined}
          data-testid={`nav-${surface.id}`}
        >
          {surface.title}
        </a>
      ))}
    </nav>
  );
}
