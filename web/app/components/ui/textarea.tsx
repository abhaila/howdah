/**
 * Textarea — shadcn/ui `textarea` on Howdah's tokens (HOW-16 P1.3). The graph-source editor
 * is the SAME control with a className override (`.graph-source-editor`), deliberately: a
 * second textarea component for "code" is how two styling systems start.
 */
import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-16 w-full resize-y rounded-[var(--radius-sm)] border border-border bg-muted p-2.5 font-mono text-base text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
