/**
 * One step, as a card on the canvas (HOW-24, redrawn in HOW-68).
 *
 * It says exactly what the wizard's list row said — a glyph for the kind, what the step is
 * called, one line of what it actually does — because those words are now ALSO the box in the
 * picture, and a step that reads one way in a list and another in the graph is two steps to the
 * operator. `KIND_ICON` and `stepSummary` live here for that reason: this is the surface that
 * describes a step now, and the palette and the properties panel import them rather than
 * restating them.
 *
 * Two things the card is, rather than says:
 *
 *   A WIRE CANNOT START AT A TERMINAL. "Nothing can follow a Finish step" is a
 *   `Graph.validate()` refusal and a `specProblems` sentence; here its dots only receive
 *   (`isConnectableStart={false}`), which is better than being told afterwards.
 *
 *   THE WAY IN IS A BUTTON. The card is dragged, and a drag target is not a control — so
 *   selecting a step for editing is a real `Button` with its own name, reachable by Tab and
 *   activated by Enter (D7). `nodrag` is React Flow's own opt-out, so pressing it never starts
 *   a drag.
 *
 * HOW-68 (DESIGN.md). What changed is only what the card looks like:
 *
 *   ONE VOICE. The name and the summary were both mono, the summary at the old 10px step. A
 *   step's NAME is sans; mono is kept for the one thing on the card you would paste — its id —
 *   which is printed under a title that differs from it, and is the name itself when the step
 *   has no title. Nothing is under 12px, and the canvas no longer zooms out to fit, so that is
 *   12px on screen too (canvas.tsx).
 *
 *   AMBER IS NOT A PROBLEM COUNT. The count was the amber `attention` badge on an amber-tinted
 *   card, and amber means exactly one thing here: a RUN is waiting on you. A draft that will
 *   not save is not that. What blocks is the failure red, as a glyph AND a number; advice is a
 *   neutral glyph and a number, so it is findable on the picture without reading as a refusal.
 *
 *   SHAPE BEFORE COLOUR. The step a run starts at carries a "Start" tab with a play glyph on
 *   its top edge, and a Finish step is a dashed pill — neither is told apart by hue.
 *
 *   EVERY CUT IS READABLE. The three lines are `Truncate`, so a long name, id or summary shows
 *   in full on hover and on focus instead of ending in an ellipsis nobody can open.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Bot, CircleAlert, CircleStop, Clock, GitBranch, Lightbulb, Play, Split, SquareTerminal, UserCheck,
  type LucideIcon,
} from "lucide-react";
import type { GraphSpec, NodeSpec } from "../../../core/graph-spec";
import { STEP_KINDS, type StepKind } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";
import { Truncate } from "@/components/ui/truncate";
import { SIDES, type Side } from "./routing";

/** one glyph per kind of step — the palette, the card and the panel header all draw from here */
export const KIND_ICON: Record<StepKind, LucideIcon> = {
  agent: Bot, command: SquareTerminal, worktree: GitBranch, wait: Clock, approval: UserCheck, parallel: Split, terminal: CircleStop,
};

export const KIND_LABEL: Record<StepKind, string> = {
  ...(Object.fromEntries(STEP_KINDS.map((k) => [k.kind, k.label])) as Record<Exclude<StepKind, "parallel">, string>),
  // HOW-73: drawn and opened, never added from the palette
  parallel: "Run steps at once",
};

/** One line saying what this step actually does, in the same words its form uses. */
export function stepSummary(spec: GraphSpec, n: NodeSpec): string {
  switch (n.kind) {
    case "agent": {
      const produces = n.writes.length ? `produces ${n.writes.join(", ")}` : "produces nothing yet";
      return `${produces}${n.readOnly ? " · planning only" : ""}${n.requires ? ` · waits for ${n.requires}` : ""}`;
    }
    case "command":
      return `${n.run.split("\n")[0]?.slice(0, 48) || "nothing to run yet"}${n.writes.length ? ` → ${n.writes.join(", ")}` : ""}`;
    case "worktree":
      return n.action === "create" ? "makes a worktree on its own branch" : `cleans it up${n.writes.length ? ` → ${n.writes.join(", ")}` : ""}`;
    case "wait":
      return `pauses for ${n.duration}`;
    case "approval":
      return `you decide on ${n.proposal || "— nothing chosen yet"}${n.redesignTo ? ` · changes go back to ${n.redesignTo}` : ""}`;
    case "parallel":
      return `runs ${n.branches.join(", ") || "nothing yet"} at once (${Math.min(n.concurrency ?? n.branches.length, n.branches.length)} at a time) · then ${n.join || "—"}`;
    case "terminal":
      return `the run ends ${n.outcome}${n.label ? ` — ${n.label}` : ""}`;
  }
}

/** What `specToFlow` hangs on each React Flow node — everything the card draws, precomputed. */
export interface StepNodeData extends Record<string, unknown> {
  /** the step's id: what the run log, `node@visit` and its instructions file are named after */
  id: string;
  title: string;
  kind: StepKind;
  summary: string;
  isEntry: boolean;
  /** what BLOCKS a save, counted in the failure colour */
  problems: number;
  /** what is merely worth a second look, counted quietly */
  advice: number;
  /** the sides a route is attached to: their dots are always drawn, the others on approach */
  wired: Side[];
  onOpen: () => void;
}

const HANDLE_AT: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

export function StepNode({ data, selected }: NodeProps & { data: StepNodeData }) {
  const { id, title, kind, summary, isEntry, problems, advice, wired } = data;
  const Icon = KIND_ICON[kind];
  const named = title !== id;
  const counts = `${problems ? `, ${problems} to sort out` : ""}${advice ? `, ${advice} worth a second look` : ""}`;
  return (
    <div
      className={`gb-node kind-${kind} ${selected ? "selected" : ""} ${problems ? "needs-input" : ""}`}
      data-testid="gb-node"
      data-kind={kind}
    >
      {/* HOW-68: a dot on EVERY side, so a wire can leave towards wherever the next card is
          (routing.ts picks the pair per route). All four are `source` handles under the canvas's
          loose connection mode, which is what lets a drag start from any of them and end on any
          of another card's; the route still runs from the card the drag STARTED on. A Finish
          step's dots only receive: nothing can follow it, so a wire cannot be started there.
          An entry step is still a target: a loop back to the start is an ordinary route. */}
      {SIDES.map((side) => (
        <Handle key={side} id={side} type="source" position={HANDLE_AT[side]} className="gb-handle" isConnectableStart={kind !== "terminal"} data-wired={wired.includes(side) || undefined} />
      ))}
      {isEntry && (
        <span className="gb-node-entry">
          <Play aria-hidden className="size-3 fill-current" />Start
        </span>
      )}
      <div className="flex min-w-0 items-center gap-1">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <Button
          variant="ghost" size="sm"
          className="nodrag h-6 min-w-0 flex-1 justify-start px-1 text-base font-medium text-foreground"
          aria-label={`Edit ${title} — ${KIND_LABEL[kind]}${counts}`}
          onClick={data.onOpen}
        >
          <Truncate mono={!named}>{title}</Truncate>
        </Button>
        {problems > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold tabular-nums text-destructive">
            <CircleAlert aria-hidden className="size-3.5" />{problems}
          </span>
        )}
        {advice > 0 && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
            <Lightbulb aria-hidden className="size-3.5" />{advice}
          </span>
        )}
      </div>
      {named && <Truncate mono className="pl-[22px] text-xs text-faint">{id}</Truncate>}
      <Truncate className="pl-[22px] text-xs text-muted-foreground">{summary}</Truncate>
    </div>
  );
}
