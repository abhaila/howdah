/**
 * Keyboard navigation for a list of rows (HOW-68, DESIGN.md Keyboard: "Lists — J K or arrows
 * move · Enter open · / filter").
 *
 * Every list screen was pointer-first: Tab walked forty rows one at a time and nothing said
 * which one you were on. This is the one implementation the Runs list, the inbox, Graphs,
 * Prompts and Proposals share, so the keys cannot mean something different on each.
 *
 * SELECTION IS FOCUS. J/K move real keyboard focus to the next row and mark it selected
 * (`Row selected`: the raised ground and hairline outline). That is on purpose rather than a
 * painted cursor over an unfocused list: the row is a real link or button, so Enter opens it
 * through the platform with no handler of ours, a screen reader announces it, `Truncate` shows
 * a cut name while it is focused, and Tab continues from where J/K left off. Nothing animates
 * — selection is instant (DESIGN.md Motion).
 *
 * The keys are rows in the ONE registry (`useShortcuts`), so they are listed in `?`:
 *   J / K            move, anywhere on the screen (not while typing — the registry's rule).
 *   ↓ / ↑            the same. On a screen whose list is the only scroller they are global;
 *                    on a split screen (`arrows: "list"`) they act only while focus is in the
 *                    list, because the detail pane beside it scrolls with the same keys.
 *   Enter            opens the selected row. Passive in the registry: the focused row's own
 *                    activation does it. One fallback — Enter with focus on nothing (the
 *                    page, or the scroller) opens the row last selected.
 *   /                focuses the filter, when the screen has one.
 *
 * Rows are found in the DOM (`[data-nav-row]` inside the container, in document order), not
 * passed in as an array: the lists are grouped and filtered, and the order the operator SEES
 * is the only order J/K may follow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isTextEntry, useShortcuts, type Shortcut } from "./shortcuts";

export interface ListNav {
  /** put on the element that contains the rows */
  ref: React.RefObject<HTMLDivElement | null>;
  /** the selected row's key, or null before the first J/K */
  selected: string | null;
  /** spread on the container: keeps `selected` following focus, and the list-scoped arrows */
  containerProps: { onFocus: (e: React.FocusEvent) => void; onKeyDown: (e: React.KeyboardEvent) => void };
  /** move by `delta` rows (clamped); exported for the filter field's ArrowDown */
  move: (delta: number) => void;
}

const ROW = "[data-nav-row]";

export function useListNav(opts: {
  /** what the rows are, for the `?` sheet: "run", "prompt" */
  noun: string;
  /** `"global"` when the list is the screen's only scroller; `"list"` beside a detail pane */
  arrows?: "global" | "list";
  /** the filter field `/` focuses, when there is one */
  filterRef?: React.RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}): ListNav {
  const { noun, arrows = "global", filterRef, enabled = true } = opts;
  const ref = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const rows = useCallback(() => Array.from(ref.current?.querySelectorAll<HTMLElement>(ROW) ?? []), []);

  const move = useCallback((delta: number) => {
    const all = rows();
    if (all.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    // where we are: the focused row, else the row last selected, else just before the first
    let at = active ? all.indexOf(active.closest<HTMLElement>(ROW) ?? active) : -1;
    if (at === -1 && selectedRef.current !== null) at = all.findIndex((r) => r.dataset.navRow === selectedRef.current);
    const to = at === -1 ? (delta > 0 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, at + delta));
    const el = all[to];
    if (!el) return;
    setSelected(el.dataset.navRow ?? null);
    el.focus();
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [rows]);

  const list: Shortcut[] = [
    { id: "list.next", scope: "Lists", label: `Next ${noun}`, keys: arrows === "global" ? ["j", "arrowdown"] : "j", palette: false, disabled: !enabled, run: () => move(1) },
    { id: "list.prev", scope: "Lists", label: `Previous ${noun}`, keys: arrows === "global" ? ["k", "arrowup"] : "k", palette: false, disabled: !enabled, run: () => move(-1) },
    ...(arrows === "list" ? [{ id: "list.arrows", scope: "Lists", label: `Move through the ${noun}s while the list has focus`, keys: ["arrowdown", "arrowup"], palette: false, passive: true } satisfies Shortcut] : []),
    { id: "list.open", scope: "Lists", label: `Open the selected ${noun}`, keys: "enter", palette: false, passive: true },
    ...(filterRef ? [{ id: "list.filter", scope: "Lists", label: `Filter the ${noun}s`, keys: "/", disabled: !enabled, run: () => { filterRef.current?.focus(); filterRef.current?.select?.(); } } satisfies Shortcut] : []),
  ];
  useShortcuts(list);

  // Enter with focus on nothing in particular opens the row last selected. A focused row,
  // button or field handles its own Enter — this never competes with one.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (document.querySelector("dialog[open]") !== null) return;
      const t = e.target as HTMLElement | null;
      const idle = t === document.body || t === document.documentElement || t?.getAttribute?.("data-slot") === "scroll-pane";
      if (!idle || isTextEntry(t) || selectedRef.current === null) return;
      const el = rows().find((r) => r.dataset.navRow === selectedRef.current);
      if (el) { e.preventDefault(); el.click(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, rows]);

  // a selection whose row is gone (filtered out, answered) is no selection
  useEffect(() => {
    if (selected !== null && !rows().some((r) => r.dataset.navRow === selected)) setSelected(null);
  });

  const containerProps = {
    onFocus: (e: React.FocusEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(ROW);
      if (row?.dataset.navRow !== undefined) setSelected(row.dataset.navRow);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (arrows !== "list" || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) return;
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    },
  };
  return { ref, selected, containerProps, move };
}
