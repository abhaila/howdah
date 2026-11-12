/**
 * Toolbar — a single row of actions (HOW-68, DESIGN.md: "a header is one row at every
 * supported width").
 *
 * The run header's controls were a wrapping flex row: five buttons that took a second line at
 * 1440px. This is the row that does NOT wrap — it keeps its controls on one line and never
 * shrinks them, so the thing beside it (a title in a `Truncate`) is what gives way, and what
 * does not fit belongs behind a `Menu`. That is the entire layout contract, and it is why this
 * is a primitive rather than three utilities at each call site: the moment one header says
 * `flex-wrap`, the one-row rule is gone again.
 *
 * It is a real `role="toolbar"`, so it has to keep the toolbar's keyboard promise: Left/Right
 * move between its controls, Home/End jump to the ends. Tab still visits each control — the
 * ARIA pattern's single tab stop is deliberately NOT taken, because these rows hold three or
 * four buttons and sometimes a text field, and "Tab reaches every control" is the behaviour
 * the rest of the app has. Arrows are ignored while a text field inside the row has focus, so
 * the caret keeps them.
 *
 * Hand-written rather than `@base-ui/react/toolbar`: that primitive only manages controls
 * rendered as ITS `Toolbar.Button`, which would mean a second button component, or every
 * `Button`, `Menu` trigger and `Tooltip` in a header wrapped in an adapter.
 */
import { cn } from "@/lib/utils";
import { isTextEntry } from "@/lib/shortcuts";

/** by attribute, not `:disabled`: a control disabled for assistive tech only (`aria-disabled`) is skipped too */
const STOPS = ["button", "a[href]", "input", "select", "[tabindex]:not([tabindex='-1'])"]
  .map((s) => `${s}:not([disabled]):not([aria-disabled='true'])`).join(", ");

export function Toolbar({ label, children, className }: {
  /** what the row acts on, for assistive tech: "Run actions" */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || isTextEntry(e.target)) return;
    const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(STOPS));
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at === -1 || stops.length === 0) return;
    const to = e.key === "Home" ? 0 : e.key === "End" ? stops.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + stops.length) % stops.length;
    e.preventDefault();
    stops[to]?.focus();
  };
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      data-slot="toolbar"
      className={cn("flex shrink-0 flex-nowrap items-center gap-1.5", className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
