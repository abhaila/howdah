/**
 * Tabs + PanelTabs — the shadcn `tabs` behaviour on `@base-ui/react/tabs` (HOW-27), wearing
 * Howdah's cva + cn styling. Both stay controlled: the pane is app state, not widget state.
 *
 * The `items={[{value,label}]}` API is KEPT rather than replaced by base-vega's
 * `<Tabs><TabsList><TabsTrigger>` composition. Ten call sites pass a list — the run view's
 * top switcher, every Steps pane switcher, the Logs filters, the scope toggle — and rewriting
 * them to spell out three nested components each would be a large diff that buys nothing: the
 * list IS the data here, and a component that takes it is the smaller interface.
 *
 * What the primitive buys, and the reason this moved: ARROW-KEY ROVING FOCUS. These were
 * hand-written `role="tab"` buttons that handled Enter and Space and nothing else, so a
 * keyboard user had to Tab through every tab in the strip instead of arrowing across it,
 * which is the actual ARIA tabs pattern. Base UI implements the roving tabindex, Home/End,
 * and the orientation-aware arrow keys; that is the part worth not owning.
 *
 * P0 DEFECT 1 LIVES HERE. `PanelTabs` used to emit `cn(itemClassName, selected && "on")`
 * while howdah.css defined `.tab.active` — a rule NOTHING emitted. Every pane switcher in
 * the Steps detail panel therefore showed no selected tab at all, and `aria-selected` was
 * not styled either, so the only thing saying which pane was open was the pane. The fix is
 * structural rather than another rule: the selected styling is a cva variant on the
 * component that also sets `aria-selected`, so the two cannot come apart again. The
 * regression is pinned in web/app/components/components.test.tsx.
 *
 * The `itemClassName` hook is gone with it: spacing belongs to the strip (`.sd-tabs`,
 * `.sd-scope`), appearance belongs to the component, and there is no longer a third place
 * for either to go missing.
 */
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** the top-level switcher: a segmented control on an inset ground */
export function Tabs({ value, onValueChange, items, className }: {
  value: string;
  onValueChange: (v: string) => void;
  items: Array<{ value: string; label: string; icon?: React.ReactNode }>;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
    >
      <TabsPrimitive.List className={cn("inline-flex gap-0.5 rounded-[var(--radius)] bg-muted p-0.5", className)}>
        {items.map((it) => (
          <TabsPrimitive.Tab
            key={it.value}
            value={it.value}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border-0 bg-transparent px-3 py-1 text-sm tracking-wide text-muted-foreground [&_svg]:size-3.5",
              value === it.value && "bg-card text-foreground",
            )}
          >
            {it.icon}
            {it.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

const panelTabVariants = cva(
  "cursor-pointer select-none border-0 bg-transparent transition-colors duration-[var(--dur-fast)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2",
  {
    variants: {
      /** how the strip reads: a rule under the pane names, or a row of chips */
      look: {
        underline: "px-0 pb-1.5 text-sm tracking-[0.02em] border-b-2",
        chip: "rounded-[var(--radius-sm)] border px-2 py-0.5 text-sm",
      },
      on: { true: "", false: "" },
    },
    compoundVariants: [
      // selected is never ONLY a colour: underline adds a rule and weight, chip adds a fill
      { look: "underline", on: true, className: "border-b-[var(--fg)] font-semibold text-foreground" },
      { look: "underline", on: false, className: "border-b-transparent text-muted-foreground hover:text-foreground" },
      { look: "chip", on: true, className: "border-[var(--border-strong)] bg-card text-foreground" },
      { look: "chip", on: false, className: "border-border text-muted-foreground hover:border-faint hover:text-foreground" },
    ],
    defaultVariants: { look: "underline", on: false },
  },
);

/**
 * The detail panel's pane switcher: real tabs for assistive tech and the keyboard —
 * role="tab", focusable, Enter/Space select — so every pane (Ask, Approval, Drift, Map,
 * Prompt, Output, Raw) is reachable without a mouse.
 *
 * `look="chip"` is the Step/Run scope switcher. It reads as a chip but stays a TAB: it
 * switches which pane the panel shows, and `role="tab"` is what says so. Chip (the
 * component) is for the toggles that are not pane switchers — the Logs filters, the chat
 * suggestions — so the two never share a call site.
 */
export function PanelTabs<T extends string>({ value, onValueChange, items, className = "sd-tabs", look }: {
  value: T;
  onValueChange: (v: T) => void;
  items: ReadonlyArray<{ value: T; label: string }>;
  className?: string;
  look?: "underline" | "chip";
}) {
  return (
    <TabsPrimitive.Root
      data-slot="panel-tabs"
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
    >
      <TabsPrimitive.List className={className}>
        {items.map((it) => (
          <TabsPrimitive.Tab
            key={it.value}
            value={it.value}
            className={cn(panelTabVariants({ look, on: value === it.value }))}
          >
            {it.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
