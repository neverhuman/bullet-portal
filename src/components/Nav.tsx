import { SURFACES, type SurfaceId } from "../surfaces";

export function Nav({ current }: { current: SurfaceId }) {
  return (
    <nav className="nav" aria-label="portal surfaces">
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
