/**
 * Label — shadcn/ui `label` minus @radix-ui/react-label (HOW-16 P1.3): the Radix component
 * exists to forward clicks to a control, which a plain `<label>` already does when it WRAPS
 * that control. Every call site here wraps, so the dependency bought nothing.
 */
import type { LabelHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("flex flex-col gap-1 text-xs uppercase tracking-[0.06em] text-muted-foreground", className)} {...props} />;
}
