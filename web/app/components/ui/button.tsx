/**
 * Button — shadcn/ui `button`, vendored and rewritten onto Howdah's tokens (HOW-16 P1.3,
 * moved onto base-vega's primitive in HOW-27). Provenance: the shadcn registry's cva + cn
 * shape, kept verbatim; the variant VALUES are ours, because globals.css maps our tokens onto
 * the shadcn colour contract (bg-primary IS the ink, not a hue).
 *
 * HOW-16 dropped the registry's `asChild`/Slot rather than pull @radix-ui/react-slot in for it.
 * base-vega's button is `@base-ui/react/button`, whose `render` prop is the same idea without
 * the Radix dependency — and `message-scroller` needs exactly that, since it renders its
 * scroll pin THROUGH this Button (`render={<Button …/>}`). `forwardRef` and the plain
 * `ButtonHTMLAttributes` props stay, so all twenty call sites compile untouched.
 *
 * This component now also owns the five hand-written CSS buttons it was always a copy of —
 * `.ide-btn`, `.gr-pin`, `.pc-feedback`, `.banner .retry` and `.ws-remove` are deleted from
 * howdah.css/globals.css and their call sites render a Button variant.
 *
 * HOW-68 (DESIGN.md Components + Motion). `default` IS THE PRIMARY ACTION and it is indigo —
 * `--primary` used to be the ink, so the "primary" button was a black or white slab; it is now
 * the accent, one per view. What changed with it:
 *
 *   PRESS AND HOVER. Press is `scale(0.97)` in 120ms and hover is a COLOUR change only, on
 *   plain `ease` — no lift, no scale. The press was already written here and never animated:
 *   Tailwind 4 emits `active:scale-[0.97]` as the `scale` property, and the transition listed
 *   `transform`, so the two never met. The transition names `scale` now.
 *   HOVER NEVER DIMS. `hover:opacity-90` made a hovered primary button LOWER in contrast than
 *   an idle one; it goes to `--primary-hover`, which tokens.test.ts proves against its ink.
 *   GHOST HOVERS ON ANY GROUND. Its hover was `--bg-inset`, which is invisible on the rail
 *   (the rail IS `--bg-inset`). It is a translucent wash of the ink instead.
 *   TARGETS. Every size is at least 24px (`icon-sm`), 32px for the default; `inline` is the
 *   one exception WCAG 2.5.8 itself makes, a link inside a sentence.
 *   LOADING. `loading` disables the button, marks it `aria-busy` and shows the one looping
 *   animation DESIGN.md allows — a spinner on something that is actually waiting.
 *   DISABLED IS READABLE, AND LOADING IS NOT DISABLED. Every variant used to dim with
 *   `opacity-50`, which measured 2.3–2.8:1 in both themes — exempt from WCAG, and too faint to
 *   read what the control WOULD do. A disabled button now loses its fill and takes
 *   `--fg-disabled` (≥3:1 on every ground, proven in tokens.test.ts; under 4.5:1 so it still
 *   reads as off). The dimming hangs on `data-off`, not on `:disabled`: a loading button is
 *   disabled in the DOM so it cannot be pressed twice, but it keeps its own colours — the
 *   spinner says it is busy, and its label is the thing being waited for.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] text-base font-medium transition-[scale,background-color,border-color,color] duration-[var(--dur-fast)] ease-[ease] cursor-pointer select-none active:scale-[0.97] disabled:pointer-events-none disabled:cursor-default focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** the primary action: indigo, one per view */
        default: "bg-primary font-semibold text-primary-foreground hover:bg-[var(--primary-hover)] data-[off]:bg-muted data-[off]:text-disabled",
        outline: "border border-input bg-card text-foreground hover:bg-accent data-[off]:border-border data-[off]:bg-transparent data-[off]:text-disabled",
        /** hover is a wash of the ink, so it shows on --bg, --bg-raised AND --bg-inset */
        ghost: "text-muted-foreground hover:bg-[color-mix(in_srgb,var(--fg)_9%,transparent)] hover:text-foreground data-[off]:text-disabled",
        destructive: "bg-destructive font-semibold text-destructive-foreground hover:bg-[var(--status-failed-terminal)] data-[off]:bg-muted data-[off]:text-disabled",
        "destructive-outline": "border border-destructive bg-transparent text-destructive hover:bg-[color-mix(in_srgb,var(--status-failed-recoverable)_10%,transparent)] data-[off]:border-border data-[off]:text-disabled",
        /** the inline disclosure that used to be a bare `.linkish` span with an onClick */
        link: "h-auto p-0 font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground data-[off]:text-disabled data-[off]:no-underline",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-2.5 text-sm",
        icon: "size-8",
        /** a glyph in a dense row (copy, dismiss, close): the 24px floor, never smaller */
        "icon-sm": "size-6 rounded-[var(--radius-sm)]",
        /** for `link`: no box at all, so it can sit inside a sentence */
        inline: "h-auto min-h-6 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** the action is in flight: disabled, `aria-busy`, and a spinner before the label */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", loading = false, disabled, children, ...props }, ref) => (
  <ButtonPrimitive
    ref={ref}
    type={type}
    data-slot="button"
    aria-busy={loading || undefined}
    disabled={disabled || loading}
    data-off={(disabled && !loading) || undefined}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  >
    {loading && <LoaderCircle aria-hidden className="animate-spin" />}
    {children}
  </ButtonPrimitive>
));
Button.displayName = "Button";
