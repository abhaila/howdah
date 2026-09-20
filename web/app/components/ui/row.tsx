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
 */
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const STATES =
  "w-full text-left transition-[background] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:-outline-offset-2";
const CLICKABLE = "cursor-pointer hover:bg-card";
const SELECTED = "bg-card shadow-[inset_2px_0_0_var(--border-strong)]";
/** the one row state allowed the alarm colour — an agent is waiting on a human (R3.3) */
const NEEDS_INPUT = "bg-[var(--attention-bg)] shadow-[inset_3px_0_0_var(--attention)]";

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
}

export const Row = forwardRef<HTMLElement, RowProps>(function Row(
  { className, selected, needsInput, children, href, onClick, as, ...rest },
  ref,
) {
  const cls = cn(
    STATES,
    (href || onClick) && CLICKABLE,
    selected && SELECTED,
    // needs-input outranks selected: a parked row must never read as merely highlighted
    needsInput && NEEDS_INPUT,
    className,
  );
  if (href !== undefined) {
    return <a ref={ref as React.Ref<HTMLAnchorElement>} className={cls} href={href} {...rest}>{children}</a>;
  }
  if (onClick !== undefined && as !== "div") {
    return <button ref={ref as React.Ref<HTMLButtonElement>} type="button" className={cls} onClick={onClick} {...rest}>{children}</button>;
  }
  return <div ref={ref as React.Ref<HTMLDivElement>} className={cls} {...rest}>{children}</div>;
});
