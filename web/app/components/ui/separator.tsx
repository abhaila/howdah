/**
 * Separator — shadcn/ui `separator` minus @radix-ui/react-separator (HOW-16 P1.3). The Radix
 * component contributes an orientation prop and `role="separator"`; a decorative hairline
 * wants neither, and the one orientation this app draws is horizontal.
 */
import { cn } from "@/lib/utils";

export function Separator({ className }: { className?: string }) {
  return <div aria-hidden className={cn("h-px w-full bg-border", className)} />;
}
