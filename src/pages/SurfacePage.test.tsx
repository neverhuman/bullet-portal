import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NO_LEDGER_SUBJECT, SURFACES, surfaceById, surfaceStatus } from "../surfaces";
import { PROJECTED_SURFACES } from "./ProjectedSurface";
import { SurfacePage } from "./SurfacePage";

const ABSENT_SUBJECT_SURFACES = [
  "cognitive-router",
  "fusion-lab",
  "quota-capacity",
  "struggle-cockpit",
  "behavior-center",
  "workspace-hygiene",
];

describe("SurfacePage", () => {
  it("renders the exact missing ledger subject, not an empty success list", () => {
    const surface = surfaceById("quota-capacity");
    expect(surface).toBeDefined();
    if (surface === undefined) {
      return;
    }
    render(<SurfacePage surface={surface} />);
    const unknown = screen.getByTestId("quota-capacity-unknown");
    expect(unknown).toHaveTextContent(
      `unknown: Quota and Capacity: ${NO_LEDGER_SUBJECT}: budget/quota reservations and provider capacity observations are not persisted rows; produced by V1-S6`,
    );
    expect(unknown).toHaveClass("unknown");
    expect(screen.getByText(/projection unknown · confidence unknown/)).toBeInTheDocument();
    expect(screen.queryByText("No quota yet.")).toBeNull();
    expect(screen.getByTestId("surface-quota-capacity").querySelector(".verified")).toBeNull();
  });

  it("names a missing subject and a V1 slice for exactly the surfaces farmd does not project", () => {
    const unprojected = SURFACES.filter(
      (surface) => surface.id !== "control-tower" && !PROJECTED_SURFACES.has(surface.id),
    );
    expect(unprojected.map((surface) => surface.id)).toEqual(ABSENT_SUBJECT_SURFACES);
    for (const surface of unprojected) {
      expect(surface.unknownReason, surface.id).toContain(NO_LEDGER_SUBJECT);
      expect(surface.unknownReason, surface.id).toMatch(/V1-S[46]/);
    }
    for (const surface of SURFACES) {
      if (surface.id === "control-tower" || PROJECTED_SURFACES.has(surface.id)) {
        expect(surface.unknownReason, surface.id).toBeUndefined();
      }
    }
  });

  it("can render the six absent-subject surfaces only as unknown: no profile field, no other status", () => {
    for (const id of ABSENT_SUBJECT_SURFACES) {
      const surface = surfaceById(id);
      expect(surface, id).toBeDefined();
      if (surface === undefined) {
        return;
      }
      expect(Object.keys(surface).sort(), id).toEqual(["answers", "id", "spec", "title", "unknownReason"]);
      expect(surfaceStatus(surface), id).toBe("unknown");
      const view = render(<SurfacePage surface={surface} />);
      const unknown = screen.getByTestId(`${id}-unknown`);
      expect(unknown, id).toHaveClass("unknown");
      expect(unknown.textContent, id).toMatch(/^unknown: /);
      expect(unknown.textContent, id).toContain(NO_LEDGER_SUBJECT);
      const card = screen.getByTestId(`surface-${id}`);
      expect(card.querySelector(".verified, .live, .pending"), id).toBeNull();
      expect(card.textContent, id).not.toContain("OUT_OF_PROFILE");
      expect(card.textContent, id).toContain("projection unknown · confidence unknown");
      view.unmount();
    }
    expect(SURFACES.filter((surface) => surfaceStatus(surface) === "durable")).toHaveLength(9);
  });
});
