import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { SURFACES } from "./surfaces";

vi.mock("./pages/ControlTower", () => ({
  ControlTower: () => <h1>Control Tower</h1>,
}));

/** Every durable read of the brief has returned: no row is still NONE_LOADING. */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryAllByText("NONE_LOADING")).toHaveLength(0);
  });
}

describe("App hash routes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("keeps control tower on the default hash and on an unknown hash", () => {
    window.location.hash = "";
    const first = render(<App />);
    expect(screen.getByRole("heading", { name: "Control Tower" })).toBeInTheDocument();
    expect(screen.queryByTestId("shift-brief")).toBeNull();
    expect(screen.getByTestId("nav-control-tower")).toHaveClass("nav-current");
    expect(screen.getByTestId("nav-shift-brief")).not.toHaveClass("nav-current");
    first.unmount();
    window.location.hash = "#/no-such-surface";
    render(<App />);
    expect(screen.getByRole("heading", { name: "Control Tower" })).toBeInTheDocument();
    expect(screen.queryByTestId("shift-brief")).toBeNull();
  });

  it("opens the Shift Brief at #/shift-brief from the nav link", async () => {
    window.location.hash = "#/shift-brief";
    render(<App />);
    expect(screen.getByRole("heading", { name: "Shift Brief" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Control Tower" })).toBeNull();
    expect(screen.getByTestId("nav-shift-brief")).toHaveClass("nav-current");
    expect(screen.getByTestId("nav-shift-brief")).toHaveAttribute("href", "#/shift-brief");
    for (const surface of SURFACES) {
      expect(screen.getAllByTestId(`brief-row-${surface.id}`)).toHaveLength(1);
    }
    expect(document.querySelector("select")).toBeNull();
    expect(document.body.textContent).not.toContain("OUT_OF_PROFILE");
    await settled();
  });

  it("opens an unpublished surface as unknown", () => {
    window.location.hash = "#/quota-capacity";
    render(<App />);
    expect(screen.getByTestId("quota-capacity-unknown")).toHaveTextContent(
      "unknown: Quota and Capacity: no ledger subject exists for this surface yet",
    );
    expect(screen.getByTestId("surface-quota-capacity").querySelector(".verified")).toBeNull();
    expect(document.body.textContent).not.toContain("OUT_OF_PROFILE");
  });
});
