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
 *
 * AND IT IS NAMED BEFORE IT EXISTS (HOW-26). A step's id is derived from what it is called at
 * the moment it is added and then frozen, so seeding it with the KIND — which is what the six
 * buttons used to do — named every step after the button that made it: `ask-an-agent`,
 * `ask-an-agent-2` … `ask-an-agent-8`, and, since the prompt id comes off the id, the
 * instructions were filed under those names too. The title typed afterwards reached neither.
 * The box above the six buttons is the cause fixed rather than the symptom: it seeds the next
 * step whichever gesture places it, the id it will get is previewed under it as it is typed,
 * and it clears itself once the step exists. A step whose id is already wrong is repaired in
 * its own form (step-form.tsx RenameStep) rather than removed and re-made.
 */
import { Plus } from "lucide-react";
import { STEP_KINDS, nextNodeId, type PaletteKind } from "@/lib/spec-draft";
import { freeSpotNear } from "@/lib/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Draft } from "@/lib/spec-draft";
import type { Point } from "../../../core/graph-spec";
import { STEP_KIND_MIME, useCanvasCentre } from "./canvas";

export function Palette({ draft, name, onName, onAdd }: {
  draft: Draft;
  /** what the NEXT step will be called — lifted to the shell, because a drop starts here and
   *  lands on the canvas, and both gestures have to read the same box */
  name: string;
  onName: (name: string) => void;
  onAdd: (kind: PaletteKind, at?: Point) => void;
}) {
  const centre = useCanvasCentre();
  // the id the step WILL get, seeded with the RAW name and nothing else, because the add does
  // too: a second fallback here and a different one there is how an emptied box came to
  // preview one id and create another (HOW-26)
  const preview = nextNodeId(draft.spec, name);
  return (
    <div className="gb-palette">
      <div className="gb-palette-title">Add a step</div>
      <div className="builder-naming">
        <Label className="flex-1">
          What is the next step called?
          <Input
            value={name} placeholder="Implement the change"
            aria-label="what the next step is called"
            onChange={(e) => onName(e.target.value)}
          />
        </Label>
      </div>
      <div className="field-hint">
        The name becomes the step's id — <code>{preview}</code> — and that is what its
        instructions file is called too. A run's history is written against the id
        (<code>step#visit</code>), so it is fixed once the step exists; the step's own form can
        still move it, at the cost of any run parked there.
      </div>
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
