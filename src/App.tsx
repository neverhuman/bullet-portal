import { ErrorBoundary } from "./components/ErrorBoundary";
import { ControlTower } from "./pages/ControlTower";

export function App() {
  return (
    <ErrorBoundary>
      <ControlTower />
    </ErrorBoundary>
  );
}
