/**
 * The two affordances this pass added everywhere: a pane that opens and closes, and a
 * composer you can submit from the keyboard.
 *
 * What is worth pinning is not that a button toggles. It is the three ways each one can
 * strand the operator:
 *
 *   A closed pane whose toggle went with it. The panel is hidden, so if the control lived
 *   inside it there is no way back. The lane and its toggle have to outlive the pane.
 *   A separator that still takes focus and still drags when there is nothing on the other
 *   side — a control that lies about what it does.
 *   Enter submitting mid-IME-composition, which sends a half-typed message AND eats the word
 *   being composed. Nobody typing in English ever sees it, which is exactly why it ships.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StepsSplit } from "./run/steps";
import { submitOnEnter } from "@/lib/keys";
import { ThemeToggle } from "./main";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(containerWidth = 1440): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<StepsSplit list={<div className="steps">list</div>} detail={<div className="step-detail">detail</div>} />));
  const split = host.querySelector(".steps-split") as HTMLElement;
  Object.defineProperty(split, "clientWidth", { value: containerWidth, configurable: true });
  return host;
}

const sep = (el: HTMLElement) => el.querySelector('[role="separator"]') as HTMLElement;
/** the collapse control, as opposed to the full-width one (`[data-control="full"]`) */
const closer = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("button")).find((b) => /the detail panel/.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement;

beforeEach(() => {
  try { localStorage.clear(); } catch { /* not every environment has one */ }
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

describe("a collapsible pane", () => {
  test("closes, hides only the panel, and keeps the way back", () => {
    const el = render();
    expect(el.querySelector(".step-detail")).not.toBeNull();
    expect(closer(el).getAttribute("aria-expanded")).toBe("true");

    act(() => closer(el).click());

    expect(el.querySelector(".step-detail")).toBeNull(); // the panel is gone
    expect(el.querySelector(".steps")).not.toBeNull(); // the list it made room for is not
    // the lane and its control OUTLIVE the pane, or closing it is a one-way door
    expect(sep(el)).not.toBeNull();
    expect(closer(el)).not.toBeNull();
    expect(closer(el).getAttribute("aria-expanded")).toBe("false");

    act(() => closer(el).click());
    expect(el.querySelector(".step-detail")).not.toBeNull();
  });

  test("a closed pane's separator resizes nothing, so it leaves the tab order", () => {
    const el = render();
    expect(sep(el).getAttribute("tabindex")).toBe("0");
    act(() => closer(el).click());
    expect(sep(el).getAttribute("tabindex")).toBe("-1");
    expect(sep(el).getAttribute("aria-valuenow")).toBe("0");
  });

  test("the closed state persists, because it is an operator preference", () => {
    const el = render();
    act(() => closer(el).click());
    expect(localStorage.getItem("howdah.detail.collapsed")).toBe("1");

    // a fresh mount reads it back
    act(() => root!.unmount());
    host!.remove();
    const again = render();
    expect(again.querySelector(".step-detail")).toBeNull();
  });

  test("the toggle names its state, so it is never only an icon", () => {
    const el = render();
    expect(closer(el).getAttribute("aria-label")).toMatch(/^Hide /);
    act(() => closer(el).click());
    expect(closer(el).getAttribute("aria-label")).toMatch(/^Show /);
  });
});

describe("submitOnEnter", () => {
  /** a KeyboardEvent-shaped stand-in; only the fields the helper reads have to be real */
  const press = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => {
    let prevented = false;
    return {
      event: {
        key: over.key ?? "Enter",
        shiftKey: over.shiftKey ?? false,
        preventDefault: () => { prevented = true; },
        nativeEvent: { isComposing: over.isComposing ?? false },
      },
      prevented: () => prevented,
    };
  };
  const fire = (handler: ReturnType<typeof submitOnEnter>, over?: Parameters<typeof press>[0]) => {
    const p = press(over);
    handler(p.event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
    return p;
  };

  test("Enter submits and stops the newline", () => {
    let sent = 0;
    const p = fire(submitOnEnter(() => { sent++; }));
    expect(sent).toBe(1);
    expect(p.prevented()).toBe(true);
  });

  test("Shift+Enter is a newline, never a submit", () => {
    let sent = 0;
    const p = fire(submitOnEnter(() => { sent++; }), { shiftKey: true });
    expect(sent).toBe(0);
    expect(p.prevented()).toBe(false); // the textarea still gets to insert the line break
  });

  test("any other key is left alone", () => {
    let sent = 0;
    for (const key of ["a", "Tab", "Escape", "ArrowDown"]) fire(submitOnEnter(() => { sent++; }), { key });
    expect(sent).toBe(0);
  });

  /**
   * The one that only bites in Japanese, Chinese or Korean: while an IME is composing, Enter
   * COMMITS the candidate word. Submitting there sends a half-typed message and destroys the
   * word the operator was in the middle of choosing.
   */
  test("Enter mid-IME-composition belongs to the IME, not to us", () => {
    let sent = 0;
    const p = fire(submitOnEnter(() => { sent++; }), { isComposing: true });
    expect(sent).toBe(0);
    expect(p.prevented()).toBe(false);
  });

  test("a disabled composer ignores Enter entirely", () => {
    let sent = 0;
    const p = fire(submitOnEnter(() => { sent++; }, { enabled: false }));
    expect(sent).toBe(0);
    expect(p.prevented()).toBe(false);
  });
});

/**
 * Measured in a real browser: with the inspector rail no longer hiding itself on the Steps
 * tab, the run header lost ~340px and its tail — the Open-in-IDE and run-folder controls —
 * was cut off with `text-overflow: clip`, no ellipsis and no scroll. 192px of controls that
 * simply could not be reached. happy-dom computes no layout, so what is pinned here is the
 * property that makes the clip impossible rather than the pixels.
 */
describe("the run header cannot hide its own controls", () => {
  test("it wraps instead of clipping, and the title yields before the controls do", async () => {
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    const topbar = css.match(/\.topbar\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(topbar).toContain("flex-wrap: wrap");

    const h1 = css.match(/\.topbar h1\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(h1).toContain("min-width: 0"); // or the long goal refuses to give way
    expect(h1).toContain("flex-shrink: 1");
  });
});

/**
 * The theme control is an icon now. An icon-only control is only as good as the name it
 * carries: the glyph says which mode is ON, and the accessible name has to say that AND
 * where the next press lands, or the control is unusable without sight and ambiguous with it.
 */
describe("the theme switcher", () => {
  const mount = (theme: string, onChange: (t: any) => void = () => {}) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ThemeToggle theme={theme} onChange={onChange} />));
    return host.querySelector("button") as HTMLButtonElement;
  };

  test("it is an icon, not prose: no text, but a name that says both states", () => {
    const b = mount("system");
    expect(b.textContent?.trim()).toBe(""); // the old control read "theme: system"
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b.getAttribute("aria-label")).toBe("Theme: system. Switch to dark.");
  });

  test("it cycles dark → light → system and names each next step", () => {
    for (const [now, next] of [["dark", "light"], ["light", "system"], ["system", "dark"]] as const) {
      // collected, not assigned: TS narrows a `let` written only inside a callback to its
      // initialiser, so reading it back afterwards is a type error rather than a test
      const got: string[] = [];
      const b = mount(now, (t) => got.push(t));
      expect(b.getAttribute("aria-label")).toBe(`Theme: ${now}. Switch to ${next}.`);
      act(() => b.click());
      expect(got).toEqual([next]);
      act(() => root!.unmount());
      host!.remove();
    }
  });

  test("an unrecognised stored theme falls back rather than rendering a blank icon", () => {
    const b = mount("solarized-banana");
    expect(b.querySelector("svg")).not.toBeNull();
    expect(b.getAttribute("aria-label")).toBe("Theme: system. Switch to dark.");
  });
});

