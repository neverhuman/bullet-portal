import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./pages/ControlTower", () => ({
  ControlTower: () => <h1>Control Tower</h1>,
}));

describe("App hash routes", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("keeps control tower on the default hash", () => {
    window.location.hash = "";
    render(<App />);
    expect(screen.getByRole("heading", { name: "Control Tower" })).toBeInTheDocument();
  });

  it("opens an unpublished surface as unknown", () => {
    window.location.hash = "#/quality-lab";
    render(<App />);
    expect(screen.getByTestId("quality-lab-unknown")).toHaveTextContent("unknown:");
  });
});
