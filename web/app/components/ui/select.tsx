/**
 * Select — a STYLED NATIVE `<select>`, not the shadcn registry's component.
 *
 * Provenance and the reason it differs: the registry's `select` is built on
 * @radix-ui/react-select, and this project's hard constraint is no Radix dependency
 * (CLAUDE.md, HOW-16 P1.3). A native select is keyboard-correct, screen-reader-correct and
 * touch-correct for free, on every platform, with no listbox to reimplement — so the only
 * thing worth borrowing is the appearance. That is what this is: the registry's trigger
 * styling over a real `<select>`, with the chevron drawn beside it.
 *
 * HOW-27 MOVED THE PRIMITIVE LAYER ONTO base-vega AND DELIBERATELY LEFT THIS BEHIND. The
 * original reason — "no Radix" — no longer applies, since `@base-ui/react` is a dependency now
 * and base-vega's select is built on it rather than on Radix. What keeps this a native
 * `<select>` is the OTHER half of the sentence above, which never depended on which library was
 * banned: a native select is keyboard-correct, screen-reader-correct and touch-correct for
 * free, on every platform. base-vega's replacement is 198 lines reimplementing a listbox —
 * typeahead, roving focus, mobile behaviour — to buy styled option rows, which nothing in this
 * app asks for. Swapping a correct 28-line control for a 198-line one to gain nothing is the
 * over-engineering the component sweep exists to remove. If styled options are ever wanted the
 * swap is one file, and every call site stays as it is.
 */
import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <span className={cn("relative block w-full", className)}>
    <select
      ref={ref}
      className="h-8 w-full appearance-none rounded-[var(--radius-sm)] border border-border bg-muted pl-2.5 pr-8 font-mono text-base text-foreground focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1"
      {...props}
    >
      {children}
    </select>
    <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
  </span>
));
Select.displayName = "Select";
