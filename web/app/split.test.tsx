/**
 * StepsSplit — the Steps detail panel's width (system-map 1d follow-up). The approval card is
 * the densest thing the viewer renders, so the panel has to give: a drag separator, a full-width
 * toggle, and a remembered width. What is worth pinning here is the clamping and the storage
 * failure path — a viewer in a private window must still render a panel, and a width remembered
 * from a wide window must never strand a narrow one with an unreadable step list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StepsSplit, readDetailWidth } from "./run/steps";

const KEY = "howdah.detail.width"; // gained the suffix when the geometry moved to lib/panel.ts
const DEFAULT = 420;
const MIN = 320;
const LIST_MIN = 240;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** happy-dom leaves clientWidth at 0; the clamp reads the live container, so tests set one. */
function render(containerWidth = 1440): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<StepsSplit list={<div className="steps">list</div>} detail={<div className="step-detail">detail</div>} />));
  const split = host.querySelector(".steps-split") as HTMLElement;
  Object.defineProperty(split, "clientWidth", { value: containerWidth, configurable: true });
  split.getBoundingClientRect = () => ({ right: containerWidth, left: 0, width: containerWidth, top: 0, bottom: 0, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  return host;
}

const split = (el: HTMLElement) => el.querySelector(".steps-split") as HTMLElement;
const sep = (el: HTMLElement) => el.querySelector('[role="separator"]') as HTMLElement;
/* the lane holds two controls now (collapse + full width); target the one under test */
const toggle = (el: HTMLElement) => el.querySelector('[data-control="full"]') as HTMLButtonElement;
const widthVar = (el: HTMLElement) => split(el).style.getPropertyValue("--sd-w");

const press = (el: HTMLElement, key: string, shiftKey = false) =>
  act(() => { sep(el).dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })); });

beforeEach(() => {
  try { localStorage.clear(); } catch { /* not every environment has one */ }
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

describe("readDetailWidth", () => {
  test("the default when nothing is stored, and when the stored value is junk", () => {
    expect(readDetailWidth()).toBe(DEFAULT);
    for (const junk of ["", "wide", "NaN", "0", "-800", String(MIN - 1)]) {
      localStorage.setItem(KEY, junk);
      expect(readDetailWidth()).toBe(DEFAULT);
    }
  });

  test("a stored width is honoured", () => {
    localStorage.setItem(KEY, "760");
    expect(readDetailWidth()).toBe(760);
  });

  test("a throwing localStorage still yields a width (private window, blocked site data)", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError: site data blocked"); },
    });
    try {
      expect(readDetailWidth()).toBe(DEFAULT);
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real);
    }
  });
});

describe("StepsSplit", () => {
  test("renders both halves at the stored width, and the separator reports it", () => {
    localStorage.setItem(KEY, "640");
    const el = render();
    expect(widthVar(el)).toBe("640px");
    expect(el.querySelector(".steps")).not.toBeNull();
    expect(sep(el).getAttribute("aria-valuenow")).toBe("640");
    expect(sep(el).getAttribute("aria-orientation")).toBe("vertical");
  });

  test("arrows resize and persist; left grows the panel, right shrinks it", () => {
    const el = render();
    press(el, "ArrowLeft");
    expect(widthVar(el)).toBe(`${DEFAULT + 24}px`);
    expect(localStorage.getItem(KEY)).toBe(String(DEFAULT + 24));
    press(el, "ArrowRight");
    expect(widthVar(el)).toBe(`${DEFAULT}px`);
    press(el, "ArrowLeft", true); // shift takes a bigger bite
    expect(widthVar(el)).toBe(`${DEFAULT + 96}px`);
  });

  test("Home opens it as far as the container allows, End closes it to the minimum", () => {
    const el = render(1440);
    press(el, "Home");
    expect(widthVar(el)).toBe(`${1440 - LIST_MIN}px`); // the list keeps its floor
    press(el, "End");
    expect(widthVar(el)).toBe(`${MIN}px`);
  });

  test("a width remembered from a wide window is clamped by a narrow one", () => {
    localStorage.setItem(KEY, "1200");
    const el = render(900);
    press(el, "ArrowLeft"); // any commit re-clamps against the live container
    expect(Number(sep(el).getAttribute("aria-valuenow"))).toBe(900 - LIST_MIN);
  });

  test("the full-width toggle hides the list and comes back", () => {
    const el = render();
    expect(toggle(el).getAttribute("aria-pressed")).toBe("false");
    act(() => toggle(el).click());
    expect(split(el).dataset.detail).toBe("full");
    expect(el.querySelector(".steps")).toBeNull();
    expect(el.querySelector(".step-detail")).not.toBeNull();
    expect(toggle(el).getAttribute("aria-pressed")).toBe("true");
    expect(sep(el).getAttribute("tabindex")).toBe("-1"); // nothing to resize, so nothing to focus

    act(() => toggle(el).click());
    expect(split(el).dataset.detail).toBe("split");
    expect(el.querySelector(".steps")).not.toBeNull();
    expect(widthVar(el)).toBe(`${DEFAULT}px`); // the split width survived the round trip
  });

  test("the toggle keeps its own label, so its state is never only a colour", () => {
    const el = render();
    expect(toggle(el).getAttribute("aria-label")).toBe("expand the detail panel to full width");
    act(() => toggle(el).click());
    expect(toggle(el).getAttribute("aria-label")).toBe("restore the step list");
  });

  test("double-clicking the separator restores the default width", () => {
    localStorage.setItem(KEY, "800");
    const el = render();
    expect(widthVar(el)).toBe("800px");
    act(() => { sep(el).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(widthVar(el)).toBe(`${DEFAULT}px`);
    expect(localStorage.getItem(KEY)).toBe(String(DEFAULT));
  });

  /**
   * A CSS assertion, deliberately. happy-dom computes no layout, so no component test can see
   * an overlay — and the first cut of full width shipped exactly that: the control was anchored
   * in a zero-width divider and landed on top of the panel's own scope tabs, eating the "S" of
   * "Step". The lane is what makes the overlap impossible, so the lane is what gets pinned.
   */
  test("full width keeps a real lane for the restore control, never a zero-width anchor", async () => {
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    const rule = css.match(/\.steps-split\[data-detail="full"\][^{]*\.pane-resize[^{]*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const basis = rule![1]!.match(/flex-basis:\s*([\d.]+)px/);
    expect(basis).not.toBeNull();
    expect(Number(basis![1])).toBeGreaterThanOrEqual(17); // at least the control's own width
  });

  /**
   * The other half of that guarantee, and the half a component can break without touching a
   * stylesheet. The control is placed against the LANE; wrapping it in a Tooltip put that
   * component's `relative` span in between, and `left: 50%` of a wrapper with no width of its
   * own resolves to the lane's left edge — the same overlay, reintroduced from the TSX side.
   * happy-dom computes no layout (offsetParent is null for everything), so what is asserted is
   * the chain the browser would resolve against: exactly one positioned ancestor under the
   * lane, and it is the one doing the centring.
   */
  test("nothing in the lane is positioned at all, so no control can land on its neighbour", async () => {
    const el = render();
    const lane = sep(el);
    // classes, not elements: a failure here has to print a class list, not a happy-dom node
    const between: string[] = [];
    for (let n = toggle(el).parentElement; n && n !== lane; n = n.parentElement) between.push(n.className);
    expect(between.length).toBeGreaterThan(0); // the Tooltip's spans; this is about what they carry

    // The guarantee got STRONGER than the one this test used to pin. The control was centred
    // on the lane with `absolute left-1/2 -translate-x-1/2`, and the bug being guarded was a
    // zero-width `relative` wrapper sneaking in between, which resolves that 50% to the lane's
    // edge. The controls sit in normal flow inside `.pane-controls` now, so there is no 50% to
    // resolve and no anchor to get wrong: assert the absence of positioning itself.
    const carrying = (name: string) => between.filter((c) => c.split(/\s+/).includes(name));
    expect(carrying("absolute")).toEqual([]);
    expect(carrying("fixed")).toEqual([]);

    // and the stylesheet does not position them either, from the other side
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    for (const rule of [".pane-toggle", ".pane-controls"]) {
      const body = css.match(new RegExp(`\\${rule}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).not.toContain("position:");
    }
  });

  test("a width that cannot be stored still applies to the panel", () => {
    const el = render();
    const real = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")!;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() { throw new Error("QuotaExceededError"); },
    });
    try {
      press(el, "ArrowLeft");
      expect(widthVar(el)).toBe(`${DEFAULT + 24}px`);
    } finally {
      Object.defineProperty(Storage.prototype, "setItem", real);
    }
  });
});
