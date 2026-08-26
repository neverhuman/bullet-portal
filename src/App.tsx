import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Nav } from "./components/Nav";
import { ControlTower } from "./pages/ControlTower";
import { isProjected, ProjectedSurface } from "./pages/ProjectedSurface";
import { ShiftBriefPage } from "./pages/ShiftBriefPage";
import { SurfacePage } from "./pages/SurfacePage";
import { hashToRoute, SHIFT_BRIEF_ROUTE, surfaceById, type RouteId } from "./surfaces";

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
  if (route === "control-tower") {
    return <ControlTower />;
  }
  const surface = surfaceById(route);
  if (surface === undefined) {
    throw new Error(`${route} surface missing`);
  }
  return isProjected(route) ? <ProjectedSurface surface={surface} /> : <SurfacePage surface={surface} />;
}
