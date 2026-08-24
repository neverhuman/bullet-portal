import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { surfaceById } from "../surfaces";
import { SurfacePage } from "./SurfacePage";

describe("SurfacePage", () => {
  it("renders unknown, not an empty success list", () => {
    const surface = surfaceById("merge-rail");
    expect(surface).toBeDefined();
    if (surface === undefined) {
      return;
    }
    render(<SurfacePage surface={surface} />);
    expect(screen.getByTestId("merge-rail-unknown")).toHaveTextContent(
      "unknown: Merge Rail: control plane has not published this projection",
    );
    expect(screen.queryByText("No merges yet.")).toBeNull();
  });
});
