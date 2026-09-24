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
 *
 * "In the middle of what you are looking at" is a PLACEMENT, not a turn of phrase: the click
 * path used to pass no position at all, so the reducer put the step below everything and, on a
 * graph taller than the pane, out of sight (review finding 3). It now asks the canvas where
 * the middle is — through the same `screenToFlowPosition` a drop uses — and `freeSpotNear`
 * steps aside from whatever is already there, so two clicks are two places rather than a pile.
 */
import { Plus } from "lucide-react";
import { STEP_KINDS, type StepKind } from "@/lib/spec-draft";
import { freeSpotNear } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import type { Draft } from "@/lib/spec-draft";
import type { Point } from "../../../core/graph-spec";
import { STEP_KIND_MIME, useCanvasCentre } from "./canvas";

export function Palette({ draft, onAdd }: {
  draft: Draft;
  onAdd: (kind: StepKind, at?: Point) => void;
}) {
  const centre = useCanvasCentre();
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
          // an unmeasured pane answers `undefined`, and `add-step` places it below everything —
          // which is the right answer to "we do not know what is on screen"
          onClick={() => onAdd(k.kind, freeSpotNear(draft.spec.nodes, centre()))}
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
