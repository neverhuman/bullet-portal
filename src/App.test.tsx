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
    window.location.hash = "#/quota-capacity";
    render(<App />);
    expect(screen.getByTestId("quota-capacity-unknown")).toHaveTextContent(
      "unknown: Quota and Capacity: no ledger subject exists for this surface yet",
    );
  });
});
