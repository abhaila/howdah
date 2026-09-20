/**
 * Button — shadcn/ui `button`, vendored and rewritten onto Howdah's tokens (HOW-16 P1.3).
 * Provenance: the shadcn registry's cva + cn shape, kept verbatim; the variant VALUES are
 * ours, because globals.css maps our tokens onto the shadcn colour contract (bg-primary IS
 * the ink, not a hue). No Radix: the registry's `asChild`/Slot is dropped rather than
 * pulling @radix-ui/react-slot in — nothing in this app needed it.
 *
 * This component now also owns the five hand-written CSS buttons it was always a copy of —
 * `.ide-btn`, `.gr-pin`, `.pc-feedback`, `.banner .retry` and `.ws-remove` are deleted from
 * howdah.css/globals.css and their call sites render a Button variant.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] text-base transition-[transform,opacity,background,border-color] duration-[var(--dur-fast)] cursor-pointer select-none active:scale-[0.97] disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90 disabled:bg-muted disabled:text-faint",
        outline: "border border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-faint disabled:opacity-50",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50",
        "destructive-outline": "border border-destructive text-destructive bg-transparent",
        /** the inline disclosure that used to be a bare `.linkish` span with an onClick */
        link: "h-auto p-0 text-muted-foreground underline underline-offset-2 hover:text-foreground",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-2.5 text-sm",
        icon: "size-8",
        /** for `link`: no box at all, so it can sit inside a sentence */
        inline: "h-auto p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";
