/**
 * Input — shadcn/ui `input` on `@base-ui/react/input`, keeping Howdah's tokens (HOW-16 P1.3,
 * moved onto base-vega in HOW-27). It absorbs the three hand-written text fields that
 * re-implemented it: `.logs-search`, `.chat-input input` and `.add-workspace-row input` /
 * `.gh-picker > input`, all deleted from howdah.css.
 *
 * The props type stays `React.ComponentProps<"input">` rather than the primitive's own, which
 * is what base-vega ships and what keeps all twelve call sites compiling unchanged — they pass
 * ordinary input attributes (`value`, `onChange`, `aria-label`, `disabled`), not Base UI ones.
 *
 * HOW-68 (DESIGN.md Colour + Type). The field sits on `--bg-raised` — "a held object: card,
 * input, menu" — with a `--border-strong` edge, which is the token that clears 3:1 as a
 * control boundary; it used to be an inset well with a hairline. And it is SANS unless asked:
 * "mono only for what you would paste". Most of what is typed here is a name, a sentence or a
 * filter, and the placeholder ("Ask about this run…") is always prose. Pass `mono` for the
 * fields whose VALUE is machine text — a path, a model id, a command.
 */
import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** the value is machine text (a path, an id, a command) */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, mono = false, ...props }, ref) => (
  <InputPrimitive
    ref={ref}
    data-slot="input"
    className={cn(
      "h-8 w-full rounded-[var(--radius-sm)] border border-input bg-card px-2.5 text-base font-normal text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 hover:border-[var(--fg-faint)] disabled:cursor-default disabled:border-border disabled:bg-transparent disabled:text-disabled",
      mono && "font-mono",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
