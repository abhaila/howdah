/**
 * The six kinds of step, as things you pick up (HOW-24) — the reference project's
 * `available-nodes-panel`.
 *
 * Six buttons rather than a dropdown, for the reason the wizard's list already gave: the kind
 * IS the decision, and a menu hides five of the six answers behind a click.
 *
 * ONE ACTION, TWO GESTURES (D7). Each item is a `Button` that is also `draggable`. Drag it and
 * the step lands where it was dropped; press Enter and it lands in the middle of what you are
 * looking at. Both go through `newStep()` and `add-step`, so the defaults each kind starts
 * from are the same either way — there is no second definition of "a new wait step".
 */
import { Plus } from "lucide-react";
import { STEP_KINDS, type StepKind } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";

/** What a dragged palette item carries. A plain string, because that is all a drop needs. */
export const STEP_KIND_MIME = "application/howdah-step-kind";

export function Palette({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  return (
    <div className="gb-palette">
      <div className="gb-palette-title">Add a step</div>
      {STEP_KINDS.map((k) => (
        <Button
          key={k.kind}
          variant="outline"
          className="gb-palette-item"
          draggable
          aria-label={`${k.label} — ${k.help} Drag it onto the canvas, or press Enter to drop it in the middle.`}
          onDragStart={(e) => {
            e.dataTransfer.setData(STEP_KIND_MIME, k.kind);
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => onAdd(k.kind)}
        >
          <Plus />
          <span className="gb-palette-label">{k.label}</span>
        </Button>
      ))}
      <div className="field-hint">
        Drag one onto the canvas, or press Enter to drop it in the middle. Join two steps by
        dragging from the dot under one to the dot above the next.
      </div>
    </div>
  );
}
