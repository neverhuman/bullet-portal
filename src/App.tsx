import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Nav } from "./components/Nav";
import { ControlTower } from "./pages/ControlTower";
import { isProjected, ProjectedSurface } from "./pages/ProjectedSurface";
import { SurfacePage } from "./pages/SurfacePage";
import { hashToSurface, surfaceById, type SurfaceId } from "./surfaces";

function currentSurface(): SurfaceId {
  return hashToSurface(window.location.hash);
}

export function App() {
  const [surfaceId, setSurfaceId] = useState<SurfaceId>(currentSurface);

  useEffect(() => {
    const onHash = (): void => {
      setSurfaceId(currentSurface());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const surface = surfaceById(surfaceId) ?? surfaceById("control-tower");
  if (surface === undefined) {
    throw new Error("control-tower surface missing");
  }

  return (
    <ErrorBoundary>
      <Nav current={surfaceId} />
      {surfaceId === "control-tower" ? (
        <ControlTower />
      ) : isProjected(surfaceId) ? (
        <ProjectedSurface surface={surface} />
      ) : (
        <SurfacePage surface={surface} />
      )}
    </ErrorBoundary>
  );
}
