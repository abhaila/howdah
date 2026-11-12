/**
 * Drawer — a right-side, NON-MODAL panel (HOW-68, DESIGN.md: "Details is a drawer on the
 * right (320px): closed by default below 1280px, toggled with ⌘I, closed with Esc,
 * remembered").
 *
 * The run's inspector was a permanent 344px column. At 1024px wide that left the transcript
 * 479px and clipped it sideways; the audit's two worst findings (the ask that could not be
 * reached, the tab strip cut at "L…") are both that column refusing to get out of the way.
 * A drawer is the same content with a door on it.
 *
 * It is deliberately NOT a dialog, and not `@base-ui/react/drawer` either (which is a modal
 * sheet with a backdrop and swipe-to-dismiss — a phone pattern). DESIGN.md: "a detail view is
 * a panel or the drawer, not a modal". So: no scrim, no focus trap, no inert background, no
 * portal. It is an `<aside>` IN THE LAYOUT — a flex sibling of the content it describes — so
 * opening it narrows the content instead of covering it, and the operator can read the
 * transcript and the details at once, which is the entire reason to open it.
 *
 * It also does not animate. DESIGN.md Motion names it: "nothing keyboard-triggered animates
 * … the drawer on ⌘I". It is toggled dozens of times a day; it is there or it is not.
 *
 * Escape closes it through the one Escape layering (`lib/shortcuts.ts` `useEscapeLayer`,
 * kind `"drawer"`): when focus is inside it, or when nothing more specific — a tooltip, a
 * menu, a dialog, a detail panel — is open. If focus was inside when it closed, focus goes to
 * `returnFocus` (the button that opens it) rather than falling to `<body>`, where the next
 * Tab would start from the top of the page.
 *
 * IT CAN BE RESIZED (the operator's first hands-on feedback: "is there a way to dynamically
 * change width of details"). With `resizeKey`, its left edge is a `role="separator"`: drag it,
 * or focus it and use the arrows (Shift for bigger steps), Home for the widest and End for the
 * narrowest; a double-click or Enter goes back to the default. The geometry is NOT written
 * here — it is `usePanel` (`lib/panel.ts`), the one pointer-capture, clamp and remembered width
 * every split in the app already uses. Two things are the drawer's own: it is never narrower
 * than 280px or wider than half the room it shares (so the pane it describes is never the
 * smaller half), and a width remembered from a wide window is clamped again on a narrow one.
 * Only the drawer's width changes while it is dragged; nothing animates and nothing reflows
 * but the two panes. The handle's hit area is 24px wide, inside the drawer's own left padding — it
 * never lies over the neighbouring pane's scrollbar — and it shows the 2px ring when focused.
 *
 * `useDrawer(key)` is the remembered open/closed state, stored with the same wrapped
 * localStorage access as every pane preference (`lib/panel.ts`): a preference that cannot be
 * stored is not an error. Until the operator has chosen, it is open at 1280px and wider and
 * closed below.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { readStored, usePanel, writeStored } from "@/lib/panel";
import { useEscapeLayer } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { ScrollPane } from "./scroll-pane";
import { Tooltip } from "./tooltip";

/** DESIGN.md Layout: the drawer starts closed below this width */
export const DRAWER_OPEN_FROM = 1280;
/** a resizable drawer's stops: never narrower than this, never more than this share of the room */
export const DRAWER_MIN = 280;
export const DRAWER_MAX_SHARE = 0.5;

export interface DrawerState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  close: () => void;
}

/** A drawer's remembered open/closed state. `key` is a localStorage prefix: "howdah.run.details". */
export function useDrawer(key: string): DrawerState {
  const storeKey = `${key}.open`;
  const [open, setOpenState] = useState(() =>
    readStored(storeKey, typeof window !== "undefined" && window.innerWidth >= DRAWER_OPEN_FROM, (raw) => (raw === "1" ? true : raw === "0" ? false : null)),
  );
  const setOpen = useCallback((v: boolean) => {
    setOpenState(v);
    writeStored(storeKey, v ? "1" : "0");
  }, [storeKey]);
  return {
    open,
    setOpen,
    toggle: useCallback(() => setOpen(!open), [open, setOpen]),
    close: useCallback(() => setOpen(false), [setOpen]),
  };
}

export function Drawer({ open, onClose, label, title, actions, children, width = 320, returnFocus, className, resizeKey }: {
  open: boolean;
  onClose: () => void;
  /** the landmark's name: "Run details" */
  label: string;
  /** the visible heading; defaults to `label` */
  title?: React.ReactNode;
  /** controls for the header row, left of the close button */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** the width, or the DEFAULT width of a resizable drawer */
  width?: number;
  /** where focus goes when the drawer closes with focus inside it — the control that opens it */
  returnFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
  /** makes the drawer resizable, and is the localStorage prefix its width is remembered under */
  resizeKey?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    const held = ref.current?.contains(document.activeElement) ?? false;
    onClose();
    if (held) returnFocus?.current?.focus();
  }, [onClose, returnFocus]);
  useEscapeLayer(close, { active: open, kind: "drawer", ref });

  // the room the drawer shares with the content beside it: its parent's width, kept live
  const [room, setRoom] = useState(0);
  const widest = room > 0 ? Math.max(DRAWER_MIN, Math.round(room * DRAWER_MAX_SHARE)) : undefined;
  const panel = usePanel({
    key: resizeKey ?? "howdah.drawer", min: DRAWER_MIN, def: Math.max(DRAWER_MIN, width),
    // what the OTHER half keeps: whatever is left once the drawer is at its widest
    minOther: widest === undefined ? 0 : room - widest, side: "right", keepGrip: true,
  });
  const boxRef = panel.boxRef;
  useLayoutEffect(() => {
    const box = open && resizeKey ? ref.current?.parentElement ?? null : null;
    boxRef.current = box as HTMLDivElement | null;
    if (!box) return;
    const measure = () => setRoom(box.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [open, resizeKey, boxRef]);

  if (!open) return null;
  // clamped again at render: a width remembered at 2000px must not take a 1024px window
  const shown = resizeKey ? Math.min(panel.width, widest ?? panel.width) : width;
  return (
    <aside
      ref={ref}
      data-slot="drawer"
      aria-label={label}
      className={cn("relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background", className)}
      style={{ width: shown }}
    >
      {resizeKey && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}. Arrow keys resize, Home is widest, End is narrowest, Enter resets.`}
          aria-valuenow={shown}
          aria-valuemin={DRAWER_MIN}
          aria-valuemax={widest}
          tabIndex={0}
          data-slot="drawer-resize"
          // 24px to grab (the `before:` box), all of it inside the drawer's own padding; the
          // element itself is an 8px lane, so its focus ring is a slim bar on the edge rather
          // than a 24px frame over the content. Hover thickens the border: colour only.
          className="group/resize absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none before:absolute before:inset-y-0 before:left-0 before:w-6 focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:-outline-offset-2"
          onPointerDown={panel.onPointerDown}
          onDoubleClick={panel.onDoubleClick}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); panel.onDoubleClick(); }
            else panel.onKeyDown(e);
          }}
        >
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-transparent group-hover/resize:bg-[var(--border-strong)] group-focus-visible/resize:bg-[var(--ring)] group-active/resize:bg-[var(--ring)]" />
        </div>
      )}
      <header className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2", resizeKey ? "pl-6" : "pl-4")}>
        <h2 className="m-0 min-w-0 flex-1 text-base font-semibold">{title ?? label}</h2>
        {actions}
        <Tooltip content={<span className="inline-flex items-center gap-2">Close <Kbd keys="escape" /></span>} side="bottom" align="end">
          <Button variant="ghost" size="icon-sm" aria-label={`Close ${label}`} onClick={close}><X /></Button>
        </Tooltip>
      </header>
      <ScrollPane label={label} className={resizeKey ? "py-4 pl-6 pr-4" : "p-4"}>{children}</ScrollPane>
    </aside>
  );
}
