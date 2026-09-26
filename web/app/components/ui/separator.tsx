/**
 * Separator — shadcn/ui `separator` on `@base-ui/react/separator` (HOW-27; it was a bare
 * `<div aria-hidden>` since HOW-16 P1.3, when @radix-ui/react-separator was dropped).
 *
 * The primitive contributes `role="separator"` and an `orientation` prop, and BOTH are kept
 * here rather than suppressed: the reason HOW-16 dropped them was the dependency, not the
 * semantics, and a run view that draws rules between sections is better off announcing them.
 * `orientation` defaults to horizontal, which is still the only one this app draws.
 *
 * NOTE: nothing imports this today — `grep -rn Separator web/app` finds only this file. It is
 * migrated rather than deleted because deleting a primitive is a separate decision from moving
 * the layer onto base-vega, but it is a candidate for removal.
 */
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@/lib/utils";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}
