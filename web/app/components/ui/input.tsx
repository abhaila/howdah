/**
 * Input — shadcn/ui `input` on Howdah's tokens (HOW-16 P1.3). It absorbs the three
 * hand-written text fields that re-implemented it: `.logs-search`, `.chat-input input` and
 * `.add-workspace-row input` / `.gh-picker > input`, all now deleted from howdah.css.
 * Mono by default: everything typed into this app is machine-shaped (ids, paths, models).
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-[var(--radius-sm)] border border-border bg-muted px-2.5 font-mono text-base text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
