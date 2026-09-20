/**
 * Tooltip — hand-written, because the shadcn registry's is @radix-ui/react-tooltip and this
 * project takes no Radix dependency (HOW-16 P1.3/P1.4).
 *
 * It replaces the 30 native `title=` attributes this app used as tooltips. `title` is not a
 * tooltip: it never appears on touch, it cannot be styled, its delay is the OS's, and a
 * screen reader may read it, ignore it or read it INSTEAD of the element's own name
 * depending on the pairing. This opens on hover AND on focus AND on tap, and ties itself to
 * its trigger with `aria-describedby`, which is the relationship `title` only approximates.
 *
 * Deliberately no positioning engine: the content is absolutely positioned under the
 * trigger and clamped by `max-w`. A floating-ui dependency for eight call sites would be the
 * over-engineering this sweep exists to remove.
 */
import { useId, useState } from "react";
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
    <span
      className={cn("relative inline-flex max-w-full items-center", className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex min-w-0 max-w-full items-center">{children}</span>
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-max max-w-[320px] rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-card px-2 py-1 text-sm leading-snug text-foreground shadow-[0_2px_10px_rgba(0,0,0,0.35)]"
      >
        {content}
      </span>
    </span>
  );
}
