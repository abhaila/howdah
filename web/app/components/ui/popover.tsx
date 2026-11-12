/**
 * Popover — a small panel that opens from its trigger, on `@base-ui/react/popover` (HOW-68).
 *
 * The step between a Tooltip and a Dialog, which this app did not have, so both were being
 * used for it. A Tooltip cannot hold a control (it closes when the pointer leaves, and its
 * content is not reachable by Tab). A Dialog is an interruption — DESIGN.md: "Dialog is for an
 * interruption that must be answered; a detail view is a panel or the drawer, not a modal".
 * A popover is for the thing in between: a filter's options, a "pin a comment" box, the full
 * text of something with a Copy button — anchored to what opened it, dismissed by Escape, by
 * pressing elsewhere, or by finishing.
 *
 * `trigger` + children, like `Tooltip content=` + children and for the same reason: every use
 * is one trigger and one body. It is uncontrolled unless `open`/`onOpenChange` are passed —
 * most uses do not care, and the one that does (close after a successful save) can.
 *
 * Non-modal on purpose: focus moves into the popup when it opens and returns to the trigger
 * when it closes (the primitive's), but the page behind stays live — nothing here is important
 * enough to trap anyone. Motion is the shared trigger-anchored entrance (`POP_MOTION`):
 * 150ms from `scale(0.97)` at the trigger, none when the keyboard opened it. The popup carries
 * `data-layer`, which is how the Escape layering knows to leave this Escape to the popover.
 */
import { useRef } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useLayerContainer } from "@/lib/layer";
import { cn } from "@/lib/utils";
import { POP_MOTION } from "./tooltip";

export function Popover({ trigger, children, title, open, onOpenChange, side = "bottom", align = "start", className }: {
  /** a real button element — a `Button` or a `Chip` */
  trigger: React.ReactElement<Record<string, unknown>>;
  children: React.ReactNode;
  /** a heading for the panel; it also names the popup for assistive tech */
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const container = useLayerContainer();
  // Focus lands on the PANEL when it opens, not on the first control inside it. The primitive's
  // default is the first focusable — and where that is a button with a tooltip (the copy
  // button in "About this home"), the tooltip opened with it and took the first Escape: Esc
  // closed a tooltip nobody asked for and the popover stayed. From the panel, Tab reaches the
  // first control as before, and one Escape closes what was opened.
  const popup = useRef<HTMLDivElement | null>(null);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange === undefined ? undefined : (o) => onOpenChange(o)}>
      <PopoverPrimitive.Trigger render={trigger} data-slot="popover-trigger" />
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-40">
          <PopoverPrimitive.Popup
            ref={popup}
            initialFocus={popup}
            tabIndex={-1}
            data-slot="popover"
            data-layer="popover"
            className={cn(
              "flex w-72 max-w-[calc(100vw-16px)] flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-card p-3 text-base text-foreground shadow-float outline-none",
              POP_MOTION,
              className,
            )}
          >
            {title !== undefined && <PopoverPrimitive.Title className="m-0 text-base font-semibold">{title}</PopoverPrimitive.Title>}
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
