/**
 * The keyboard registry (HOW-68), pinned where it can strand or surprise the operator.
 *
 * The happy path — press a key, something runs — is the least interesting thing here. What is
 * worth a test is each REFUSAL, because every one of them is invisible until it bites: a "c"
 * typed into the composer that opens New run, a shortcut firing on the page behind a confirm
 * dialog, an Escape that closes the drawer AND the menu that was open over it, a sequence that
 * swallows the key after it. happy-dom via bunfig's preload, like the other web/app tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SEQUENCE_MS, allShortcuts, formatKeys, groupByScope, installShortcuts, isMac, isSingleKey, parseKeys,
  pushEscapeLayer, registerShortcuts, resetShortcutsForTest, setSingleKeysEnabled, singleKeysEnabled, strokeOf,
} from "./shortcuts";

let uninstall: () => void = () => {};
let made: HTMLElement[] = [];

beforeEach(() => {
  try { localStorage.clear(); } catch { /* not every environment has one */ }
  resetShortcutsForTest();
  uninstall = installShortcuts();
});
afterEach(() => {
  uninstall();
  for (const el of made) el.remove();
  made = [];
});

/** a real keydown, dispatched where focus would be so `target` is honest */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
/** the platform's ⌘/Ctrl, whichever this machine calls `mod` */
const MOD: KeyboardEventInit = isMac() ? { metaKey: true } : { ctrlKey: true };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.appendChild(node);
  made.push(node);
  return node;
}

describe("the key grammar", () => {
  test("a sequence is strokes separated by spaces; a chord is joined with +", () => {
    expect(parseKeys("g r")).toEqual(["g", "r"]);
    expect(parseKeys("Mod+K")).toEqual(["mod+k"]);
    expect(parseKeys("shift+mod+k")).toEqual(["mod+shift+k"]); // one canonical order
    expect(parseKeys("esc")).toEqual(["escape"]);
  });

  test("an event's stroke: `?` is `?` whatever Shift did to produce it, but Shift+G is not G", () => {
    expect(strokeOf({ key: "?", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false })).toBe("?");
    expect(strokeOf({ key: "G", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false })).toBe("shift+g");
    expect(strokeOf({ key: "g", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false })).toBe("g");
    expect(strokeOf({ key: "Shift", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
    expect(strokeOf({ key: "k", shiftKey: false, metaKey: true, ctrlKey: false, altKey: false }, true)).toBe("mod+k");
    expect(strokeOf({ key: "k", shiftKey: false, metaKey: false, ctrlKey: true, altKey: false }, false)).toBe("mod+k");
    // Ctrl+K on a Mac is kill-line in a text field, not the palette
    expect(strokeOf({ key: "k", shiftKey: false, metaKey: false, ctrlKey: true, altKey: false }, true)).toBe("ctrl+k");
  });

  test("it prints for the platform, one cap per press", () => {
    expect(formatKeys("mod+k", true)).toEqual(["⌘K"]);
    expect(formatKeys("mod+k", false)).toEqual(["Ctrl K"]);
    expect(formatKeys("g r", true)).toEqual(["G", "R"]);
    expect(formatKeys("escape", true)).toEqual(["Esc"]);
    expect(formatKeys("?", false)).toEqual(["?"]);
  });

  test("a single key is any stroke without ⌘/Ctrl/Alt", () => {
    expect(isSingleKey("c")).toBe(true);
    expect(isSingleKey("shift+g")).toBe(true);
    expect(isSingleKey("mod+k")).toBe(false);
    expect(isSingleKey("alt+c")).toBe(false);
  });
});

describe("the registry", () => {
  test("a registered row is listed until it is unregistered", () => {
    const off = registerShortcuts([{ id: "a", scope: "Anywhere", label: "A", keys: "a", run: () => {} }]);
    expect(allShortcuts().map((s) => s.id)).toEqual(["a"]);
    off();
    expect(allShortcuts()).toEqual([]);
  });

  test("rows group by scope in first-seen order — the shape the sheet and the palette render", () => {
    registerShortcuts([
      { id: "a", scope: "Anywhere", label: "A", keys: "a", run: () => {} },
      { id: "r", scope: "A run", label: "R", keys: "r", run: () => {} },
      { id: "b", scope: "Anywhere", label: "B", keys: "b", run: () => {} },
    ]);
    expect(groupByScope(allShortcuts()).map((g) => [g.scope, g.items.map((i) => i.id)])).toEqual([["Anywhere", ["a", "b"]], ["A run", ["r"]]]);
  });

  test("a later registration wins the same keys: a screen's binding beats the shell's", () => {
    const ran: string[] = [];
    registerShortcuts([{ id: "shell.r", scope: "Anywhere", label: "shell", keys: "r", run: () => ran.push("shell") }]);
    const off = registerShortcuts([{ id: "run.r", scope: "A run", label: "reply", keys: "r", run: () => ran.push("screen") }]);
    press("r");
    off();
    press("r");
    expect(ran).toEqual(["screen", "shell"]);
  });

  test("a passive row is listed but never run here; a disabled row is inert", () => {
    let ran = 0;
    registerShortcuts([
      { id: "esc", scope: "Layers", label: "Close", keys: "x", passive: true, run: () => { ran++; } },
      { id: "off", scope: "Anywhere", label: "Off", keys: "y", disabled: true, run: () => { ran++; } },
    ]);
    press("x"); press("y");
    expect(ran).toBe(0);
    expect(allShortcuts()).toHaveLength(2);
  });
});

describe("pressing keys", () => {
  test("a matched shortcut runs and takes the key (preventDefault)", () => {
    let ran = 0;
    registerShortcuts([{ id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } }]);
    expect(press("c").defaultPrevented).toBe(true);
    expect(ran).toBe(1);
    expect(press("z").defaultPrevented).toBe(false); // an unbound key is left alone
  });

  test("G then R is a sequence: neither key alone does anything", () => {
    const ran: string[] = [];
    registerShortcuts([
      { id: "go.runs", scope: "Anywhere", label: "Runs", keys: "g r", run: () => ran.push("runs") },
      { id: "go.graphs", scope: "Anywhere", label: "Graphs", keys: "g g", run: () => ran.push("graphs") },
    ]);
    press("r");
    expect(ran).toEqual([]);
    press("g");
    expect(ran).toEqual([]);
    press("r");
    expect(ran).toEqual(["runs"]);
    press("g"); press("g");
    expect(ran).toEqual(["runs", "graphs"]);
    press("r"); // the sequence is spent: R alone is nothing again
    expect(ran).toEqual(["runs", "graphs"]);
  });

  test("a broken sequence gives the second key its own chance (G then C is New run)", () => {
    const ran: string[] = [];
    registerShortcuts([
      { id: "go.runs", scope: "Anywhere", label: "Runs", keys: "g r", run: () => ran.push("runs") },
      { id: "new", scope: "Anywhere", label: "New run", keys: "c", run: () => ran.push("new") },
    ]);
    press("g"); press("c");
    expect(ran).toEqual(["new"]);
  });

  test("a sequence times out: G, a long pause, then R is not Go to Runs", async () => {
    let ran = 0;
    registerShortcuts([{ id: "go.runs", scope: "Anywhere", label: "Runs", keys: "g r", run: () => { ran++; } }]);
    press("g");
    await Bun.sleep(SEQUENCE_MS + 60);
    press("r");
    expect(ran).toBe(0);
  });

  test("single keys are ignored while typing — input, textarea, select, contenteditable", () => {
    let ran = 0;
    registerShortcuts([
      { id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } },
      { id: "go", scope: "Anywhere", label: "Runs", keys: "g r", run: () => { ran++; } },
    ]);
    const editable = el("div", { contenteditable: "true" });
    for (const field of [el("input"), el("textarea"), el("select"), editable, el("div", { role: "textbox" })]) {
      expect(press("c", {}, field).defaultPrevented).toBe(false);
      press("g", {}, field); press("r", {}, field);
    }
    expect(ran).toBe(0);
  });

  test("…but a checkbox takes no text, so a single key still works from it", () => {
    let ran = 0;
    registerShortcuts([{ id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } }]);
    press("c", {}, el("input", { type: "checkbox" }));
    expect(ran).toBe(1);
  });

  test("a ⌘/Ctrl chord DOES work while typing — the palette opens from the composer", () => {
    let ran = 0;
    registerShortcuts([{ id: "palette", scope: "Anywhere", label: "Palette", keys: "mod+k", run: () => { ran++; } }]);
    press("k", MOD, el("textarea"));
    expect(ran).toBe(1);
    press("k"); // and bare K is not the palette
    expect(ran).toBe(1);
  });

  test("a held modifier makes it a different key: Ctrl+C / Alt+C are not C", () => {
    let ran = 0;
    registerShortcuts([{ id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } }]);
    press("c", { ctrlKey: true }); press("c", { metaKey: true }); press("c", { altKey: true }); press("C", { shiftKey: true });
    expect(ran).toBe(0);
  });

  test("IME composition and key repeat are not presses", () => {
    let ran = 0;
    registerShortcuts([{ id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } }]);
    press("c", { isComposing: true });
    press("c", { repeat: true });
    expect(ran).toBe(0);
  });

  test("a handler that already took the key wins (defaultPrevented)", () => {
    let ran = 0;
    registerShortcuts([{ id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } }]);
    const own = el("div");
    own.addEventListener("keydown", (e) => e.preventDefault());
    press("c", {}, own);
    expect(ran).toBe(0);
  });

  test("a modal owns the keyboard: nothing fires on the page behind an open dialog", () => {
    let ran = 0;
    registerShortcuts([
      { id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => { ran++; } },
      { id: "palette", scope: "Anywhere", label: "Palette", keys: "mod+k", run: () => { ran++; } },
    ]);
    const dialog = el("dialog", { open: "" });
    const cancel = document.createElement("button");
    dialog.appendChild(cancel);
    press("c", {}, cancel);
    press("k", MOD, cancel);
    expect(ran).toBe(0);
  });
});

describe("the setting: single-key shortcuts can be turned off (WCAG 2.1.4)", () => {
  test("off: bare keys and sequences stop, chords keep working, and it is remembered", () => {
    const ran: string[] = [];
    registerShortcuts([
      { id: "c", scope: "Anywhere", label: "New run", keys: "c", run: () => ran.push("c") },
      { id: "go", scope: "Anywhere", label: "Runs", keys: "g r", run: () => ran.push("g r") },
      { id: "palette", scope: "Anywhere", label: "Palette", keys: "mod+k", run: () => ran.push("mod+k") },
    ]);
    expect(singleKeysEnabled()).toBe(true); // on until the operator says otherwise
    setSingleKeysEnabled(false);
    press("c"); press("g"); press("r"); press("k", MOD);
    expect(ran).toEqual(["mod+k"]);
    expect(localStorage.getItem("howdah.shortcuts.single-keys")).toBe("0");

    setSingleKeysEnabled(true);
    press("c");
    expect(ran).toEqual(["mod+k", "c"]);
  });

  test("the stored choice is read back on a fresh load", () => {
    localStorage.setItem("howdah.shortcuts.single-keys", "0");
    resetShortcutsForTest(); // forgets the cached value, as a reload would
    expect(singleKeysEnabled()).toBe(false);
  });
});

describe("Escape closes the topmost layer", () => {
  test("a detail panel closes before the drawer, whichever opened first", () => {
    const closed: string[] = [];
    const offPanel = pushEscapeLayer({ kind: "panel", onEscape: () => { closed.push("panel"); offPanel(); } });
    const offDrawer = pushEscapeLayer({ kind: "drawer", onEscape: () => { closed.push("drawer"); offDrawer(); } });
    press("Escape");
    press("Escape");
    press("Escape"); // nothing left: a no-op, not a throw
    expect(closed).toEqual(["panel", "drawer"]);
  });

  test("the layer that HOLDS FOCUS wins, even over a higher rank", () => {
    const closed: string[] = [];
    const drawer = el("aside");
    const inside = document.createElement("button");
    drawer.appendChild(inside);
    pushEscapeLayer({ kind: "panel", onEscape: () => closed.push("panel") });
    pushEscapeLayer({ kind: "drawer", onEscape: () => closed.push("drawer"), element: () => drawer });
    inside.focus();
    press("Escape", {}, inside);
    expect(closed).toEqual(["drawer"]);
  });

  test("nothing of ours closes while a menu, popover, tooltip or dialog is open — that Escape is theirs", () => {
    let closed = 0;
    pushEscapeLayer({ kind: "drawer", onEscape: () => { closed++; } });
    for (const layer of [el("div", { "data-layer": "menu" }), el("div", { role: "tooltip" }), el("dialog", { open: "" })]) {
      press("Escape");
      expect(closed).toBe(0);
      layer.remove();
    }
    press("Escape"); // all gone: now it is the drawer's
    expect(closed).toBe(1);
  });

  test("Escape mid-composition cancels the IME, not the drawer", () => {
    let closed = 0;
    pushEscapeLayer({ kind: "drawer", onEscape: () => { closed++; } });
    press("Escape", { isComposing: true });
    expect(closed).toBe(0);
  });
});
