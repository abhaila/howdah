/**
 * Panel geometry: the one place a pane's width and its open/closed state are decided.
 *
 * Five surfaces needed the same two affordances — the nav sidebar, the run detail rail, the
 * Steps detail panel, and the Logs and Context splits. Only the Steps panel had them, and it
 * had them as ~70 lines living inside `run/steps.tsx`: pointer capture, a clamp measured
 * against the live container, a localStorage write wrapped so a private window cannot break
 * rendering, and a keyboard separator. Copying that four times is four places to fix the next
 * clamp bug, so it moves here and every pane reads from the same implementation.
 *
 * Two rules the geometry has to keep, both learned from the Steps panel:
 *
 *   The clamp is measured against the LIVE container, never a remembered number. The same
 *   drag at 1440px and at 1024px must both leave the other half readable, and a width
 *   remembered from a wide window must not strand a narrow one.
 *
 *   A preference that cannot be stored is not an error. Width and collapsed-ness are operator
 *   preferences: losing one is harmless, they never need to reach another viewer, and they are
 *   emphatically not facts about a run (the log is the only storage). Every access is wrapped
 *   — a private window or blocked site data throws on read AND on write — because a viewer
 *   that cannot remember a width must still render one.
 */
import { useCallback, useRef, useState } from "react";

/** Read a stored preference, falling back whenever storage is unavailable or the value is junk. */
export function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback; // unreadable storage is not a rendering failure
  }
}

/** Write a stored preference, silently. See the header: unremembered is fine, unrendered is not. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* unremembered is fine; unrendered is not */
  }
}

export interface PanelOpts {
  /** localStorage key prefix; `${key}.width` and `${key}.collapsed` are what get written */
  key: string;
  /** the panel stops shrinking here — below it the panel's own content stops being readable */
  min: number;
  /** width before the operator has ever dragged */
  def: number;
  /** what the OTHER half needs; the drag stops rather than starving it */
  minOther: number;
  /** which edge the panel is pinned to — decides which way a drag grows it */
  side?: "left" | "right";
  /** collapsed before the operator has ever toggled */
  defaultCollapsed?: boolean;
}

export interface Panel {
  width: number;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
  /** put on the element the width is measured inside */
  boxRef: React.RefObject<HTMLDivElement | null>;
  /** live drag; commits (and persists) on release */
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  /** arrows nudge, shift-arrows jump, Home/End slam it to either stop */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** double-click the separator to go back to the default width */
  onDoubleClick: () => void;
  min: number;
}

/**
 * A pane's remembered width and open/closed state, plus the handlers a separator needs.
 *
 * `boxRef` goes on the container the width is measured INSIDE, because the clamp needs the
 * live total. The returned width is already clamped on every change, so a consumer can render
 * it straight into a custom property without re-checking it.
 */
export function usePanel(opts: PanelOpts): Panel {
  const { key, min, def, minOther, side = "right", defaultCollapsed = false } = opts;
  const widthKey = `${key}.width`;
  const collapsedKey = `${key}.collapsed`;

  const [width, setWidth] = useState(() =>
    readStored(widthKey, def, (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) && n >= min ? n : null;
    }),
  );
  const [collapsed, setCollapsedState] = useState(() =>
    readStored(collapsedKey, defaultCollapsed, (raw) => (raw === "1" ? true : raw === "0" ? false : null)),
  );
  const boxRef = useRef<HTMLDivElement | null>(null);

  const clamp = useCallback(
    (w: number) => {
      const total = boxRef.current?.clientWidth ?? 0;
      const max = total > 0 ? Math.max(min, total - minOther) : Number.POSITIVE_INFINITY;
      return Math.round(Math.max(min, Math.min(w, max)));
    },
    [min, minOther],
  );

  const commit = useCallback(
    (w: number) => {
      const next = clamp(w);
      setWidth(next);
      writeStored(widthKey, String(next));
    },
    [clamp, widthKey],
  );

  const setCollapsed = useCallback(
    (v: boolean) => {
      setCollapsedState(v);
      writeStored(collapsedKey, v ? "1" : "0");
    },
    [collapsedKey],
  );

  // measured from the container edge the panel is pinned to, so the number IS the panel's width
  const widthAt = useCallback(
    (clientX: number) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return width;
      return side === "right" ? box.right - clientX : clientX - box.left;
    },
    [side, width],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (collapsed || e.button !== 0) return;
      e.preventDefault(); // or the drag selects the neighbouring list's text instead
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => setWidth(clamp(widthAt(ev.clientX)));
      const up = (ev: PointerEvent) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up); // a cancelled drag still commits what it drew
        commit(widthAt(ev.clientX));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    },
    [clamp, collapsed, commit, widthAt],
  );

  // a separator only a mouse can move is not a usable separator
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 96 : 24;
      const grow = side === "right" ? "ArrowLeft" : "ArrowRight";
      const shrink = side === "right" ? "ArrowRight" : "ArrowLeft";
      const by = e.key === grow ? step : e.key === shrink ? -step : 0;
      if (by !== 0) {
        e.preventDefault();
        commit(width + by);
      } else if (e.key === "Home") {
        e.preventDefault();
        commit(Number.POSITIVE_INFINITY);
      } else if (e.key === "End") {
        e.preventDefault();
        commit(min);
      }
    },
    [commit, min, side, width],
  );

  return {
    width,
    collapsed,
    onDoubleClick: useCallback(() => commit(def), [commit, def]),
    setCollapsed,
    toggle: useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]),
    boxRef,
    onPointerDown,
    onKeyDown,
    min,
  };
}
