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
 * `useDrawer(key)` is the remembered open/closed state, stored with the same wrapped
 * localStorage access as every pane preference (`lib/panel.ts`): a preference that cannot be
 * stored is not an error. Until the operator has chosen, it is open at 1280px and wider and
 * closed below.
 */
import { useCallback, useRef, useState } from "react";
import { X } from "lucide-react";
import { readStored, writeStored } from "@/lib/panel";
import { useEscapeLayer } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { ScrollPane } from "./scroll-pane";
import { Tooltip } from "./tooltip";

/** DESIGN.md Layout: the drawer starts closed below this width */
export const DRAWER_OPEN_FROM = 1280;

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

export function Drawer({ open, onClose, label, title, actions, children, width = 320, returnFocus, className }: {
  open: boolean;
  onClose: () => void;
  /** the landmark's name: "Run details" */
  label: string;
  /** the visible heading; defaults to `label` */
  title?: React.ReactNode;
  /** controls for the header row, left of the close button */
  actions?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
  /** where focus goes when the drawer closes with focus inside it — the control that opens it */
  returnFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    const held = ref.current?.contains(document.activeElement) ?? false;
    onClose();
    if (held) returnFocus?.current?.focus();
  }, [onClose, returnFocus]);
  useEscapeLayer(close, { active: open, kind: "drawer", ref });

  if (!open) return null;
  return (
    <aside
      ref={ref}
      data-slot="drawer"
      aria-label={label}
      className={cn("flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background", className)}
      style={{ width }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h2 className="m-0 min-w-0 flex-1 text-base font-semibold">{title ?? label}</h2>
        {actions}
        <Tooltip content={<span className="inline-flex items-center gap-2">Close <Kbd keys="escape" /></span>} side="bottom" align="end">
          <Button variant="ghost" size="icon-sm" aria-label={`Close ${label}`} onClick={close}><X /></Button>
        </Tooltip>
      </header>
      <ScrollPane label={label} className="p-4">{children}</ScrollPane>
    </aside>
  );
}
