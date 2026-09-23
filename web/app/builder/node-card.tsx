/**
 * One step, as a card on the canvas (HOW-24).
 *
 * It says exactly what the wizard's list row said — glyph, title, one line of what the step
 * actually does — because those words are now ALSO the box in the picture, and a step that
 * reads one way in a list and another in the graph is two steps to the operator. `GLYPH` and
 * `stepSummary` live here for that reason: this is the surface that describes a step now, and
 * the properties panel imports them rather than restating them.
 *
 * Two things the card is, rather than says:
 *
 *   A TERMINAL HAS NO SOURCE HANDLE. "Nothing can follow a Finish step" is a `Graph.validate()`
 *   refusal and a `specProblems` sentence; here it is a wire you cannot start, which is better
 *   than being told afterwards.
 *
 *   THE WAY IN IS A BUTTON. The card is dragged, and a drag target is not a control — so
 *   selecting a step for editing is a real `Button` with its own name, reachable by Tab and
 *   activated by Enter (D7). `nodrag` is React Flow's own opt-out, so pressing it never starts
 *   a drag.
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CircleAlert } from "lucide-react";
import type { GraphSpec, NodeSpec } from "../../../core/graph-spec";
import { STEP_KINDS, type StepKind } from "@/lib/spec-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** the same glyph vocabulary the DAG draws with, so the canvas and the picture agree */
export const GLYPH: Record<StepKind, string> = {
  agent: "◆", command: "▮", worktree: "⎇", wait: "◔", approval: "✓", terminal: "●",
};

export const KIND_LABEL: Record<StepKind, string> = Object.fromEntries(
  STEP_KINDS.map((k) => [k.kind, k.label]),
) as Record<StepKind, string>;

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
    case "terminal":
      return `the run ends ${n.outcome}${n.label ? ` — ${n.label}` : ""}`;
  }
}

/** What `specToFlow` hangs on each React Flow node — everything the card draws, precomputed. */
export interface StepNodeData extends Record<string, unknown> {
  title: string;
  kind: StepKind;
  summary: string;
  isEntry: boolean;
  problems: number;
  onOpen: () => void;
}

export function StepNode({ data, selected }: NodeProps & { data: StepNodeData }) {
  const { title, kind, summary, isEntry, problems } = data;
  return (
    <div
      className={`gb-node kind-${kind} ${selected ? "selected" : ""} ${problems ? "needs-input" : ""}`}
      data-testid="gb-node"
      data-kind={kind}
    >
      {/* an entry step is still a target: a loop back to the start is an ordinary route */}
      <Handle type="target" position={Position.Top} />
      <div className="gb-node-head">
        <span className="gb-node-glyph" aria-hidden>{GLYPH[kind]}</span>
        <Button
          variant="ghost" size="sm" className="gb-node-open nodrag"
          aria-label={`Edit ${title} — ${KIND_LABEL[kind]}${problems ? `, ${problems} to sort out` : ""}`}
          onClick={data.onOpen}
        >
          {title}
        </Button>
        {problems > 0 && (
          <Badge variant="attention" className="ml-auto"><CircleAlert size={11} />{problems}</Badge>
        )}
      </div>
      <span className="gb-node-sub">{summary}</span>
      {isEntry && <Badge variant="outline" className="gb-node-entry">starts here</Badge>}
      {kind !== "terminal" && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}
