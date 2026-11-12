/**
 * Menu — a trigger and a list of actions, on `@base-ui/react/menu` (HOW-68).
 *
 * It exists for one job first: DESIGN.md says "secondary actions go behind one More menu; a
 * header is one row at every supported width". The run header had five controls in a row that
 * wrapped to a second line at 1440px and were clipped at 1024px — the audit's "Open run folder
 * wraps" and "192px of controls unreachable". A menu is how a header keeps its primary action
 * visible and everything else one press away.
 *
 * The API is DATA, like `Tabs items=` and for the same reason: a menu here is always a list of
 * labelled actions, so `items={[{ label, onSelect }]}` is the smaller interface and Base UI's
 * `<Menu.Root><Menu.Trigger><Menu.Portal><Menu.Positioner><Menu.Popup><Menu.Item>` composition
 * would be six components at every call site to say it. `trigger` is any element that renders
 * a real button — in practice a `Button` — and the primitive merges its props onto it, so the
 * trigger keeps its variant, its `Kbd` hint and its tooltip.
 *
 * What the primitive buys is the part not worth owning: roving focus, typeahead, Home/End,
 * Escape and outside-press dismissal, focus returned to the trigger, and collision-aware
 * placement. What is ours: the items show their shortcut (`keys`, in the registry's grammar,
 * so the hint and the binding are the same string), a destructive item is red AND says so by
 * its label rather than by colour alone, and the motion is DESIGN.md's — it scales in from the
 * trigger in 150ms, and not at all when the keyboard opened it (`data-instant`).
 *
 * `modal={false}`: Base UI's default locks page scroll and makes everything outside inert,
 * which is right for a phone and wrong for a desktop tool where the shell never scrolls and a
 * click elsewhere should simply land. The popup is marked `data-layer` so the Escape layering
 * in `lib/shortcuts.ts` knows something more specific than a drawer is open.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useLayerContainer } from "@/lib/layer";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";
import { POP_MOTION } from "./tooltip";

export type MenuEntry =
  | {
      label: string;
      onSelect?: () => void;
      /** renders the item as a link: middle-click and copy-link keep working */
      href?: string;
      icon?: React.ReactNode;
      /** the shortcut that does the same thing, in `lib/shortcuts.ts` grammar */
      keys?: string;
      disabled?: boolean;
      destructive?: boolean;
    }
  | { separator: true }
  | { heading: string }
  /** a sentence of explanation under the items it is about: plain text, not an item, never focusable */
  | { note: string };

const ITEM =
  "flex min-h-8 cursor-default select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 text-base text-foreground no-underline outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:text-faint [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

export function Menu({ trigger, items, label, side = "bottom", align = "end", className }: {
  /** a real button element — a `Button`, usually with the menu's name as its text */
  trigger: React.ReactElement<Record<string, unknown>>;
  items: readonly MenuEntry[];
  /** the menu's accessible name, when the trigger's own text does not already say it */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const container = useLayerContainer();
  return (
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger render={trigger} data-slot="menu-trigger" />
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-40 outline-none">
          <MenuPrimitive.Popup
            data-slot="menu"
            data-layer="menu"
            aria-label={label}
            className={cn(
              "min-w-44 max-w-[min(320px,calc(100vw-16px))] rounded-[var(--radius)] border border-[var(--border-strong)] bg-card p-1 text-foreground shadow-float outline-none",
              POP_MOTION,
              className,
            )}
          >
            {items.map((it, i) => {
              if ("separator" in it) return <MenuPrimitive.Separator key={i} className="mx-1 my-1 h-px bg-border" />;
              if ("note" in it) return <p key={i} role="presentation" className="m-0 px-2 pb-1.5 pt-0.5 text-xs leading-[1.45] text-muted-foreground">{it.note}</p>;
              if ("heading" in it) return <div key={i} role="presentation" className="px-2 pb-0.5 pt-1.5 text-xs font-semibold text-muted-foreground">{it.heading}</div>;
              const body = (
                <>
                  {it.icon}
                  <span className="min-w-0 flex-1">{it.label}</span>
                  {it.keys !== undefined && <Kbd keys={it.keys} decorative className="ml-4" />}
                </>
              );
              const cls = cn(ITEM, it.destructive && "text-destructive [&_svg]:text-destructive");
              return it.href !== undefined ? (
                <MenuPrimitive.LinkItem key={i} href={it.href} closeOnClick className={cls} onClick={it.onSelect}>{body}</MenuPrimitive.LinkItem>
              ) : (
                <MenuPrimitive.Item key={i} disabled={it.disabled} className={cls} onClick={it.onSelect}>{body}</MenuPrimitive.Item>
              );
            })}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
