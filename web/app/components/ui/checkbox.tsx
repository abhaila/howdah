/**
 * Checkbox — hand-written, not the shadcn registry's (@radix-ui/react-checkbox is banned
 * here; HOW-16 P1.3/P1.4). It is a real `<input type="checkbox">` with the box drawn by
 * `appearance-none` + a `checked:` mark, so Space, the focus ring, form participation and
 * the indeterminate state stay the platform's.
 *
 * Replaces Settings' raw `<input type="checkbox" className="w-auto">`, which had no focus
 * treatment of its own and inherited a text field's `w-full` in both themes.
 *
 * HOW-27 MOVED THE PRIMITIVE LAYER ONTO base-vega AND DELIBERATELY LEFT THIS BEHIND. Its
 * checkbox is `@base-ui/react/checkbox`, which renders a `<button role="checkbox">` beside a
 * hidden input. That is a fine control, but it trades away the first sentence of this header —
 * the box IS the input, so Space, form participation and `indeterminate` stay the platform's —
 * and it changes the callback from `onChange(e)` to `onCheckedChange(checked)`, which is an API
 * break at every call site for no behaviour this app uses. The registry's styling is already
 * here; the primitive underneath would only add a layer.
 *
 * HOW-68: THE HIT AREA IS 24px, THE BOX IS STILL 16px. The audit measured the input at 16×16
 * — under the 24px minimum target — and DESIGN.md says how to fix that: "a small glyph gets its
 * hit area from padding, not from a bigger glyph". So the real `<input>` is now a transparent
 * 24px square and the 16px box is drawn by a sibling it drives (`peer-checked`,
 * `peer-focus-visible`, `peer-disabled`). It is still the input that is focused, toggled by
 * Space and submitted with a form; only the paint moved. `indeterminate` — which the first
 * paragraph promised and nothing drew — gets its dash.
 */
import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** rendered beside the box and tied to it by `for`, so the text is a hit target too */
  label: React.ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(({ className, label, id, ...props }, ref) => {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="relative -my-1 -ml-1 inline-flex size-6 shrink-0 items-center justify-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="peer absolute inset-0 m-0 size-6 cursor-pointer appearance-none rounded-[var(--radius-sm)] outline-none disabled:cursor-default"
          {...props}
        />
        <span
          aria-hidden
          className="pointer-events-none size-4 rounded-[var(--radius-xs)] border border-input bg-card peer-checked:border-[var(--primary)] peer-checked:bg-primary peer-indeterminate:border-[var(--primary)] peer-indeterminate:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--ring)] peer-focus-visible:outline-offset-2 peer-disabled:opacity-50"
        />
        <Check aria-hidden className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-checked:opacity-100" />
        <Minus aria-hidden className="pointer-events-none absolute size-3 text-primary-foreground opacity-0 peer-indeterminate:opacity-100" />
      </span>
      <label htmlFor={inputId} className="cursor-pointer text-base text-foreground">{label}</label>
    </span>
  );
});
Checkbox.displayName = "Checkbox";
