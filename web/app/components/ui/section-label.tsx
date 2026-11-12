/**
 * SectionLabel — the label over a group (HOW-68, DESIGN.md Type).
 *
 * It replaces the uppercase, letter-spaced micro-label the app used for this job in a dozen
 * places (`.rail h2`, `.pp-label`, `.act-label`, the palette title…), each at its own size and
 * tracking. DESIGN.md: "hierarchy comes from weight and these steps, not from uppercase or
 * letter-spacing — a section label is 12px/600 in --fg-muted". That sentence is this
 * component, so the next one cannot be spelled a thirteenth way.
 *
 * `as` picks the element because a label over a section is usually a heading (`h2`/`h3`) and
 * the outline should say so; the default `div` is for a label that groups controls rather
 * than content. `count` is the quiet number beside it ("Needs you 11").
 */
import { cn } from "@/lib/utils";

export function SectionLabel({ as: Tag = "div", count, children, className, id }: {
  as?: "div" | "h2" | "h3" | "h4" | "span";
  count?: number | string;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <Tag id={id} data-slot="section-label" className={cn("m-0 flex items-baseline gap-2 text-xs font-semibold leading-5 text-muted-foreground", className)}>
      {children}
      {count !== undefined && <span className="font-normal text-faint">{count}</span>}
    </Tag>
  );
}
