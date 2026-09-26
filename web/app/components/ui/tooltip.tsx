/**
 * Tooltip — shadcn `tooltip` on `@base-ui/react/tooltip` (HOW-27), wearing Howdah's tokens.
 *
 * It replaces the 30 native `title=` attributes this app used as tooltips. `title` is not a
 * tooltip: it never appears on touch, it cannot be styled, its delay is the OS's, and a screen
 * reader may read it, ignore it or read it INSTEAD of the element's own name depending on the
 * pairing. This opens on hover AND on focus, closes on Escape, and ties itself to its trigger
 * with `aria-describedby` — the relationship `title` only approximates.
 *
 * WHY IT MOVED. HOW-16 wrote this by hand and said so: "Deliberately no positioning engine …
 * a floating-ui dependency for eight call sites would be the over-engineering this sweep
 * exists to remove." That was the right call then and it is not the situation now —
 * `@base-ui/react` brings `@floating-ui/react-dom` whether this file uses it or not, so the
 * cost is already paid and declining it only keeps the bug. The bug: the popup was
 * `position: absolute; left: 0; top: 100%` with no collision awareness, and the app's tooltips
 * sit on TRUNCATED PATHS IN THE INSPECTOR RAIL — hard against the right edge of the window,
 * which is the one place a fixed-left popup is guaranteed to overflow. The primitive flips and
 * shifts instead.
 *
 * The `content` + children API is kept: seven call sites wrap arbitrary inline content (a
 * truncated path, a chip, a glyph), and base-vega's `<Tooltip><TooltipTrigger><TooltipContent>`
 * composition would be three components at each of them to say the same thing.
 *
 * The trigger renders as a SPAN, not the primitive's default button: these wrap text and
 * chips inside existing controls, and a nested button is invalid HTML.
 *
 * THE ARIA RELATIONSHIP IS STILL OURS, and that is not belt-and-braces. Base UI's popup ships
 * with no `role="tooltip"`, no id, and sets no `aria-describedby` on the trigger — verified by
 * reading the rendered attributes, which are `data-open data-side data-align data-instant
 * tabindex=-1` and nothing else. Adopting it as-is would hand back exactly what HOW-16 P1.4
 * took thirty `title=` attributes away to gain, so the id, the role and the describedby are
 * wired here over a CONTROLLED open state. What is borrowed is the part that was worth
 * borrowing — where the box goes — and what was already correct is kept.
 *
 * One behaviour is deliberately unchanged — empty content renders the trigger alone rather
 * than an empty floating box, because several call sites pass a value that is only sometimes
 * present.
 */
import { useId, useState } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";

export function Tooltip({ content, children, className }: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen}>
      <TooltipPrimitive.Trigger
        data-slot="tooltip-trigger"
        aria-describedby={open ? id : undefined}
        render={<span className={cn("inline-flex min-w-0 max-w-full items-center", className)} />}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="bottom" align="start" sideOffset={4} className="z-20">
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            id={id}
            role="tooltip"
            className="w-max max-w-[320px] rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-card px-2 py-1 text-sm leading-snug text-foreground shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
