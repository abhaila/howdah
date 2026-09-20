/**
 * Chip — the interactive half of HOW-16 P0.2, hand-written in the house cva + cn pattern
 * (the shadcn registry has no chip; its nearest relative is `toggle`, which is Radix).
 *
 * `.chip` had no base rule ANYWHERE — howdah.css carried only `.chip.attention.on` and
 * `.chat-suggestions .chip`, so the Logs filters, the chat citations and the Steps scope
 * switcher rendered as bare text. Worse, every one of those call sites was a `<span>` with
 * an `onClick`: no role, no tabIndex, no key handler, unreachable by keyboard or screen
 * reader (P2.8). A chip is a toggle, so this is a real `<button aria-pressed>` — which
 * makes Enter, Space and the focus ring the platform's job, not ours.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const chipVariants = cva(
  "inline-flex cursor-pointer select-none items-center gap-1 rounded-[var(--radius-sm)] border px-2 py-0.5 text-sm transition-[background,color,border-color] duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      /** `on` is the SELECTED state; it must never be only a colour, so it also fills */
      on: {
        true: "border-[var(--border-strong)] bg-card text-foreground",
        false: "border-border bg-transparent text-muted-foreground hover:border-faint hover:text-foreground",
      },
      /** the one chip allowed the alarm colour: the Logs `attention` filter, when on */
      tone: {
        default: "",
        attention: "",
      },
    },
    compoundVariants: [
      { tone: "attention", on: true, className: "border-[var(--attention)] bg-[var(--attention)] text-[var(--bg)]" },
    ],
    defaultVariants: { on: false, tone: "default" },
  },
);

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onToggle">,
    VariantProps<typeof chipVariants> {}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(({ className, on, tone, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} aria-pressed={on === true} className={cn(chipVariants({ on, tone }), className)} {...props} />
));
Chip.displayName = "Chip";
