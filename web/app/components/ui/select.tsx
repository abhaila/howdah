/**
 * Select — a STYLED NATIVE `<select>`, not the shadcn registry's component.
 *
 * Provenance and the reason it differs: the registry's `select` is built on
 * @radix-ui/react-select, and this project's hard constraint is no Radix dependency
 * (CLAUDE.md, HOW-16 P1.3). A native select is keyboard-correct, screen-reader-correct and
 * touch-correct for free, on every platform, with no listbox to reimplement — so the only
 * thing worth borrowing is the appearance. That is what this is: the registry's trigger
 * styling over a real `<select>`, with the chevron drawn beside it.
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
