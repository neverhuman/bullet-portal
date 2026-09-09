import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Detonator(): never {
  throw new Error("render exploded");
}

describe("ErrorBoundary", () => {
  it("renders the failure reason instead of a white screen", () => {
    const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Detonator />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("app-failure")).toHaveTextContent(
      "unknown: portal render failed (render exploded)",
    );
    silenced.mockRestore();
  });
});
