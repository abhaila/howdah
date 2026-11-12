/**
 * Row — the ONE row surface (HOW-16 P1.6 + P2.8).
 *
 * `.run-row`, `.step-row`, `.ctx-row` and `.log-row` each re-implemented the same three
 * states — hover, selected, needs-input — four times over, in four places, with three
 * different selected treatments and two different needs-input ones. Those three states now
 * live here; what stays in howdah.css is only what actually differs between them, which is
 * their COLUMN LAYOUT (a 230px node name is not a 168px context key). One component or one
 * CSS pattern, not both.
 *
 * It also closes the keyboard dead ends the old rows had. A row that does something is
 * rendered as a real `<button>` (or `<a>` when it navigates), so Tab reaches it, Enter and
 * Space fire it, and the focus ring is the platform's — the graph list row, the graph
 * tuning table row and the log rows all used to be `<div onClick>`.
 *
 * HOW-68 (DESIGN.md Chrome + rule 1, "the alarm is said once"):
 *
 *   SELECTED is `--bg-raised` with a 1px `--border-strong` outline all the way round, and the
 *   6px row radius. It was an inset 2px rule down the left edge — a side stripe, which
 *   DESIGN.md bans outright ("no border-left wider than 1px anywhere").
 *   NEEDS-INPUT HAS NO STYLING AT ALL. It was an amber tint plus a 3px amber stripe, on every
 *   waiting row, beside the amber status glyph and the amber nav count: the alarm said three
 *   times. A waiting row is marked by its status glyph and by nothing else. The prop stays,
 *   and sets `data-needs-input`, because the fact is still true of the row and a consumer
 *   (or a test) may need to find it — it just no longer paints.
 *
 * Hover is a colour change only and it is NOT animated: list rows are swept dozens of times a
 * day, and a highlight that fades trails one row behind the pointer (DESIGN.md Motion).
 */
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const STATES =
  "w-full text-left focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:-outline-offset-2";
/** hover lifts the row to the card ground; a press goes one step further, so the click is felt (it moves nothing) */
const CLICKABLE = "cursor-pointer hover:bg-card active:bg-accent";
/** an outline all the way round, drawn inside the box so the row's height does not change */
const SELECTED = "rounded-[var(--radius-sm)] bg-card shadow-[inset_0_0_0_1px_var(--border-strong)]";

export interface RowProps {
  className?: string;
  selected?: boolean;
  needsInput?: boolean;
  children: React.ReactNode;
  /** a navigation row: rendered as a real link, so middle-click and copy-link still work */
  href?: string;
  onClick?: () => void;
  /** a header or a static row: no affordance, no focus stop */
  as?: "div";
  role?: string;
  "aria-label"?: string;
  /** a disclosure row: says whether the thing it opens is open (activity's tool beats) */
  "aria-expanded"?: boolean;
  "data-testid"?: string;
  /** HOW-68: this row's key in a keyboard-navigated list (lib/list-nav.ts moves J/K through them) */
  "data-nav-row"?: string;
  /** a link row that IS the current place: the open prompt in the prompts list */
  "aria-current"?: "page" | "true";
}

export const Row = forwardRef<HTMLElement, RowProps>(function Row(
  { className, selected, needsInput, children, href, onClick, as, ...rest },
  ref,
) {
  const cls = cn(
    STATES,
    (href || onClick) && CLICKABLE,
    selected && SELECTED,
    className,
  );
  // the fact, without the paint: a waiting row is marked by its amber status glyph only
  const marks = { "data-selected": selected || undefined, "data-needs-input": needsInput || undefined };
  if (href !== undefined) {
    return <a ref={ref as React.Ref<HTMLAnchorElement>} className={cls} href={href} {...marks} {...rest}>{children}</a>;
  }
  if (onClick !== undefined && as !== "div") {
    return <button ref={ref as React.Ref<HTMLButtonElement>} type="button" className={cls} onClick={onClick} {...marks} {...rest}>{children}</button>;
  }
  return <div ref={ref as React.Ref<HTMLDivElement>} className={cls} {...marks} {...rest}>{children}</div>;
});
