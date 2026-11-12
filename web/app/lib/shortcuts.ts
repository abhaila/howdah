/**
 * The ONE registry of keyboard shortcuts (HOW-68, DESIGN.md "Keyboard").
 *
 * The viewer had no keyboard layer at all: every action was a pointer target, and the only
 * keys that did anything were the platform's. DESIGN.md's fourth rule is "keyboard first —
 * every action has a key, printed beside it; `?` lists them all", and the second half is the
 * one that decides this file's shape: a shortcut that is handled in a component's own
 * `onKeyDown` cannot be listed, so it WILL drift from the sheet that claims to list it. Here a
 * shortcut exists only as a row in this registry, and the three things that show shortcuts —
 * the `?` sheet, the ⌘K palette and the `Kbd` beside a control — all read the same rows. A
 * shortcut cannot exist without being listed, by construction.
 *
 * What a screen does:
 *
 *   useShortcuts([
 *     { id: "run.reply", scope: "A run", label: "Reply", keys: "r", run: focusComposer },
 *     { id: "run.details", scope: "A run", label: "Toggle details", keys: "mod+i", run: drawer.toggle },
 *   ]);
 *
 * Registered while the component is mounted, gone when it unmounts. A later registration
 * beats an earlier one for the same keys, so a screen's `r` wins over a global `r` while that
 * screen is up. A row with no `keys` is a palette-only command; a row with `passive: true` is
 * LISTED but handled elsewhere (Esc, a list's arrows) — the sheet is still complete.
 *
 * Key grammar: strokes separated by spaces are a SEQUENCE (`"g r"`: G, then R within
 * `SEQUENCE_MS`); a stroke is modifiers joined to a key with `+` (`"mod+k"`). `mod` is ⌘ on
 * macOS and Ctrl elsewhere. Keys are matched on `event.key`, lower-cased — so `?` is `?`, not
 * `shift+/`, and it works on a layout where `?` lives somewhere else.
 *
 * The refusals matter more than the happy path (WCAG 2.1.4, and plain manners):
 *
 *   A SINGLE-KEY shortcut — any stroke without ⌘/Ctrl/Alt — is ignored while a text field,
 *   textarea, select or contenteditable has focus, while a modifier is held, during IME
 *   composition, and on key repeat. Typing "c" into the composer must never open New run.
 *   Single keys can be turned off entirely (`setSingleKeysEnabled`), persisted like every
 *   other operator preference; ⌘K and the palette still work, so nothing becomes unreachable.
 *
 *   A MODAL owns the keyboard. While a native `<dialog>` is open nothing here fires: "c"
 *   pressed on a confirm dialog's Cancel button must not navigate the page behind it. (The
 *   palette closes itself on ⌘K — it is the modal.)
 *
 *   A component's own handler goes first. The listener is on `window` in the bubble phase and
 *   honours `defaultPrevented`, so Base UI's tabs keep their arrows and a menu its typeahead.
 *
 * ESC CLOSES THE TOPMOST LAYER, and there are two kinds of layer. Tooltip, Menu and Popover
 * (Base UI) and Dialog (the platform's `<dialog>`) already close themselves on Escape. Detail
 * panels and the Drawer are ours, so they register here (`useEscapeLayer`) and this file
 * decides which one an Escape belongs to: none of them while anything more specific is open
 * — judged in the CAPTURE phase, before a popup has had the chance to close itself and leave
 * the DOM saying "nothing was open" — otherwise the layer that holds focus, otherwise the
 * highest-ranked (a detail panel before the drawer), otherwise the most recent.
 *
 * Node-free apart from `window`/`document`, which every function reaches lazily, so the pure
 * half (`parseKeys`, `formatKeys`, `strokeOf`) is importable anywhere.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { readStored, writeStored } from "./panel";

export interface Shortcut {
  /** stable identity; a later registration with the same id replaces the earlier row */
  id: string;
  /** the heading it is listed under in the `?` sheet and the palette: "Anywhere", "A run" */
  scope: string;
  /** what it does, in the operator's words: "Go to Runs" */
  label: string;
  /** `"mod+k"`, `"?"`, `"g r"`; several spellings as an array. Absent = palette-only command */
  keys?: string | readonly string[];
  /** absent only on a `passive` row */
  run?: () => void;
  /** false keeps it out of the ⌘K palette (it is still in the `?` sheet). Default true */
  palette?: boolean;
  /** extra words the palette filter matches: "dark light appearance" */
  keywords?: string;
  /** listed, but handled by something else (the platform, a primitive, `useEscapeLayer`) */
  passive?: boolean;
  /** registered but inert right now; still listed */
  disabled?: boolean;
}

/** how long a sequence's first key waits for its second */
export const SEQUENCE_MS = 1200;
const SINGLE_KEYS_KEY = "howdah.shortcuts.single-keys";

// ---- the pure half: grammar, matching, printing ---------------------------------------

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform ?? "") || /Mac OS X/i.test(navigator.userAgent ?? "");
}

const MODS = ["mod", "ctrl", "meta", "alt", "shift"] as const;
const ALIASES: Record<string, string> = {
  esc: "escape", return: "enter", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright",
  space: " ", cmd: "mod", command: "mod", option: "alt",
};

/** one stroke in canonical form: modifiers in a fixed order, then the key, all lower-case */
function canonical(mods: ReadonlySet<string>, key: string): string {
  return [...MODS.filter((m) => mods.has(m)), key].join("+");
}

/** `"g r"` → `["g", "r"]`; `"Mod+K"` → `["mod+k"]` */
export function parseKeys(keys: string): string[] {
  return keys.trim().split(/\s+/).filter(Boolean).map((stroke) => {
    // a bare "+" is the plus key, not an empty modifier list
    const parts = stroke === "+" ? ["+"] : stroke.toLowerCase().split("+").map((p) => ALIASES[p] ?? p);
    const key = parts[parts.length - 1] ?? "";
    return canonical(new Set(parts.slice(0, -1)), key);
  });
}

/** the stroke a keydown IS, or null for a bare modifier press */
export function strokeOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac = isMac()): string | null {
  if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Dead" || e.key === "Unidentified") return null;
  const key = e.key.toLowerCase();
  const mods = new Set<string>();
  if (mac ? e.metaKey : e.ctrlKey) mods.add("mod");
  if (mac ? e.ctrlKey : e.metaKey) mods.add(mac ? "ctrl" : "meta");
  if (e.altKey) mods.add("alt");
  // Shift is part of a LETTER's or a named key's identity (Shift+G, Shift+Enter) but not a
  // symbol's: "?" already is the shifted key, and which key that is depends on the layout
  if (e.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) mods.add("shift");
  return canonical(mods, key);
}

/** a stroke with no ⌘/Ctrl/Alt — the kind WCAG 2.1.4 is about */
export function isSingleKey(stroke: string): boolean {
  return !/(^|\+)(mod|ctrl|meta|alt)\+/.test(stroke);
}

const KEY_LABEL: Record<string, string> = {
  enter: "↵", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
  " ": "Space", backspace: "⌫", tab: "Tab", delete: "Del",
};

/**
 * How a shortcut is PRINTED: one string per stroke, so `Kbd` draws one key cap per press.
 * `"mod+k"` → `["⌘K"]` (`["Ctrl K"]` off macOS); `"g r"` → `["G", "R"]`.
 */
export function formatKeys(keys: string, mac = isMac()): string[] {
  return parseKeys(keys).map((stroke) => {
    const parts = stroke === "+" ? ["+"] : stroke.split("+");
    const key = parts[parts.length - 1] ?? "";
    const mods = parts.slice(0, -1).map((m) =>
      m === "mod" ? (mac ? "⌘" : "Ctrl") : m === "shift" ? (mac ? "⇧" : "Shift") : m === "alt" ? (mac ? "⌥" : "Alt") : m === "ctrl" ? (mac ? "⌃" : "Ctrl") : "Meta");
    const label = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
    return [...mods, label].join(mac ? "" : " ");
  });
}

/** the first spelling of a shortcut's keys — what a `Kbd` beside its control prints */
export function primaryKeys(sc: Pick<Shortcut, "keys">): string | undefined {
  return typeof sc.keys === "string" ? sc.keys : sc.keys?.[0];
}

/** is this element somewhere text is being typed (so a single key is a character, not a command)? */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable) return true;
  const field = el.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='combobox'], [role='searchbox']");
  if (!field) return false;
  if (field.tagName === "INPUT") {
    const type = (field.getAttribute("type") ?? "text").toLowerCase();
    // these take no text: a single key on a checkbox is not a keystroke into a value
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(type);
  }
  return true;
}

// ---- the registry ----------------------------------------------------------------------

let registrations: Array<{ token: number; list: readonly Shortcut[] }> = [];
let snapshot: readonly Shortcut[] = [];
let nextToken = 1;
const listeners = new Set<() => void>();

function publish(): void {
  // later registrations win an id, but keep the place of the first so the sheet does not
  // reshuffle when a screen overrides a global row
  const byId = new Map<string, Shortcut>();
  for (const r of registrations) for (const sc of r.list) byId.set(sc.id, sc);
  snapshot = [...byId.values()];
  for (const l of listeners) l();
}

/** Register rows until the returned function is called. `useShortcuts` is this, as a hook. */
export function registerShortcuts(list: readonly Shortcut[]): () => void {
  const token = nextToken++;
  registrations = [...registrations, { token, list }];
  publish();
  return () => {
    registrations = registrations.filter((r) => r.token !== token);
    publish();
  };
}

/** every row registered right now, in registration order */
export function allShortcuts(): readonly Shortcut[] {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** the live registry, for the `?` sheet and the palette */
export function useRegisteredShortcuts(): readonly Shortcut[] {
  return useSyncExternalStore(subscribe, allShortcuts, allShortcuts);
}

/**
 * Register a screen's shortcuts while it is mounted. Pass the list inline: `run` is read at
 * press time through a ref, so a fresh closure every render re-registers nothing — the
 * registry only changes when a row's listing (id, scope, label, keys, flags) does.
 */
export function useShortcuts(list: readonly Shortcut[]): void {
  const latest = useRef(list);
  latest.current = list;
  const listing = JSON.stringify(list.map((s) => [s.id, s.scope, s.label, s.keys ?? null, s.palette ?? true, s.passive ?? false, s.disabled ?? false, s.keywords ?? "", s.run !== undefined]));
  useEffect(() => {
    const stable = latest.current.map((s): Shortcut => ({
      ...s,
      run: s.run === undefined ? undefined : () => latest.current.find((x) => x.id === s.id)?.run?.(),
    }));
    return registerShortcuts(stable);
  }, [listing]);
}

/** rows grouped by scope, in first-seen order — the shape the sheet and the palette render */
export function groupByScope(list: readonly Shortcut[]): Array<{ scope: string; items: Shortcut[] }> {
  const groups: Array<{ scope: string; items: Shortcut[] }> = [];
  for (const sc of list) {
    const g = groups.find((x) => x.scope === sc.scope);
    if (g) g.items.push(sc);
    else groups.push({ scope: sc.scope, items: [sc] });
  }
  return groups;
}

// ---- the setting: single-key shortcuts can be turned off (WCAG 2.1.4) -----------------

let singleKeys: boolean | null = null;

export function singleKeysEnabled(): boolean {
  if (singleKeys === null) singleKeys = readStored(SINGLE_KEYS_KEY, true, (raw) => (raw === "1" ? true : raw === "0" ? false : null));
  return singleKeys;
}

/** The function Settings calls. Persisted; takes effect on the next keypress. */
export function setSingleKeysEnabled(on: boolean): void {
  singleKeys = on;
  writeStored(SINGLE_KEYS_KEY, on ? "1" : "0");
  for (const l of listeners) l();
}

export function useSingleKeys(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, singleKeysEnabled, singleKeysEnabled), setSingleKeysEnabled];
}

// ---- Escape layers ---------------------------------------------------------------------

export type EscapeLayerKind = "panel" | "drawer";
const RANK: Record<EscapeLayerKind, number> = { panel: 2, drawer: 1 };

interface EscapeLayer {
  token: number;
  kind: EscapeLayerKind;
  onEscape: () => void;
  /** the layer's element, so "focus is inside it" can be asked */
  element?: () => Element | null;
}
let escapeLayers: EscapeLayer[] = [];

/** Layers that close THEMSELVES on Escape: the platform's dialog, and Base UI's popups. */
const SELF_CLOSING = "dialog[open], [data-layer], [role='tooltip']";

export function pushEscapeLayer(layer: Omit<EscapeLayer, "token">): () => void {
  const token = nextToken++;
  escapeLayers = [...escapeLayers, { ...layer, token }];
  return () => { escapeLayers = escapeLayers.filter((l) => l.token !== token); };
}

/**
 * Make Escape close this layer while `active`. `kind` is its rank — a detail panel closes
 * before the drawer — and `ref`, when given, lets a layer that HOLDS FOCUS win regardless.
 */
export function useEscapeLayer(onEscape: () => void, opts: { active?: boolean; kind?: EscapeLayerKind; ref?: React.RefObject<Element | null> } = {}): void {
  const { active = true, kind = "panel", ref } = opts;
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer({ kind, onEscape: () => latest.current(), element: ref ? () => ref.current : undefined });
  }, [active, kind, ref]);
}

function topEscapeLayer(): EscapeLayer | null {
  if (escapeLayers.length === 0) return null;
  const focused = typeof document === "undefined" ? null : document.activeElement;
  const holding = focused && focused !== document.body
    ? [...escapeLayers].reverse().find((l) => l.element?.()?.contains(focused))
    : undefined;
  if (holding) return holding;
  return [...escapeLayers].reverse().sort((a, b) => RANK[b.kind] - RANK[a.kind])[0] ?? null;
}

// ---- the one listener ------------------------------------------------------------------

let pending: string[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let specificLayerOpen = false;
let installed = 0;

function clearPending(): void {
  pending = [];
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimer = undefined;
}

function match(strokes: readonly string[]): { exact: Shortcut | null; prefix: boolean } {
  let exact: Shortcut | null = null;
  let prefix = false;
  // newest first: a screen's binding beats the shell's for the same keys
  for (let i = snapshot.length - 1; i >= 0; i--) {
    const sc = snapshot[i];
    if (!sc || sc.passive || sc.disabled || !sc.run || sc.keys === undefined) continue;
    for (const spelling of typeof sc.keys === "string" ? [sc.keys] : sc.keys) {
      const seq = parseKeys(spelling);
      if (seq.length < strokes.length || !strokes.every((s, j) => seq[j] === s)) continue;
      if (seq.length === strokes.length) exact ??= sc;
      else prefix = true;
    }
  }
  return { exact, prefix };
}

function onKeyDownCapture(e: KeyboardEvent): void {
  // judged BEFORE anything reacts: by the bubble phase a menu has closed itself and the DOM
  // would say nothing more specific was open
  if (e.key === "Escape") specificLayerOpen = document.querySelector(SELF_CLOSING) !== null;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  // mid-composition keys belong to the IME (229 is what browsers report when isComposing lies)
  if (e.isComposing || e.keyCode === 229) return;

  if (e.key === "Escape") {
    clearPending();
    if (specificLayerOpen) return;
    topEscapeLayer()?.onEscape();
    return;
  }
  // a modal owns the keyboard: nothing behind it may fire
  if (document.querySelector("dialog[open]") !== null) return;

  const stroke = strokeOf(e);
  if (stroke === null) return;
  if (isSingleKey(stroke)) {
    const el = e.target as HTMLElement | null;
    const typing = isTextEntry(el) || (typeof el?.closest === "function" && el.closest("[role='menu'], [role='listbox']") !== null);
    if (!singleKeysEnabled() || typing || e.repeat) { clearPending(); return; }
  }

  let attempt = [...pending, stroke];
  let found = match(attempt);
  if (!found.exact && !found.prefix && pending.length > 0) {
    // the sequence broke; the key still gets its own chance ("g" then "c" is New run)
    attempt = [stroke];
    found = match(attempt);
  }
  clearPending();
  if (found.exact) {
    e.preventDefault();
    found.exact.run?.();
  } else if (found.prefix) {
    e.preventDefault();
    pending = attempt;
    pendingTimer = setTimeout(clearPending, SEQUENCE_MS);
  }
}

/**
 * Attach the listener. The shell calls this once; it is reference-counted so a test (or a
 * second root) can install and uninstall without taking the shell's away.
 */
export function installShortcuts(): () => void {
  if (installed++ === 0) {
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("keydown", onKeyDown);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--installed === 0) {
      window.removeEventListener("keydown", onKeyDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      clearPending();
    }
  };
}

/** test seam: forget everything, including the cached setting */
export function resetShortcutsForTest(): void {
  registrations = [];
  escapeLayers = [];
  singleKeys = null;
  specificLayerOpen = false;
  clearPending();
  publish();
}
