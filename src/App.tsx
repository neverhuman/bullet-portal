import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Nav } from "./components/Nav";
import { ControlTower } from "./pages/ControlTower";
import { isProjected, ProjectedSurface } from "./pages/ProjectedSurface";
import { ShiftBriefPage } from "./pages/ShiftBriefPage";
import { SurfacePage } from "./pages/SurfacePage";
import {
  hashToRoute,
  NOT_FOUND_ROUTE,
  SHIFT_BRIEF_ROUTE,
  surfaceById,
  type RouteId,
} from "./surfaces";

function currentRoute(): RouteId {
  return hashToRoute(window.location.hash);
}

export function App() {
  const [route, setRoute] = useState<RouteId>(currentRoute);

  useEffect(() => {
    const onHash = (): void => {
      setRoute(currentRoute());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <ErrorBoundary>
      <Nav current={route} />
      <Page route={route} />
    </ErrorBoundary>
  );
}

function Page({ route }: { route: RouteId }) {
  if (route === SHIFT_BRIEF_ROUTE) {
    return <ShiftBriefPage />;
  }
  if (route === NOT_FOUND_ROUTE) {
    return (
      <main className="card" data-testid="not-found">
        <h1>Page not found</h1>
        <p>The requested Portal route is not available.</p>
        <a href="#/">Open Shift Brief</a>
      </main>
    );
  }
  if (route === "control-tower") {
    return <ControlTower />;
  }
  const surface = surfaceById(route);
  if (surface === undefined) {
    throw new Error(`${route} surface missing`);
  }
  return isProjected(route) ? <ProjectedSurface surface={surface} /> : <SurfacePage surface={surface} />;
}
