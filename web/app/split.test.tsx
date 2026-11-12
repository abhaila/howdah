/**
 * StepsSplit — the Steps detail panel's width (system-map 1d follow-up). The approval card is
 * the densest thing the viewer renders, so the panel has to give: a drag separator, a full-width
 * toggle, and a remembered width. What is worth pinning here is the clamping and the storage
 * failure path — a viewer in a private window must still render a panel, and a width remembered
 * from a wide window must never strand a narrow one with an unreadable step list.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StepsSplit, readDetailWidth } from "./run/steps";
import { SplitView, useListKeys, useSplit } from "@/components/ui/panel";
import { Row } from "@/components/ui/row";
import { allShortcuts, installShortcuts, resetShortcutsForTest } from "@/lib/shortcuts";

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

/**
 * HOW-68 — the three things the shared split adds for every list + detail pane (Steps, Logs,
 * Context), each a defect the audit measured: at 1024px the list was squeezed to 8px, Escape
 * did nothing in a detail panel, and a list could only be walked with a pointer.
 */
describe("SplitView: narrow, Escape, and keyboard selection (HOW-68)", () => {
  let uninstall: (() => void) | null = null;
  let widthOf: PropertyDescriptor | undefined;

  /** happy-dom lays nothing out, so the split's own width is supplied where it reads it */
  function withSplitWidth(px: number) {
    widthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("split") ? px : 0; },
    });
  }
  function Harness() {
    const [picked, setPicked] = useState("a");
    return (
      <SplitView
        storageKey="howdah.test-split" label="the detail" listLabel="Things"
        list={<List picked={picked} onPick={setPicked} />}
        detail={<div data-testid="detail">detail of {picked}</div>}
      />
    );
  }
  function List({ picked, onPick }: { picked: string; onPick: (id: string) => void }) {
    const split = useSplit();
    const keys = useListKeys({ ids: ["a", "b", "b", "c"], selected: picked, onSelect: onPick, name: "thing" });
    return (
      <div data-testid="list" ref={keys.ref} onKeyDown={keys.onKeyDown}>
        {["a", "b", "c"].map((id) => (
          <Row key={id} selected={picked === id} onClick={() => { onPick(id); split.open(); }} aria-label={`thing ${id}`}>{id}</Row>
        ))}
      </div>
    );
  }
  function mount(): HTMLElement {
    resetShortcutsForTest();
    uninstall = installShortcuts();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    return host;
  }
  const key = (k: string, target: EventTarget = document.body) =>
    act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  const rowOf = (el: HTMLElement, id: string) => el.querySelector(`[aria-label="thing ${id}"]`) as HTMLButtonElement;
  const picked = (el: HTMLElement) => el.querySelector("[data-selected]")?.getAttribute("aria-label");

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    if (widthOf) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthOf);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    widthOf = undefined;
  });

  test("wide: both sides; Escape closes the detail and a row opens it again", () => {
    withSplitWidth(1300);
    const el = mount();
    expect(el.querySelector('[data-testid="list"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="detail"]')).not.toBeNull();
    expect(el.querySelector('[role="separator"]')).not.toBeNull();

    key("Escape");
    expect(el.querySelector('[data-testid="detail"]')).toBeNull();
    expect(el.querySelector('[data-testid="list"]')).not.toBeNull();
    expect(localStorage.getItem("howdah.test-split.collapsed")).toBe("1"); // the same state the toggle sets

    act(() => rowOf(el, "b").click());
    expect(el.querySelector('[data-testid="detail"]')!.textContent).toBe("detail of b");
  });

  test("narrow: the detail REPLACES the list, with a way back — never a squeezed list", () => {
    withSplitWidth(900);
    const el = mount();
    // the list first, alone, and no separator: there is nothing to resize
    expect(el.querySelector('[data-testid="list"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="detail"]')).toBeNull();
    expect(el.querySelector('[role="separator"]')).toBeNull();

    act(() => rowOf(el, "c").click());
    expect(el.querySelector('[data-testid="list"]')).toBeNull();
    expect(el.querySelector('[data-testid="detail"]')!.textContent).toBe("detail of c");
    const back = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to Things"))!;
    expect(back).toBeDefined();
    expect(document.activeElement).toBe(back); // the row that had focus is gone; focus is not lost

    key("Escape");
    expect(el.querySelector('[data-testid="detail"]')).toBeNull();
    expect(picked(el)).toBe("thing c"); // back on the list, where you were
    expect(document.activeElement).toBe(rowOf(el, "c"));
    // which side shows is where you are, not a preference: nothing was stored
    expect(localStorage.getItem("howdah.test-split.collapsed")).toBeNull();

    act(() => rowOf(el, "a").click());
    act(() => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Back to Things"))!.click());
    expect(el.querySelector('[data-testid="list"]')).not.toBeNull();
  });

  // HOW-68: a step chosen in the Build transcript (or the Details timeline) lands on its DETAIL.
  // Narrow, the split shows one side, and it used to be the list the step was in.
  test("narrow: a selection made outside the list opens the detail, once per request", () => {
    withSplitWidth(900);
    function Outside({ request }: { request: number }) {
      return (
        <SplitView
          storageKey="howdah.test-split" label="the detail" listLabel="Things" openRequest={request}
          list={<div data-testid="list">list</div>} detail={<div data-testid="detail">detail</div>}
        />
      );
    }
    resetShortcutsForTest();
    uninstall = installShortcuts();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Outside request={0} />));
    expect(host.querySelector('[data-testid="detail"]')).toBeNull(); // nothing asked: the list

    act(() => root!.render(<Outside request={1} />));
    expect(host.querySelector('[data-testid="detail"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="list"]')).toBeNull();

    // Back is the operator's: the same request does not re-open what they closed
    key("Escape");
    expect(host.querySelector('[data-testid="list"]')).not.toBeNull();
    act(() => root!.render(<Outside request={1} />));
    expect(host.querySelector('[data-testid="detail"]')).toBeNull();

    // mounted WITH a request (the Steps tab opening because a step was picked in Build)
    act(() => root!.unmount());
    root = createRoot(host);
    act(() => root!.render(<Outside request={2} />));
    expect(host.querySelector('[data-testid="detail"]')).not.toBeNull();
  });

  test("J and K move the selection and take focus with it; a repeated id is not a dead end", () => {
    withSplitWidth(1300);
    const el = mount();
    expect(picked(el)).toBe("thing a");
    key("j");
    expect(picked(el)).toBe("thing b");
    expect(document.activeElement).toBe(rowOf(el, "b")); // so Enter — the row's own — opens it
    key("j"); // the list names "b" twice; the walk is over distinct ids
    expect(picked(el)).toBe("thing c");
    key("j");
    expect(picked(el)).toBe("thing c"); // stops at the end rather than wrapping away
    key("k");
    expect(picked(el)).toBe("thing b");
  });

  test("arrows walk the list from a row, and only from a row", () => {
    withSplitWidth(1300);
    const el = mount();
    key("ArrowDown"); // focus is on the body: the arrows are a scroller's, not the list's
    expect(picked(el)).toBe("thing a");
    rowOf(el, "a").focus();
    key("ArrowDown", rowOf(el, "a"));
    expect(picked(el)).toBe("thing b");
    key("End", rowOf(el, "b"));
    expect(picked(el)).toBe("thing c");
    key("Home", rowOf(el, "c"));
    expect(picked(el)).toBe("thing a");
  });

  test("the list is ONE tab stop — the selected row — however many rows it has", () => {
    withSplitWidth(1300);
    const el = mount();
    const stops = () => ["a", "b", "c"].filter((id) => rowOf(el, id).tabIndex === 0);
    expect(stops()).toEqual(["a"]);
    key("j");
    expect(stops()).toEqual(["b"]); // the stop follows the selection
  });

  test("the list's keys are in the registry, so the ? sheet lists them", () => {
    mount();
    const rows = allShortcuts().filter((s) => s.scope === "Lists");
    expect(rows.map((s) => s.id)).toEqual(["list.next", "list.prev", "list.arrows", "list.open"]);
    expect(rows.find((s) => s.id === "list.next")!.label).toBe("Next thing");
    // arrows and Enter are LISTED but handled by the list and the row themselves — registered
    // globally they would take the arrow keys from every scroller and Enter from every button
    expect(rows.filter((s) => s.passive).map((s) => s.id)).toEqual(["list.arrows", "list.open"]);
  });
});
