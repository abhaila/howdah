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
 *
 * HOW-68 added three things. MOTION, per DESIGN.md: the popup enters from `scale(0.97)` +
 * opacity AT ITS TRIGGER (`transform-origin: var(--transform-origin)`, which Base UI computes
 * from the side it landed on) in 150ms, leaves faster and plain, and does not animate at all
 * when the keyboard opened it — Base UI marks that `data-instant`, and a focus-triggered
 * tooltip that eases in trails one step behind Tab. `disabled`, so a caller whose content is
 * only SOMETIMES wanted (`Truncate`, a nav item that is only a bare icon when the rail is
 * collapsed) keeps one stable tree instead of mounting and unmounting its child around the
 * tooltip. And the portal goes into the enclosing `<dialog>` when there is one
 * (`lib/layer.ts`): a tooltip portalled to the body sits UNDER a modal dialog's top layer.
 */
import { useId, useRef, useState } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useLayerContainer } from "@/lib/layer";
import { cn } from "@/lib/utils";

/** the entrance every trigger-anchored layer shares (Tooltip, Menu, Popover) — DESIGN.md Motion */
export const POP_MOTION =
  "origin-[var(--transform-origin)] transition-[scale,opacity] duration-[var(--dur-pop)] ease-[var(--ease-out-strong)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--dur-fast)] data-[ending-style]:ease-[ease] data-[instant]:transition-none";

export function Tooltip({ content, children, className, disabled = false, forceOpen = false, side = "bottom", align = "start" }: {
  content: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** keep the trigger and its child mounted but never open: the content is not wanted right now */
  disabled?: boolean;
  /** open it from outside as well: `Truncate` inside a link shows its value while the LINK has focus */
  forceOpen?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useLayerContainer();
  // `forceOpen` is a caller saying "my link has focus" (Truncate inside a row), so it is the
  // keyboard's doing — J/K, Tab — and DESIGN.md's rule is that nothing keyboard-triggered
  // animates. Base UI's own `data-instant` only covers opens IT saw; a forced one eased in
  // and out on every J and K down a list. Instant while forced, and for the close that follows.
  const forced = useRef(false);
  if (forceOpen) forced.current = true;
  else if (open) forced.current = false;
  // (above the early return: every hook runs on every render, whatever the content is)
  if (content === null || content === undefined || content === "") return <>{children}</>;
  const shown = (open || forceOpen) && !disabled;
  return (
    <TooltipPrimitive.Root open={shown} onOpenChange={setOpen} disabled={disabled}>
      <TooltipPrimitive.Trigger
        data-slot="tooltip-trigger"
        data-tooltip={disabled ? undefined : ""} /* "there IS more to read here", findable while closed (tools/visual's audit) */
        aria-describedby={shown ? id : undefined}
        render={<span className={cn("inline-flex min-w-0 max-w-full items-center", className)} />}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal container={container}>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-50">
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            id={id}
            role="tooltip"
            className={cn(
              "w-max max-w-[min(320px,calc(100vw-16px))] rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-card px-2 py-1 text-sm leading-snug text-foreground shadow-float [overflow-wrap:anywhere]",
              POP_MOTION,
              forced.current && !open && "transition-none",
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
