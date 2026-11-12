/**
 * One section of the builder's panel (HOW-68).
 *
 * The panel was a stack of `Card`s — a bordered box per topic, inside a bordered column — and
 * the field registry was a card with a table in it. DESIGN.md: "panels are separated by a 1px
 * border and a change of ground", "no nested cards". So a topic is a `SectionLabel`, an
 * optional sentence under it, and its controls, and one hairline separates it from the next.
 * It is a real `<section>` named by its own heading, so the panel's outline is its sections.
 *
 * Its own file because both properties.tsx and fields.tsx draw one, and properties.tsx
 * imports fields.tsx.
 */
import { useId } from "react";
import { SectionLabel } from "@/components/ui/section-label";

export function Section({ title, hint, children }: {
  title: React.ReactNode;
  /** one sentence saying what this section decides */
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 border-b border-border py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <SectionLabel as="h3" id={id}>{title}</SectionLabel>
        {hint !== undefined && <p className="m-0 text-pretty text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
