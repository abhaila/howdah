/**
 * Input — shadcn/ui `input` on `@base-ui/react/input`, keeping Howdah's tokens (HOW-16 P1.3,
 * moved onto base-vega in HOW-27). It absorbs the three hand-written text fields that
 * re-implemented it: `.logs-search`, `.chat-input input` and `.add-workspace-row input` /
 * `.gh-picker > input`, all deleted from howdah.css.
 *
 * Mono by default: everything typed into this app is machine-shaped (ids, paths, models), so
 * the font is the one deviation from the registry's styling that is kept deliberately.
 *
 * The props type stays `React.ComponentProps<"input">` rather than the primitive's own, which
 * is what base-vega ships and what keeps all twelve call sites compiling unchanged — they pass
 * ordinary input attributes (`value`, `onChange`, `aria-label`, `disabled`), not Base UI ones.
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <InputPrimitive
    ref={ref}
    data-slot="input"
    className={cn(
      "h-8 w-full rounded-[var(--radius-sm)] border border-border bg-muted px-2.5 font-mono text-base text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
