/**
 * Label — shadcn/ui `label` minus @radix-ui/react-label (HOW-16 P1.3): the Radix component
 * exists to forward clicks to a control, which a plain `<label>` already does when it WRAPS
 * that control. Every call site here wraps, so the dependency bought nothing.
 *
 * HOW-68: no longer an uppercase, letter-spaced 11px micro-label. DESIGN.md Type: "hierarchy
 * comes from weight … a section label is 12px/600 in --fg-muted" — the same voice as
 * `SectionLabel`, because a field's label and a section's label are the same kind of text.
 */
import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("flex flex-col gap-1 text-xs font-semibold text-muted-foreground", className)} {...props} />;
}
