import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Nav } from "./Nav";

describe("operator navigation", () => {
  const prototype = HTMLDialogElement.prototype;
  const original = Object.getOwnPropertyDescriptors(prototype);
  beforeEach(() => {
    // JSDOM lacks the native dialog lifecycle. Real focus containment is browser-tested.
    Object.defineProperties(prototype, {
      showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } },
      close: { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } },
    });
  });
  afterEach(() => {
    for (const name of ["showModal", "close"]) {
      if (original[name]) Object.defineProperty(prototype, name, original[name]);
      else Reflect.deleteProperty(prototype, name);
    }
    window.location.hash = "";
  });

  it("searches by purpose, navigates with Enter, and restores focus", async () => {
    const user = userEvent.setup();
    render(<Nav current="fleet" />);
    const trigger = screen.getByRole("button", { name: /Jump to a surface/ });
    await user.click(trigger);
    const search = screen.getByRole("combobox");
    expect(search).toHaveFocus();
    await user.type(search, "checkpoint");
    expect(screen.getByRole("status")).toHaveTextContent("No matching surfaces");
    await user.clear(search);
    await user.type(search, "GateOutcome");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(window.location.hash).toBe("#/quality-lab");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("supports shortcuts and arrow selection while leaving text entry alone", async () => {
    const user = userEvent.setup();
    render(<><Nav current="fleet" /><input aria-label="Task goal" /></>);
    await user.click(screen.getByRole("textbox", { name: "Task goal" }));
    await user.keyboard("/");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getAllByRole("option")).toHaveLength(16);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(window.location.hash).toBe("#/mission-graph");
    expect(screen.getByRole("textbox", { name: "Task goal" })).toHaveFocus();
  });

  it("labels missing projections, preserves current-route semantics, and cancels without navigation", async () => {
    const user = userEvent.setup();
    render(<Nav current="fleet" />);
    expect(screen.getByTestId("nav-fleet")).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("button", { name: /Jump to a surface/ }));
    await user.type(screen.getByRole("combobox"), "quota and capacity");
    expect(within(screen.getByRole("option")).getByText("No projection")).toBeInTheDocument();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(window.location.hash).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
