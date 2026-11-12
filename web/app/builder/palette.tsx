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
 *
 * HOW-68 (DESIGN.md). Each item says what it IS as well as what it is called — a glyph, a
 * name, and the one line of help that used to be reachable only through its aria-label — and
 * the six are a list on the page's own ground, not six outlined boxes. The palette is its own
 * pane with its own scroller, so a short window scrolls the list rather than cutting it.
 *
 * AND IT GETS OUT OF THE WAY. `compact` is the palette as a 48px strip of the same six
 * controls, glyph only, each still a `Button` that is still `draggable` and still named in
 * full — so nothing is lost but the width, which the shell hands to the canvas when the window
 * is narrow (audit 3.1.10: the canvas was 106px wide at 1024). The name box moves into a
 * popover on the strip's first control, because a strip has no room for a sentence and the
 * name is still asked BEFORE the step exists.
 */

import { PencilLine } from "lucide-react";
import { STEP_KINDS, nextNodeId, type PaletteKind } from "@/lib/spec-draft";
import { freeSpotNear } from "@/lib/layout";
import { specFlowEdges } from "../../../core/graph-spec";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover } from "@/components/ui/popover";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { Separator } from "@/components/ui/separator";
import { Tooltip } from "@/components/ui/tooltip";
import type { Draft } from "@/lib/spec-draft";
import type { Point } from "../../../core/graph-spec";
import { STEP_KIND_MIME, useCanvasCentre } from "./canvas";
import { KIND_ICON } from "./node-card";

export function Palette({ draft, name, onName, onAdd, compact = false }: {
  draft: Draft;
  /** what the NEXT step will be called — lifted to the shell, because a drop starts here and
   *  lands on the canvas, and both gestures have to read the same box */
  name: string;
  onName: (name: string) => void;
  onAdd: (kind: PaletteKind, at?: Point) => void;
  /** the 48px strip: the same six controls and the same name box, without the words */
  compact?: boolean;
}) {
  const centre = useCanvasCentre();
  // the id the step WILL get, seeded with the RAW name and nothing else, because the add does
  // too: a second fallback here and a different one there is how an emptied box came to
  // preview one id and create another (HOW-26)
  const preview = nextNodeId(draft.spec, name);

  const naming = (
    <>
      <Label>
        What is the next step called?
        <Input
          value={name} placeholder="Implement the change"
          aria-label="what the next step is called"
          onChange={(e) => onName(e.target.value)}
        />
      </Label>
      <div className="field-hint">
        The name becomes the step's id: <code>{preview}</code>. It is fixed once the step exists.
      </div>
    </>
  );

  /** what both spellings of an item share: the two gestures, and the one name that says both */
  const gestures = (k: (typeof STEP_KINDS)[number]) => ({
    draggable: true,
    "aria-label": `${k.label} — ${k.help} Drag it onto the canvas, or press Enter to drop it in the middle.`,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(STEP_KIND_MIME, k.kind);
      e.dataTransfer.effectAllowed = "copy";
    },
    // an unmeasured pane answers `undefined`, and `add-step` places it below everything —
    // which is the right answer to "we do not know what is on screen"
    // clear of every card AND every wire; the canvas pans to it if that is off screen (D21)
    onClick: () => onAdd(k.kind, freeSpotNear(draft.spec.nodes, centre(), { edges: specFlowEdges(draft.spec) })),
  });

  if (compact) {
    return (
      <ScrollPane label="Add a step" className="flex flex-col items-center gap-1 px-2 py-2">
        <Popover
          side="right" title="Name the next step"
          trigger={
            <Button variant="ghost" size="icon" aria-label={`Name the next step — it will be ${preview}`}><PencilLine /></Button>
          }
        >
          {naming}
        </Popover>
        <Separator className="my-1" />
        {STEP_KINDS.map((k) => {
          const Icon = KIND_ICON[k.kind];
          return (
            <Tooltip key={k.kind} side="right" content={<span><strong className="font-semibold">{k.label}.</strong> {k.help}</span>}>
              <Button variant="ghost" size="icon" className="cursor-grab active:cursor-grabbing" {...gestures(k)}><Icon /></Button>
            </Tooltip>
          );
        })}
      </ScrollPane>
    );
  }

  return (
    <ScrollPane label="Add a step" className="flex flex-col gap-3 p-3">
      <SectionLabel as="h2">Add a step</SectionLabel>
      {naming}
      <div className="flex flex-col gap-0.5">
        {STEP_KINDS.map((k) => {
          const Icon = KIND_ICON[k.kind];
          return (
            <Button
              key={k.kind}
              variant="ghost"
              className="h-auto w-full cursor-grab items-start justify-start gap-2 whitespace-normal px-2 py-1.5 text-left font-normal active:cursor-grabbing"
              {...gestures(k)}
            >
              <Icon aria-hidden className="mt-0.5 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-foreground">{k.label}</span>
                <span className="text-xs text-muted-foreground">{k.help}</span>
              </span>
            </Button>
          );
        })}
      </div>
      <div className="field-hint">
        Drag one onto the canvas, or press it to drop it in the middle. Join two steps by
        dragging from a dot on one card's edge to the next card.
      </div>
    </ScrollPane>
  );
}
