import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failure: string | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failure: null };

  static getDerivedStateFromError(err: unknown): State {
    return { failure: err instanceof Error ? err.message : String(err) };
  }

  render(): ReactNode {
    if (this.state.failure !== null) {
      return (
        <main>
          <h1>Control Tower</h1>
          <p className="unknown" data-testid="app-failure">
            unknown: portal render failed ({this.state.failure})
          </p>
        </main>
      );
    }
    return this.props.children;
  }
}
