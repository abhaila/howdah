/**
 * Badge — shadcn/ui `badge` on Howdah's tokens, plus the `.pill` variants (HOW-16 P0.2).
 *
 * `.pill` was a class name with NO base rule anywhere: howdah.css defined only
 * `.pill.scope-cleared`, `.pill.scope-per-visit` and `.chat-head .pill`, so every static
 * pill in the app — context scope pills, the chat read-only pill, log-row event types, the
 * id chips in the context detail — rendered as unstyled text for as long as it shipped. The
 * fix is not another base rule that can go missing: the styling now comes from the
 * component, so a pill cannot be rendered without it.
 *
 * Colour stays out of it. `scope-cleared`'s dulled gold and `scope-per-visit`'s slate were
 * the two hues the old modifiers carried, and they are carried here by name.
 */

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-px text-xs font-mono [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-muted text-muted-foreground",
        attention: "bg-primary text-primary-foreground",
        outline: "border border-border text-muted-foreground",
        success: "bg-muted text-[var(--status-done)]",
        destructive: "bg-muted text-destructive",
        /** an identity: a node@visit, a prompt id — mono, quiet, never an alarm */
        id: "bg-muted text-foreground",
        /** context scope `cleared`: veiled while its writer re-runs */
        "scope-cleared": "bg-muted text-[var(--scope-cleared)]",
        /** context scope `per-visit`: freshness is part of its meaning */
        "scope-per-visit": "bg-muted text-[var(--status-running)]",
        /** context scope `sticky`: the boring case, so no hue at all */
        "scope-sticky": "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/**
 * HOW-27: base-vega's badge is the `useRender` + `mergeProps` shape rather than a bare tag, so
 * a caller can render the badge AS something else — `render={<a href=… />}` for a badge that
 * navigates — without this file growing a variant per element. A plain `<span>` is still what
 * it renders when nobody asks, so all sixteen existing call sites are untouched.
 */
export function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

/** the scope a context key declares → its Badge variant (one mapping, not one per call site) */
export function scopeVariant(scope: string): BadgeVariant {
  return scope === "cleared" ? "scope-cleared" : scope === "per-visit" ? "scope-per-visit" : "scope-sticky";
}
