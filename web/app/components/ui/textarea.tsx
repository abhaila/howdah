/**
 * Textarea — shadcn/ui `textarea` on Howdah's tokens (HOW-16 P1.3). The graph-source editor
 * is the SAME control with a className override (`.graph-source-editor`), deliberately: a
 * second textarea component for "code" is how two styling systems start.
 *
 * HOW-68 (DESIGN.md Colour + Type). The field sits on `--bg-raised` — "a held object: card,
 * input, menu" — with a `--border-strong` edge, which is the token that clears 3:1 as a
 * control boundary; it used to be an inset well with a hairline. And it is SANS unless asked:
 * "mono only for what you would paste". Most of what is typed here is a name, a sentence or a
 * filter, and the placeholder ("Ask about this run…") is always prose. Pass `mono` for the
 * fields whose VALUE is machine text — a path, a model id, a command.
 */
import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** the value is machine text (source, JSON, a command) */
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, mono = false, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn(
      "min-h-16 w-full resize-y rounded-[var(--radius-sm)] border border-input bg-card p-2.5 text-base font-normal leading-normal text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 disabled:opacity-50",
      mono && "font-mono",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
