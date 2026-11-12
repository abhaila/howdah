/**
 * The primitives, pinned (HOW-16 P0 + P2). happy-dom via bunfig's preload, like the other
 * web/app/*.test.tsx.
 *
 * TWO of these are regressions for defects that SHIPPED, and both shipped for the same
 * reason: a component emitted one class name while the stylesheet defined another, and
 * nothing in the build or the test suite could tell.
 *
 *   1. `PanelTabs` emitted `.tab.on`; howdah.css defined `.tab.active`. The rule never
 *      matched, so the selected tab in every Steps pane switcher rendered unstyled — the
 *      only thing saying which pane was open was the pane itself.
 *   2. `.chip` and `.pill` had NO base rule anywhere. Only modifiers existed, so the Logs
 *      filters, the chat suggestions, the chat citation and the context scope pills rendered
 *      as bare text for as long as they shipped.
 *
 * So what is asserted is not "a class is present" but that the SELECTED/ON state is carried
 * by the component's own emitted classes — the same layer that now defines them — and by
 * `aria-selected` / `aria-pressed` beside it. A rule in a stylesheet can go missing; a cva
 * variant and the aria attribute it sits with cannot come apart without this failing.
 *
 * The keyboard half is the P2 work: every primitive that replaced an `onClick`-on-a-span is
 * checked to be operable without a mouse.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PanelTabs, Tabs } from "./ui/tabs";
import { Chip } from "./ui/chip";
import { Row } from "./ui/row";
import { Checkbox } from "./ui/checkbox";
import { AlertDialog, Dialog } from "./ui/dialog";
import { Tooltip } from "./ui/tooltip";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import { Table, TableBody, TableCell, TableRow } from "./ui/table";

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Mount one primitive on its own — no app shell, no provider, no router. */
function renderPrimitive(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

const $$ = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
const $ = (el: ParentNode, sel: string) => el.querySelector(sel) as HTMLElement | null;

function press(el: HTMLElement, key: string) {
  act(() => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

// ---- P0 defect 1: the selected tab -----------------------------------------------------

describe("PanelTabs — the selected tab carries its own selected styling (P0.1)", () => {
  function tabs(look?: "underline" | "chip") {
    function Harness() {
      const [v, setV] = useState("ask");
      return <PanelTabs look={look} value={v} onValueChange={setV} items={[{ value: "ask", label: "Ask" }, { value: "drift", label: "Drift" }]} />;
    }
    return renderPrimitive(<Harness />);
  }

  test("the selected tab's classes DIFFER from an unselected one, and say aria-selected", () => {
    const el = tabs();
    const [ask, drift] = $$(el, '[role="tab"]');
    expect(ask!.getAttribute("aria-selected")).toBe("true");
    expect(drift!.getAttribute("aria-selected")).toBe("false");
    // the defect was that these were identical: `.tab.on` matched no rule at all
    expect(ask!.className).not.toBe(drift!.className);
  });

  test("selected is never ONLY a colour: the underline look adds a rule and weight", () => {
    const el = tabs("underline");
    const [ask, drift] = $$(el, '[role="tab"]');
    // HOW-68: the rule is INDIGO (`--primary`: "what you press and where you are") and the
    // weight is 500 ("names and selected things"); it was the ink colour at 600. The
    // contract this test exists for is unchanged: a rule AND a weight, never a colour alone.
    expect(ask!.className).toContain("border-b-[var(--primary)]");
    expect(ask!.className).toContain("font-medium");
    expect(drift!.className).not.toContain("font-medium");
    expect(drift!.className).toContain("border-b-transparent");
  });

  test("the chip look (the Step/Run scope switcher) fills when selected", () => {
    const el = tabs("chip");
    const [ask, drift] = $$(el, '[role="tab"]');
    expect(ask!.className).toContain("bg-card");
    expect(drift!.className).not.toContain("bg-card");
  });

  test("the selected styling MOVES with the selection, by click and by Enter/Space", () => {
    const el = tabs();
    const [, drift] = $$(el, '[role="tab"]');
    act(() => drift!.click());
    expect($$(el, '[role="tab"]')[1]!.getAttribute("aria-selected")).toBe("true");
    expect($$(el, '[role="tab"]')[1]!.className).toContain("border-b-[var(--primary)]");

    // HOW-27: the keyboard is Base UI's composite now, and it reads the FOCUSED element — a
    // bare keydown on an unfocused tab is not a keypress anybody made.
    //
    // Space is asserted and Enter is not, and that is a limit of the ENVIRONMENT rather than
    // of the component. A Base UI tab is a real `<button>`, so a browser turns Enter into a
    // click for it; happy-dom does not synthesise that, so asserting Enter here would assert
    // happy-dom. Enter and the arrow keys are checked in a real browser instead — see the
    // HOW-27 notes on the keyboard sweep.
    const first = $$(el, '[role="tab"]')[0]!;
    act(() => first.focus());
    press(first, " ");
    expect($$(el, '[role="tab"]')[0]!.getAttribute("aria-selected")).toBe("true");
    expect($$(el, '[role="tab"]')[0]!.className).toContain("border-b-[var(--primary)]");
  });

  /**
   * HOW-27 changed what "reachable without a mouse" MEANS here, and the assertion follows it.
   * These used to be hand-rolled buttons each with `tabIndex={0}`, so Tab walked through every
   * tab in the strip. On `@base-ui/react/tabs` it is a roving tabindex: the strip is ONE Tab
   * stop and the arrows move within it, which is the actual ARIA tabs pattern and fewer stops
   * between the operator and the pane they want. Still no pane is mouse-only — that is what
   * the arrow-key test below proves.
   */
  test("the strip is one focus stop, with the roving tabindex on the selected tab", () => {
    const el = tabs();
    const stops = $$(el, '[role="tab"]');
    expect(stops.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(stops.find((t) => t.getAttribute("aria-selected") === "true")!.tabIndex).toBe(0);
    for (const t of stops.filter((t) => t.getAttribute("aria-selected") !== "true")) expect(t.tabIndex).toBe(-1);
  });

  test("the top-level Tabs switcher is a tablist with the same selected contract", () => {
    function Harness() {
      const [v, setV] = useState("steps");
      return <Tabs value={v} onValueChange={setV} items={[{ value: "steps", label: "Steps" }, { value: "logs", label: "Logs" }]} />;
    }
    const el = renderPrimitive(<Harness />);
    const [steps, logs] = $$(el, '[role="tab"]');
    expect(steps!.getAttribute("aria-selected")).toBe("true");
    expect(steps!.className).not.toBe(logs!.className);
    // HOW-68: `Tabs` is the underline strip now, not a segmented control, so "selected" is the
    // indigo rule and a weight rather than a raised fill (DESIGN.md: one way a tab looks)
    expect(steps!.className).toContain("border-b-[var(--primary)]");
    expect(steps!.className).toContain("font-medium");
    expect(logs!.className).toContain("border-b-transparent");
  });
});

// ---- P0 defect 2: chips and pills have styling at all ----------------------------------

describe("Chip — the on state styles itself (P0.2) and is operable by keyboard (P2.8)", () => {
  test("an on chip's classes DIFFER from an off one, and it says aria-pressed", () => {
    const el = renderPrimitive(<><Chip on>attention</Chip><Chip>engine</Chip></>);
    const [on, off] = $$(el, "button");
    expect(on!.getAttribute("aria-pressed")).toBe("true");
    expect(off!.getAttribute("aria-pressed")).toBe("false");
    expect(on!.className).not.toBe(off!.className);
  });

  test("a chip has a BASE style whatever its state — the thing that was missing entirely", () => {
    const el = renderPrimitive(<Chip>engine</Chip>);
    const chip = $(el, "button")!;
    // border + padding + radius came from a rule that did not exist; they come from cva now
    expect(chip.className).toContain("rounded-[var(--radius-xs)]"); // HOW-68: 4px, DESIGN.md "4 chips"
    expect(chip.className).toContain("min-h-6"); // and the 24px target floor
    expect(chip.className).toContain("border");
    expect(chip.className).toContain("px-2");
  });

  test("on is never only a colour: it fills and strengthens its border", () => {
    const el = renderPrimitive(<><Chip on>x</Chip><Chip>x</Chip></>);
    const [on, off] = $$(el, "button");
    expect(on!.className).toContain("bg-card");
    expect(on!.className).toContain("border-[var(--border-strong)]");
    expect(off!.className).toContain("bg-transparent");
  });

  test("the attention chip is the one allowed the alarm colour, and only when on", () => {
    const el = renderPrimitive(<><Chip tone="attention" on>attention</Chip><Chip tone="attention">attention</Chip></>);
    const [on, off] = $$(el, "button");
    expect(on!.className).toContain("var(--attention)");
    expect(off!.className).not.toContain("var(--attention)");
  });

  test("it is a real button, so Enter and Space fire it and Tab reaches it", () => {
    let fired = 0;
    const el = renderPrimitive(<Chip onClick={() => fired++}>engine</Chip>);
    const chip = $(el, "button") as HTMLButtonElement;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.type).toBe("button");   // never a form submit
    expect(chip.disabled).toBe(false);  // i.e. it is in the tab order
    act(() => chip.click());            // what Enter and Space dispatch on a <button>
    expect(fired).toBe(1);
  });
});

describe("Badge — the static pills (P0.2)", () => {
  test("a bare Badge carries a base style, which `.pill` never had", () => {
    const el = renderPrimitive(<Badge>read-only</Badge>);
    const b = $(el, "span")!;
    expect(b.className).toContain("rounded-[var(--radius-xs)]"); // HOW-68: 4px, DESIGN.md "4 chips"
    expect(b.className).toContain("px-1.5");
  });

  test("each context scope reads differently, and via a token rather than a loose hex", () => {
    const el = renderPrimitive(
      <>
        {/* HOW-68 D26: `scopeVariant` was exported for this test alone and is gone; the variants are named directly */}
        <Badge variant="scope-cleared">cleared</Badge>
        <Badge variant="scope-per-visit">per-visit</Badge>
        <Badge variant="scope-sticky">sticky</Badge>
      </>,
    );
    const [cleared, perVisit, sticky] = $$(el, "span");
    expect(cleared!.className).toContain("var(--scope-cleared)");
    expect(new Set([cleared!.className, perVisit!.className, sticky!.className]).size).toBe(3);
  });
});

// ---- P2.8: the row surfaces ------------------------------------------------------------

describe("Row — one surface, and clickable means reachable (P1.6 + P2.8)", () => {
  test("a row that does something is a real button; a static one is not focusable", () => {
    const el = renderPrimitive(<><Row onClick={() => {}}>go</Row><Row as="div">header</Row></>);
    expect($(el, "button")).not.toBeNull();
    expect($$(el, "div").every((d) => d.tabIndex <= 0)).toBe(true);
  });

  test("Enter and Space fire a clickable row", () => {
    let fired = 0;
    const el = renderPrimitive(<Row onClick={() => fired++}>go</Row>);
    act(() => $(el, "button")!.click());
    expect(fired).toBe(1);
  });

  test("a navigation row stays an <a>, so middle-click and copy-link still work", () => {
    const el = renderPrimitive(<Row href="/run/abc">open</Row>);
    const a = $(el, "a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/run/abc");
  });

  /**
   * HOW-68 REPLACED the assertion that stood here ("needs-input outranks selected", which
   * required the amber tint and the 3px amber stripe to win over the selected styling).
   * DESIGN.md rule 1: the alarm is said once, as the status glyph, so a waiting row is not
   * painted at all, and "never a coloured side stripe" removes the other half. What must still
   * hold is that the FACT survives for whoever needs to find the row, and that selection is an
   * outline all the way round rather than a stripe down one edge.
   */
  test("a waiting row is MARKED, not painted; selected is an outline, never a side stripe", () => {
    const el = renderPrimitive(<Row selected needsInput onClick={() => {}}>parked</Row>);
    const row = $(el, "button")!;
    expect(row.getAttribute("data-needs-input")).toBe("true");
    expect(row.getAttribute("data-selected")).toBe("true");
    expect(row.className).not.toContain("var(--attention");
    // the outline: an inset 1px shadow on every side (0 0 0 1px), on the raised ground
    expect(row.className).toContain("shadow-[inset_0_0_0_1px_var(--border-strong)]");
    expect(row.className).toContain("bg-card");
    expect(row.className).not.toMatch(/inset_[1-9]px_0_0/); // a stripe is an x-offset shadow
  });

  test("an ordinary row carries neither mark", () => {
    const el = renderPrimitive(<Row onClick={() => {}}>plain</Row>);
    expect($(el, "button")!.hasAttribute("data-needs-input")).toBe(false);
    expect($(el, "button")!.hasAttribute("data-selected")).toBe(false);
  });

  test("every row kind's columns still come from its own class", () => {
    const el = renderPrimitive(<Row className="log-row attention" onClick={() => {}}>row</Row>);
    expect($(el, "button")!.className).toContain("log-row");
    expect($(el, "button")!.className).toContain("attention");
  });
});

// ---- P1.4/P1.5: the new primitives -----------------------------------------------------

describe("Checkbox — a real input, labelled (P1.5)", () => {
  test("the label is tied to the box by `for`, so the text is a hit target too", () => {
    const el = renderPrimitive(<Checkbox label="Attention chime" />);
    const input = $(el, "input") as HTMLInputElement;
    const label = $(el, "label") as HTMLLabelElement;
    expect(input.type).toBe("checkbox");
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).not.toBe("");
  });

  test("Space toggles it — the platform's, because it is a real checkbox", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Checkbox label="chime" checked={on} onChange={(e) => setOn(e.target.checked)} />;
    }
    const el = renderPrimitive(<Harness />);
    const input = $(el, "input") as HTMLInputElement;
    act(() => input.click()); // what Space dispatches on a checkbox
    expect(input.checked).toBe(true);
  });
});

describe("Dialog / AlertDialog — the confirmation surface (P1.4)", () => {
  test("it is a native <dialog> with the alert role and its title wired to aria-labelledby", () => {
    const el = renderPrimitive(<AlertDialog open onClose={() => {}} onConfirm={() => {}} title="Abort this run?" description="No undo." confirmLabel="Abort" />);
    const d = $(el, "dialog")!;
    expect(d.getAttribute("role")).toBe("alertdialog");
    expect($(el, `#${CSS.escape(d.getAttribute("aria-labelledby")!)}`)!.textContent).toBe("Abort this run?");
  });

  test("Cancel holds focus, so Enter is never the destructive answer", () => {
    const el = renderPrimitive(<AlertDialog open onClose={() => {}} onConfirm={() => {}} title="t" confirmLabel="Delete" />);
    const cancel = $$(el, "button").find((b) => b.textContent === "Cancel")!;
    const destructive = $$(el, "button").find((b) => b.textContent === "Delete")!;
    // React's autoFocus is a focus() call, not an attribute — so assert where focus landed
    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(destructive);
  });

  test("Esc cancels rather than confirming", () => {
    let closed = 0, confirmed = 0;
    const el = renderPrimitive(<AlertDialog open onClose={() => closed++} onConfirm={() => confirmed++} title="t" confirmLabel="Delete" />);
    act(() => { $(el, "dialog")!.dispatchEvent(new window.Event("cancel", { bubbles: true, cancelable: true })); });
    expect(closed).toBe(1);
    expect(confirmed).toBe(0);
  });

  test("closed means NOT rendered — a hidden dialog must not leave its buttons in the tree", () => {
    const el = renderPrimitive(<AlertDialog open={false} onClose={() => {}} onConfirm={() => {}} title="t" confirmLabel="Delete" />);
    expect($(el, "dialog")).toBeNull();
    expect($$(el, "button")).toHaveLength(0);
  });

  test("window.confirm stays out of this app: confirming is a call, not a blocking prompt", () => {
    let confirmed = 0;
    const el = renderPrimitive(<AlertDialog open onClose={() => {}} onConfirm={() => confirmed++} title="t" confirmLabel="Delete" />);
    act(() => { $$(el, "button").find((b) => b.textContent === "Delete")!.click(); });
    expect(confirmed).toBe(1);
  });

  test("a plain Dialog is role=dialog and can carry its own controls", () => {
    const el = renderPrimitive(<Dialog open onClose={() => {}} title="Reject?"><Button>Reject it</Button></Dialog>);
    expect($(el, "dialog")!.getAttribute("role")).toBe("dialog");
    expect($$(el, "button").map((b) => b.textContent)).toContain("Reject it");
  });
});

describe("Tooltip — hover AND focus AND tap, tied by aria-describedby (P1.4)", () => {
  /**
   * HOW-27: on `@base-ui/react/tooltip` the popup is PORTALLED and only mounted while open, so
   * "closed" is now "absent from the document" rather than "present with [hidden]", and the
   * query is document-wide rather than scoped to the host.
   *
   * The assertion that matters is unchanged and is the reason this component exists: opening it
   * names the trigger's description. The primitive does NOT provide that — its popup carries no
   * role, no id and sets no `aria-describedby` — so tooltip.tsx wires all three itself, and this
   * is what stops that wiring being dropped as "the library handles it".
   */
  test("it is closed until something opens it, and opening it names the trigger's description", async () => {
    const el = renderPrimitive(<Tooltip content="Folder is gone"><span tabIndex={0}>Open in IDE</span></Tooltip>);
    const trigger = $(el, '[data-slot="tooltip-trigger"]')!;
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);

    // awaited: the positioner measures and re-renders after the popup mounts, and an
    // un-awaited act() leaves that update outside the test's act scope (React says so, loudly)
    // REALLY focused, not a synthetic focusin: off macOS, Base UI's useFocus opens only when the
    // target matches :focus-visible, which happy-dom answers from activeElement. On macOS it
    // takes an isMacSafari branch that skips the check, which is why a bare event passed there
    // and failed on Linux CI.
    const focusable = trigger.querySelector<HTMLElement>("[tabindex]")!;
    await act(async () => { focusable.focus(); });
    const tip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe("Folder is gone");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.id).not.toBe("");
  });

  test("the trigger is a span, so a tooltip inside a control is not a nested button", () => {
    const el = renderPrimitive(<Tooltip content="why"><span>text</span></Tooltip>);
    expect($(el, '[data-slot="tooltip-trigger"]')!.tagName).toBe("SPAN");
  });

  // HOW-68 confirming review: J and K down the Runs list eased a tooltip in and out on every
  // press (measured in Chromium: two running transitions per key). A FORCED tooltip is the
  // keyboard's — the row's link has focus — so it does not animate.
  test("a tooltip forced open by its row's focus is instant", () => {
    renderPrimitive(<Tooltip content="the whole value" forceOpen><span>cut…</span></Tooltip>);
    const forced = document.querySelector('[data-slot="tooltip"]')!;
    expect(forced.textContent).toBe("the whole value");
    expect(forced.className.split(" ")).toContain("transition-none");
  });

  test("empty content renders the trigger alone — never an empty floating box", () => {
    const el = renderPrimitive(<Tooltip content=""><span>bare</span></Tooltip>);
    expect($(el, '[role="tooltip"]')).toBeNull();
    expect(el.textContent).toBe("bare");
  });
});

describe("Select — a styled NATIVE select, because no Radix (P1.3)", () => {
  test("it renders a real <select> with real <option>s", () => {
    const el = renderPrimitive(<Select value="claude" onChange={() => {}}><option value="claude">claude</option><option value="codex">codex</option></Select>);
    const sel = $(el, "select") as HTMLSelectElement;
    expect(sel.tagName).toBe("SELECT");
    expect(sel.value).toBe("claude");
    expect($$(el, "option")).toHaveLength(2);
  });
});

describe("Table — the cell padding is the table's, once (P1.4)", () => {
  test("no cell repeats the hairline and padding the row and cell already own", () => {
    const el = renderPrimitive(<Table><TableBody><TableRow><TableCell>a</TableCell><TableCell>b</TableCell></TableRow></TableBody></Table>);
    const [a, b] = $$(el, "td");
    expect(a!.className).toBe(b!.className);
    expect($(el, "tr")!.className).toContain("border-b");
    expect(a!.className).not.toContain("border-b");
  });
});

describe("Button — icon-only controls are labelled (P2.11)", () => {
  test("size=icon keeps whatever aria-label the call site gives it", () => {
    const el = renderPrimitive(<Button size="icon" aria-label="remove the notes workspace">×</Button>);
    expect($(el, "button")!.getAttribute("aria-label")).toBe("remove the notes workspace");
  });

  test("a Button is type=button, so one inside a form never submits it", () => {
    const el = renderPrimitive(<Button>Save</Button>);
    expect(($(el, "button") as HTMLButtonElement).type).toBe("button");
  });
});
