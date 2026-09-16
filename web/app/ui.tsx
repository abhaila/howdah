/**
 * shadcn/ui components for Howdah (the deferred T11 follow-up). Same patterns as the
 * shadcn registry — cva variants + cn merge — with the theme mapped onto Howdah's tokens
 * in globals.css, so bg-primary IS the peacock and dark/light keep working from one set.
 * Select stays a styled native <select>: no Radix dependency, keyboard-correct for free.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, HTMLAttributes, LabelHTMLAttributes } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---- Button -----------------------------------------------------------------------

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius)] text-[13px] transition-[transform,opacity,background,border-color] duration-[var(--dur-fast)] cursor-pointer select-none active:scale-[0.97] disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90 disabled:bg-muted disabled:text-faint",
        outline: "border border-input bg-transparent text-muted-foreground hover:text-foreground hover:border-faint disabled:opacity-50",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50",
        "destructive-outline": "border border-destructive text-destructive bg-transparent",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 px-2.5 text-xs",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";

// ---- Card -------------------------------------------------------------------------

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius)] border border-border bg-card text-card-foreground", className)} {...props} />;
}
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-4 pb-2", className)} {...props} />;
}
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm leading-none", className)} {...props} />;
}
export function CardDescription({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-xs text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-3 p-4 pt-2", className)} {...props} />;
}

// ---- form controls ----------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-[var(--radius-sm)] border border-border bg-muted px-2.5 font-mono text-[13px] text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-16 w-full resize-y rounded-[var(--radius-sm)] border border-border bg-muted p-2.5 font-mono text-[13px] text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

/** shadcn-styled native select — keyboard/a11y correct without Radix */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <span className={cn("relative block w-full", className)}>
    <select
      ref={ref}
      className="h-8 w-full appearance-none rounded-[var(--radius-sm)] border border-border bg-muted pl-2.5 pr-8 font-mono text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-1"
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
  </span>
));
Select.displayName = "Select";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground", className)} {...props} />;
}

// ---- Badge ------------------------------------------------------------------------

const badgeVariants = cva("inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-px text-[11px] font-mono [&_svg]:size-3", {
  variants: {
    variant: {
      default: "bg-muted text-muted-foreground",
      attention: "bg-primary text-primary-foreground",
      outline: "border border-border text-muted-foreground",
      success: "bg-muted text-[var(--status-done)]",
      destructive: "bg-muted text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// ---- Tabs (controlled) ------------------------------------------------------------

export function Tabs({ value, onValueChange, items, className }: { value: string; onValueChange: (v: string) => void; items: Array<{ value: string; label: string; icon?: React.ReactNode }>; className?: string }) {
  return (
    <div className={cn("inline-flex gap-0.5 rounded-[var(--radius)] bg-muted p-0.5", className)} role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onValueChange(it.value)}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border-0 bg-transparent px-3 py-1 text-xs tracking-wide text-muted-foreground [&_svg]:size-3.5",
            value === it.value && "bg-card text-foreground",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-border", className)} />;
}
