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
 *
 * HOW-68 (DESIGN.md Colour + Layout + Components):
 *
 *   THE SELECTED TAB IS AN INDIGO RULE UNDER ITS LABEL — "indigo is what you press and where
 *   you are". `Tabs` was a segmented control on an inset ground; it is now the same underline
 *   strip as `PanelTabs`, so there is one way a tab looks. Selected is the rule AND weight
 *   500, never only a colour.
 *   ONE ROW. The strip does not wrap; if it is wider than its pane it scrolls sideways
 *   (scrollbar hidden — arrow keys and focus bring a tab into view) rather than being clipped,
 *   which is how Logs and Graph became unreachable at 1024px.
 *   TARGETS. Every tab is at least 24px in both directions: the "Ask" tab measured 21×25 and
 *   the Step/Run scope chips 23px tall.
 *   NO MOTION. Tab switches are keyboard-driven and constant; selection is instant.
 *   `hint` prints a tab's shortcut beside it (the run view's `1`–`7`).
 *
 *   A STRIP HAS A NAME, AND SAYS WHAT IT SWITCHES (the confirming review). `label` is required:
 *   a `tablist` with no accessible name is "tab list" five times on one screen. `panel` is the
 *   id of the element the tabs switch; with it each tab carries an id and `aria-controls`, and
 *   the caller spreads `tabPanelProps(panel, value)` on that element, which makes it the
 *   `tabpanel` labelled by the selected tab. Base UI wires this only for ITS `Tabs.Panel`, and
 *   the panes here are the app's own (one container whose contents change), so it is done by id.
 */
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const tabId = (panel: string, value: string) => `${panel}-tab-${value}`;
/** what the element a strip switches must carry: spread it on the pane's container */
export function tabPanelProps(panel: string, value: string): { role: "tabpanel"; id: string; "aria-labelledby": string } {
  return { role: "tabpanel", id: panel, "aria-labelledby": tabId(panel, value) };
}
const wiring = (panel: string | undefined, value: string) => (panel === undefined ? {} : { id: tabId(panel, value), "aria-controls": panel });

const STRIP = "flex min-w-0 flex-nowrap overflow-x-auto [scrollbar-width:none]";
const TAB_FOCUS = "focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:-outline-offset-2";

/** the top-level switcher: one row of labels, the selected one over an indigo rule */
export function Tabs({ value, onValueChange, items, className, label, panel }: {
  value: string;
  onValueChange: (v: string) => void;
  /** the strip's accessible name: what it switches ("Run panes") */
  label: string;
  /** the id of the element it switches (see `tabPanelProps`) */
  panel?: string;
  items: Array<{ value: string; label: string; icon?: React.ReactNode; hint?: string }>;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      value={value}
      onValueChange={(v) => onValueChange(String(v))}
    >
      <TabsPrimitive.List aria-label={label} className={cn(STRIP, "gap-1", className)}>
        {items.map((it) => (
          <TabsPrimitive.Tab
            key={it.value}
            value={it.value}
            {...wiring(panel, it.value)}
            className={cn(
              "inline-flex h-9 min-w-6 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap border-0 border-b-2 border-solid bg-transparent px-2 text-base [&_svg]:size-3.5",
              TAB_FOCUS,
              value === it.value
                ? "border-b-[var(--primary)] font-medium text-foreground"
                : "border-b-transparent text-muted-foreground hover:text-foreground active:border-b-[var(--border-strong)]",
            )}
          >
            {it.icon}
            {it.label}
            {it.hint !== undefined && <span aria-hidden className="text-xs font-normal text-faint">{it.hint}</span>}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

const panelTabVariants = cva(
  "inline-flex min-h-6 min-w-6 shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap bg-transparent focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2",
  {
    variants: {
      /** how the strip reads: a rule under the pane names, or a row of chips */
      look: {
        underline: "h-8 border-0 border-b-2 border-solid px-1 text-sm",
        chip: "rounded-[var(--radius-xs)] border px-2 text-sm",
        /** one cell of a segmented control: the strip (the caller's className) is the well */
        segment: "h-6 rounded-[var(--radius-xs)] border-0 px-2.5 text-sm",
      },
      on: { true: "", false: "" },
    },
    compoundVariants: [
      // selected is never ONLY a colour: underline adds a rule and weight, chip adds a fill
      { look: "underline", on: true, className: "border-b-[var(--primary)] font-medium text-foreground" },
      { look: "underline", on: false, className: "border-b-transparent text-muted-foreground hover:text-foreground active:border-b-[var(--border-strong)]" },
      { look: "chip", on: true, className: "border-[var(--border-strong)] bg-card text-foreground" },
      { look: "chip", on: false, className: "border-border text-muted-foreground hover:border-[var(--border-strong)] hover:text-foreground active:bg-accent" },
      { look: "segment", on: true, className: "bg-card font-medium text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]" },
      { look: "segment", on: false, className: "text-muted-foreground hover:text-foreground active:bg-accent" },
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
export function PanelTabs<T extends string>({ value, onValueChange, items, className = "sd-tabs", look, label, panel }: {
  value: T;
  onValueChange: (v: T) => void;
  /** the strip's accessible name: what it switches ("Step panes") */
  label: string;
  /** the id of the element it switches (see `tabPanelProps`) */
  panel?: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  className?: string;
  look?: "underline" | "chip" | "segment";
}) {
  return (
    <TabsPrimitive.Root
      data-slot="panel-tabs"
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
    >
      <TabsPrimitive.List aria-label={label} className={className}>
        {items.map((it) => (
          <TabsPrimitive.Tab
            key={it.value}
            value={it.value}
            {...wiring(panel, it.value)}
            className={cn(panelTabVariants({ look, on: value === it.value }))}
          >
            {it.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
