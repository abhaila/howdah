/**
 * The HOW-68 primitives, pinned for the behaviour that is the reason each one exists.
 *
 *   Truncate — an ellipsis must expose the full value on FOCUS, not only on hover. That is
 *   the whole of DESIGN.md rule 5, and it is the half the old tooltips-on-spans got wrong.
 *   Kbd — prints what the registry was given, so a hint and its binding cannot disagree.
 *   CommandPalette — filters, and Enter runs what is highlighted.
 *   Drawer — non-modal, and Esc closes it through the one Escape layering.
 *   ScrollPane, KeyValue, Toolbar, Menu — the one property each would be useless without.
 *
 * happy-dom computes no layout, so "is this text cut?" is answered by stubbing the two
 * numbers the component reads (scrollWidth, clientWidth) rather than by rendering pixels.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CommandPalette, filterCommands, paletteCommands } from "./ui/command-palette";
import { Drawer, useDrawer } from "./ui/drawer";
import { Kbd } from "./ui/kbd";
import { KeyValue } from "./ui/key-value";
import { Menu } from "./ui/menu";
import { ScrollPane } from "./ui/scroll-pane";
import { SectionLabel } from "./ui/section-label";
import { ShortcutSheet } from "./ui/shortcut-sheet";
import { Toolbar } from "./ui/toolbar";
import { Truncate } from "./ui/truncate";
import { Button } from "./ui/button";
import { formatKeys, installShortcuts, registerShortcuts, resetShortcutsForTest, setSingleKeysEnabled, type Shortcut } from "@/lib/shortcuts";

let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: Array<() => void> = [];

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
beforeEach(() => {
  try { localStorage.clear(); } catch { /* not every environment has one */ }
  resetShortcutsForTest();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  for (const r of restore) r();
  restore = [];
});

const $ = (el: ParentNode, sel: string) => el.querySelector(sel) as HTMLElement | null;
const $$ = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
}

/** make every element report this content/box width, as a layout engine would */
function stubWidths(scroll: number, client: number) {
  for (const [prop, value] of [["scrollWidth", scroll], ["clientWidth", client], ["scrollHeight", scroll], ["clientHeight", client]] as const) {
    const real = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, prop) ?? Object.getOwnPropertyDescriptor(window.Element.prototype, prop);
    Object.defineProperty(window.HTMLElement.prototype, prop, { configurable: true, get: () => value });
    restore.push(() => {
      if (real) Object.defineProperty(window.HTMLElement.prototype, prop, real);
      else delete (window.HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    });
  }
}

// ---- Truncate --------------------------------------------------------------------------

describe("Truncate — an ellipsis always has a way to read the value (DESIGN.md rule 5)", () => {
  const FULL = "implement-ticket-how-431-add-rate-limit-headers-mhv3a7xw";

  test("cut text becomes a focus stop, and FOCUS shows the full value in a tooltip", async () => {
    stubWidths(500, 120);
    const el = render(<Truncate>{FULL}</Truncate>);
    const text = $(el, '[data-slot="truncate"]')!;
    expect(text.hasAttribute("data-truncated")).toBe(true);
    expect(text.tabIndex).toBe(0);
    expect(document.querySelector('[role="tooltip"]')).toBeNull(); // closed until asked

    await act(async () => { text.focus(); });
    const tip = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tip).not.toBeNull();
    expect(tip.textContent).toBe(FULL);
    // and it is tied to the trigger, so a screen reader is told it is the description
    expect($(el, '[data-slot="tooltip-trigger"]')!.getAttribute("aria-describedby")).toBe(tip.id);
  });

  test("text that FITS is plain text: no focus stop, no tooltip, nothing to tab through", async () => {
    stubWidths(120, 120);
    const el = render(<Truncate>Bump Kotlin to 2.2</Truncate>);
    const text = $(el, '[data-slot="truncate"]')!;
    expect(text.hasAttribute("data-truncated")).toBe(false);
    expect(text.hasAttribute("tabindex")).toBe(false);
    await act(async () => { text.focus(); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("the ellipsis itself is the component's: one line, cut, and able to shrink", () => {
    const el = render(<Truncate>anything</Truncate>);
    const cls = $(el, '[data-slot="truncate"]')!.className;
    expect(cls).toContain("truncate"); // Tailwind: overflow hidden + ellipsis + nowrap
    expect(cls).toContain("min-w-0"); // or a flex parent refuses to let it shrink at all
  });

  test("inside a link it adds NO second focus stop — it shows while the link has focus", async () => {
    stubWidths(500, 120);
    const el = render(<a href="/run/x"><Truncate>{FULL}</Truncate></a>);
    const text = $(el, '[data-slot="truncate"]')!;
    expect(text.hasAttribute("data-truncated")).toBe(true);
    expect(text.hasAttribute("tabindex")).toBe(false);
    await act(async () => { $(el, "a")!.focus(); });
    expect((document.querySelector('[role="tooltip"]') as HTMLElement | null)?.textContent).toBe(FULL);
    await act(async () => { $(el, "a")!.blur(); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("`middle` keeps the tail visible and the whole value in the DOM, in order", () => {
    const el = render(<Truncate mono middle={8}>{FULL}</Truncate>);
    const outer = $(el, '[data-slot="truncate"]')!;
    expect(outer.textContent).toBe(FULL); // select-and-copy gets all of it
    const [head, tail] = $$(outer, "span");
    expect(tail!.textContent).toBe("mhv3a7xw");
    expect(head!.className).toContain("truncate");
    expect(tail!.className).toContain("shrink-0"); // the tail is what must never be cut
    expect(outer.className).toContain("font-mono");
  });

  test("a non-string child still gets its full value from `text`", async () => {
    stubWidths(500, 120);
    const el = render(<Truncate text="the whole thing"><b>the whole</b> thing</Truncate>);
    await act(async () => { $(el, '[data-slot="truncate"]')!.focus(); });
    expect((document.querySelector('[role="tooltip"]') as HTMLElement).textContent).toBe("the whole thing");
  });
});

// ---- Kbd -------------------------------------------------------------------------------

describe("Kbd — prints a key from the registry's own grammar", () => {
  test("a chord is one cap, printed for this platform", () => {
    const el = render(<Kbd keys="mod+k" />);
    const caps = $$(el, "kbd");
    expect(caps).toHaveLength(1);
    expect(caps[0]!.textContent).toBe(formatKeys("mod+k")[0]!);
    expect(["⌘K", "Ctrl K"]).toContain(caps[0]!.textContent!);
  });

  test("a sequence is one cap PER PRESS — G then R is not a chord", () => {
    const el = render(<Kbd keys="g r" />);
    expect($$(el, "kbd").map((k) => k.textContent)).toEqual(["G", "R"]);
  });

  test("children are printed as given, in a real <kbd>", () => {
    const el = render(<Kbd>Esc</Kbd>);
    expect($(el, "kbd")!.textContent).toBe("Esc");
  });

  test("`decorative` hides it from assistive tech — the control it sits in names itself", () => {
    const el = render(<><Kbd keys="c" decorative /><Kbd keys="g r" decorative /><Kbd keys="c" /></>);
    expect($$(el, "[aria-hidden='true']")).toHaveLength(2);
  });

  test("it never goes under the 12px floor, and it is mono because a key is matched exactly", () => {
    const el = render(<Kbd keys="c" />);
    const cls = $(el, "kbd")!.className;
    expect(cls).toContain("text-xs");
    expect(cls).toContain("font-mono");
  });
});

// ---- CommandPalette --------------------------------------------------------------------

describe("CommandPalette — filter, arrows, Enter", () => {
  const ran: string[] = [];
  const COMMANDS: Shortcut[] = [
    { id: "go.runs", scope: "Anywhere", label: "Go to Runs", keys: "g r", run: () => ran.push("runs") },
    { id: "go.settings", scope: "Anywhere", label: "Go to Settings", keys: "g s", keywords: "preferences", run: () => ran.push("settings") },
    { id: "new", scope: "Anywhere", label: "New run", keys: "c", run: () => ran.push("new") },
    { id: "gallery", scope: "Developer", label: "Component gallery", run: () => ran.push("gallery") },
    { id: "esc", scope: "Layers", label: "Close the topmost layer", keys: "escape", passive: true },
    { id: "hidden", scope: "Anywhere", label: "Command palette", keys: "mod+k", palette: false, run: () => ran.push("palette") },
  ];
  beforeEach(() => { ran.length = 0; });

  function open(onClose: () => void = () => {}) {
    const el = render(<CommandPalette open onClose={onClose} commands={COMMANDS} />);
    return { el, input: $(el, "input") as HTMLInputElement };
  }
  function type(input: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  const labels = (el: HTMLElement) => $$(el, '[role="option"]').map((o) => o.firstElementChild!.textContent);

  test("the filter is pure: every word must match, a label that starts with the query leads", () => {
    const cmds = paletteCommands(COMMANDS);
    expect(cmds.map((c) => c.id)).toEqual(["go.runs", "go.settings", "new", "gallery"]); // no passive row, no opted-out row
    expect(filterCommands(cmds, "").map((c) => c.id)).toEqual(["go.runs", "go.settings", "new", "gallery"]);
    expect(filterCommands(cmds, "run").map((c) => c.id)).toEqual(["go.runs", "new"]);
    expect(filterCommands(cmds, "new").map((c) => c.id)).toEqual(["new"]);
    expect(filterCommands(cmds, "go set").map((c) => c.id)).toEqual(["go.settings"]);
    expect(filterCommands(cmds, "preferences").map((c) => c.id)).toEqual(["go.settings"]); // keywords count
    expect(filterCommands(cmds, "developer").map((c) => c.id)).toEqual(["gallery"]); // so does the scope
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });

  test("it is a native dialog holding a combobox and a listbox, with the first option active", () => {
    const { el, input } = open();
    expect($(el, "dialog")).not.toBeNull();
    expect(input.getAttribute("role")).toBe("combobox");
    const options = $$(el, '[role="option"]');
    expect(options).toHaveLength(4);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(input.getAttribute("aria-controls")).toBe($(el, '[role="listbox"]')!.id);
  });

  test("typing filters the list, and says so when nothing matches", () => {
    const { el, input } = open();
    type(input, "sett");
    expect(labels(el)).toEqual(["Go to Settings"]);
    type(input, "zzz");
    expect($$(el, '[role="option"]')).toHaveLength(0);
    expect(el.textContent).toContain("No command matches");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("Enter runs the highlighted command and closes first", () => {
    const order: string[] = [];
    const { input } = open(() => order.push("closed"));
    type(input, "sett");
    key(input, "Enter");
    expect(ran).toEqual(["settings"]);
    expect(order).toEqual(["closed"]);
  });

  test("Down and Up move the active option, wrapping at the ends; Enter runs where they stopped", () => {
    const { el, input } = open();
    const active = () => $$(el, '[role="option"]').findIndex((o) => o.getAttribute("aria-selected") === "true");
    key(input, "ArrowDown");
    expect(active()).toBe(1);
    key(input, "ArrowUp"); key(input, "ArrowUp");
    expect(active()).toBe(3); // wrapped from the first to the last
    key(input, "ArrowDown");
    expect(active()).toBe(0);
    key(input, "End");
    expect(active()).toBe(3);
    key(input, "Enter");
    expect(ran).toEqual(["gallery"]);
  });

  test("clicking an option runs it", () => {
    const { el } = open();
    act(() => $$(el, '[role="option"]')[2]!.click());
    expect(ran).toEqual(["new"]);
  });

  test("each option prints its shortcut, so the palette teaches the keys", () => {
    const { el } = open();
    const [runs, , , gallery] = $$(el, '[role="option"]');
    expect($$(runs!, "kbd").map((k) => k.textContent)).toEqual(["G", "R"]);
    expect($$(gallery!, "kbd")).toHaveLength(0); // a palette-only command has none
  });

  test("closed means not rendered", () => {
    const el = render(<CommandPalette open={false} onClose={() => {}} commands={COMMANDS} />);
    expect($(el, "dialog")).toBeNull();
  });

  test("with no `commands` it lists the live registry — a screen's shortcuts are its commands", () => {
    const off = registerShortcuts([{ id: "run.reply", scope: "A run", label: "Reply", keys: "r", run: () => {} }]);
    const el = render(<CommandPalette open onClose={() => {}} />);
    expect(labels(el)).toEqual(["Reply"]);
    act(() => off()); // unregistering re-renders the palette, as a screen unmounting would
  });
});

// ---- ShortcutSheet ---------------------------------------------------------------------

describe("ShortcutSheet — `?` lists everything registered", () => {
  test("it prints the registry grouped by scope, passive rows included, palette-only rows not", () => {
    registerShortcuts([
      { id: "go.runs", scope: "Anywhere", label: "Go to Runs", keys: "g r", run: () => {} },
      { id: "esc", scope: "Layers", label: "Close the topmost layer", keys: "escape", passive: true },
      { id: "gallery", scope: "Developer", label: "Component gallery", run: () => {} },
    ]);
    const el = render(<ShortcutSheet open onClose={() => {}} />);
    expect($$(el, "section").map((s) => s.getAttribute("aria-label"))).toEqual(["Anywhere", "Layers"]);
    expect(el.textContent).toContain("Go to Runs");
    expect(el.textContent).toContain("Close the topmost layer");
    expect(el.textContent).not.toContain("Component gallery"); // no keys, so nothing to list
  });

  test("it carries the single-key setting, and a row that setting silences says so", () => {
    registerShortcuts([
      { id: "new", scope: "Anywhere", label: "New run", keys: "c", run: () => {} },
      { id: "palette", scope: "Anywhere", label: "Command palette", keys: "mod+k", run: () => {} },
    ]);
    const el = render(<ShortcutSheet open onClose={() => {}} />);
    const box = $(el, 'input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    act(() => setSingleKeysEnabled(false));
    expect(($(el, 'input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    const rows = $$(el, "li");
    expect(rows[0]!.textContent).toContain("(off)"); // `c` is a bare key
    expect(rows[1]!.textContent).not.toContain("(off)"); // ⌘K is not
  });
});

// ---- Drawer ----------------------------------------------------------------------------

describe("Drawer — a non-modal panel that Esc closes", () => {
  function Harness({ startOpen = true }: { startOpen?: boolean }) {
    const [open, setOpen] = useState(startOpen);
    return (
      <div>
        <Button onClick={() => setOpen(!open)}>Details</Button>
        <Drawer open={open} onClose={() => setOpen(false)} label="Run details"><p>the details</p><Button>inside</Button></Drawer>
      </div>
    );
  }
  let uninstall: () => void = () => {};
  beforeEach(() => { uninstall = installShortcuts(); });
  afterEach(() => uninstall());

  test("it is an <aside> in the layout: a named landmark, not a dialog, with no scrim", () => {
    const el = render(<Harness />);
    const drawer = $(el, '[data-slot="drawer"]')!;
    expect(drawer.tagName).toBe("ASIDE");
    expect(drawer.getAttribute("aria-label")).toBe("Run details");
    expect(drawer.getAttribute("role")).toBeNull(); // the element's own complementary role
    expect(drawer.hasAttribute("aria-modal")).toBe(false);
    expect(document.querySelector("dialog")).toBeNull();
    expect(drawer.style.width).toBe("320px"); // DESIGN.md Layout
  });

  test("Esc closes it when nothing more specific is open", () => {
    const el = render(<Harness />);
    key(document.body, "Escape");
    expect($(el, '[data-slot="drawer"]')).toBeNull();
  });

  test("Esc closes it from inside, too", () => {
    const el = render(<Harness />);
    const inside = $$(el, '[data-slot="drawer"] button').find((b) => b.textContent === "inside")!;
    act(() => inside.focus());
    key(inside, "Escape");
    expect($(el, '[data-slot="drawer"]')).toBeNull();
  });

  test("Esc is NOT the drawer's while a menu is open over it", () => {
    const el = render(<Harness />);
    const menu = document.createElement("div");
    menu.setAttribute("data-layer", "menu");
    document.body.appendChild(menu);
    key(document.body, "Escape");
    expect($(el, '[data-slot="drawer"]')).not.toBeNull();
    menu.remove();
    key(document.body, "Escape");
    expect($(el, '[data-slot="drawer"]')).toBeNull();
  });

  test("a closed drawer is not rendered and takes no Escape", () => {
    let closes = 0;
    const el = render(<Drawer open={false} onClose={() => { closes++; }} label="Run details">x</Drawer>);
    expect($(el, '[data-slot="drawer"]')).toBeNull();
    key(document.body, "Escape");
    expect(closes).toBe(0);
  });

  test("its close button names what it closes", () => {
    const el = render(<Harness />);
    const close = $(el, 'button[aria-label="Close Run details"]')!;
    act(() => close.click());
    expect($(el, '[data-slot="drawer"]')).toBeNull();
  });

  test("useDrawer remembers open/closed like every other pane preference", () => {
    let state: ReturnType<typeof useDrawer> | null = null;
    function Probe() { state = useDrawer("howdah.test.details"); return null; }
    render(<Probe />);
    act(() => state!.setOpen(true));
    expect(localStorage.getItem("howdah.test.details.open")).toBe("1");
    act(() => state!.toggle());
    expect(state!.open).toBe(false);
    expect(localStorage.getItem("howdah.test.details.open")).toBe("0");
  });
});

// ---- ScrollPane, KeyValue, Toolbar, SectionLabel, Menu ---------------------------------

describe("ScrollPane — the one scroller, reachable by keyboard when it overflows", () => {
  test("it carries the three properties that make a flex child scroll instead of grow", () => {
    const el = render(<ScrollPane label="Transcript">x</ScrollPane>);
    const cls = $(el, '[data-slot="scroll-pane"]')!.className;
    for (const c of ["flex-1", "min-h-0", "overflow-y-auto"]) expect(cls).toContain(c);
  });

  test("overflowing: a named focus stop, so arrows and Page keys can scroll it", () => {
    stubWidths(900, 300);
    const el = render(<ScrollPane label="Transcript"><p>long</p></ScrollPane>);
    const pane = $(el, '[data-slot="scroll-pane"]')!;
    expect(pane.tabIndex).toBe(0);
    expect(pane.getAttribute("role")).toBe("region");
    expect(pane.getAttribute("aria-label")).toBe("Transcript");
  });

  test("fitting: no tab stop and no landmark — a pane that needs neither adds neither", () => {
    stubWidths(300, 300);
    const el = render(<ScrollPane label="Transcript"><p>short</p></ScrollPane>);
    const pane = $(el, '[data-slot="scroll-pane"]')!;
    expect(pane.hasAttribute("tabindex")).toBe(false);
    expect(pane.hasAttribute("role")).toBe(false);
  });
});

describe("KeyValue — values wrap, labels are not mono", () => {
  test("it is a <dl> of pairs; a value wraps anywhere rather than being cut", () => {
    const el = render(<KeyValue items={[{ label: "Branch", value: "howdah/implement-ticket-mhv2k9qd", mono: true }, { label: "Cost", value: "$2.44" }]} />);
    expect($(el, "dl")).not.toBeNull();
    expect($$(el, "dt").map((d) => d.textContent)).toEqual(["Branch", "Cost"]);
    const [branch, cost] = $$(el, "dd > span");
    expect(branch!.className).toContain("[overflow-wrap:anywhere]");
    expect(branch!.className).not.toContain("truncate");
    expect(branch!.className).toContain("font-mono");
    expect(cost!.className).not.toContain("font-mono");
    for (const dt of $$(el, "dt")) expect(dt.className).not.toContain("font-mono"); // a label is never mono
  });

  // HOW-68: `overflow-wrap: anywhere` alone broke a path at its hyphens first — five ragged lines
  test("a path breaks after its slashes, and its text is unchanged", () => {
    const path = "/home/me/.howdah/runs/implement-ticket-mhv2k9qd/run.jsonl";
    const el = render(<KeyValue items={[{ label: "Log", value: path, mono: true, copy: true }]} />);
    const value = $(el, "dd > span")!;
    expect(value.textContent).toBe(path); // what is selected and copied is the path itself
    const segments = [...value.querySelectorAll(":scope > span")].map((s) => s.textContent);
    expect(segments).toEqual(["/", "home/", "me/", ".howdah/", "runs/", "implement-ticket-mhv2k9qd/", "run.jsonl"]);
    expect(value.querySelectorAll("wbr")).toHaveLength(segments.length - 1);
    for (const s of value.querySelectorAll(":scope > span")) expect(s.className).toContain("inline-block");
  });

  test("an absent value is printed as absent, never as a blank cell", () => {
    const el = render(<KeyValue items={[{ label: "PR", value: null, copy: true }]} />);
    expect($(el, "dd")!.textContent).toBe("—");
    expect($(el, "dd button")).toBeNull(); // and there is nothing to copy
  });

  test("copy is a named button that confirms in place", async () => {
    const written: string[] = [];
    const real = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { written.push(t); } } });
    restore.push(() => { if (real) Object.defineProperty(navigator, "clipboard", real); else delete (navigator as unknown as Record<string, unknown>).clipboard; });
    const el = render(<KeyValue items={[{ label: "Branch", value: "howdah/x", mono: true, copy: true }]} />);
    const copy = $(el, "dd button")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy branch");
    await act(async () => { copy.click(); });
    expect(written).toEqual(["howdah/x"]);
    expect($(el, "dd button")!.getAttribute("aria-label")).toBe("Copied branch");
  });
});

describe("Toolbar — one row, and the arrows move along it", () => {
  test("it is a named toolbar that does not wrap or shrink", () => {
    const el = render(<Toolbar label="Run actions"><Button>a</Button></Toolbar>);
    const bar = $(el, '[role="toolbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Run actions");
    expect(bar.className).toContain("flex-nowrap");
    expect(bar.className).toContain("shrink-0");
  });

  test("Right/Left move focus between its controls, skipping a disabled one; Home/End jump", () => {
    const el = render(<Toolbar label="Run actions"><Button>a</Button><Button disabled>b</Button><Button>c</Button></Toolbar>);
    const [a, , c] = $$(el, "button");
    act(() => a!.focus());
    key(a!, "ArrowRight");
    expect(document.activeElement).toBe(c!);
    key(c!, "ArrowRight"); // wraps
    expect(document.activeElement).toBe(a!);
    key(a!, "End");
    expect(document.activeElement).toBe(c!);
    key(c!, "Home");
    expect(document.activeElement).toBe(a!);
  });
});

describe("SectionLabel — 12px/600, never uppercase", () => {
  test("it is weight and size, with no text-transform and no tracking", () => {
    const el = render(<SectionLabel as="h2" count={11}>Needs you</SectionLabel>);
    const label = $(el, "h2")!;
    expect(label.className).toContain("text-xs");
    expect(label.className).toContain("font-semibold");
    expect(label.className).not.toContain("uppercase");
    expect(label.className).not.toContain("tracking");
    expect(label.textContent).toBe("Needs you11");
  });
});

describe("Menu — a trigger that opens a list of actions", () => {
  test("the trigger is the caller's own button, told it has a menu; closed means no items", () => {
    const el = render(<Menu trigger={<Button variant="outline">More</Button>} items={[{ label: "Open in IDE" }]} />);
    const trigger = $(el, "button")!;
    expect(trigger.textContent).toBe("More");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test("open: items are menuitems, a shortcut is printed, and the popup is a layer Escape respects", async () => {
    const picked: string[] = [];
    const el = render(
      <Menu
        trigger={<Button variant="outline">More</Button>}
        items={[{ label: "Open in IDE", keys: "o", onSelect: () => picked.push("ide") }, { separator: true }, { label: "Abort run", destructive: true, disabled: true }]}
      />,
    );
    await act(async () => { $(el, "button")!.click(); });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute("data-layer")).toBe("menu");
    const items = $$(menu, '[role="menuitem"]');
    expect(items.map((i) => i.firstElementChild?.textContent ?? i.textContent)).toEqual(["Open in IDE", "Abort run"]);
    expect($(items[0]!, "kbd")!.textContent).toBe("O");
    expect(items[1]!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { items[0]!.click(); });
    expect(picked).toEqual(["ide"]);
  });
});
