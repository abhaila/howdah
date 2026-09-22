/**
 * Step 3 of the builder (HOW-22): the steps, in order.
 *
 * The order here is the builder's spine — it is what `nodes` being an ARRAY buys (see
 * core/graph-spec.ts). It is NOT the order the graph runs in: that is decided by Branching,
 * and the picture beside the rail is the honest reading of it. So this pane says what it is:
 * a list you keep in a sensible order for your own sake, with one row per step and every
 * problem that step owns printed under it, rather than saved up for the end.
 *
 * Adding a step is six buttons, not a dropdown of node kinds, because the kind IS the
 * decision and a menu would hide five of the six answers behind a click.
 */
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import type { GraphSpec, NodeSpec, SpecProblem } from "../../../core/graph-spec";
import { STEP_KINDS, newStep, type Draft, type DraftAction, type StepKind } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Row } from "@/components/ui/row";

/** the same glyph vocabulary the DAG draws with, so the list and the picture agree */
const GLYPH: Record<StepKind, string> = {
  agent: "◆", command: "▮", worktree: "⎇", wait: "◔", approval: "✓", terminal: "●",
};

const KIND_LABEL: Record<StepKind, string> = Object.fromEntries(
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

export function StepsPane({ draft, dispatch, problems, onOpen }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  /** only this pane's problems, already filtered by `where` */
  problems: SpecProblem[];
  onOpen: (id: string) => void;
}) {
  const { spec } = draft;
  const add = (kind: StepKind) => {
    const made = newStep(spec, kind, STEP_KINDS.find((k) => k.kind === kind)!.label);
    dispatch({ type: "add-step", ...made });
    onOpen(made.node.id);
  };
  const mine = (id: string) => problems.filter((p) => p.node === id);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>The steps</CardTitle>
          <CardDescription>
            What the run does, one step at a time. The order here is for your reading — what
            actually runs next is set in Branching, and the picture shows it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spec.nodes.length === 0 ? (
            <EmptyState>no steps yet — add one below</EmptyState>
          ) : (
            <div className="flex flex-col gap-1.5">
              {spec.nodes.map((n, i) => {
                const owned = mine(n.id);
                return (
                  <div key={n.id} className="builder-step">
                    <Row as="div" className="builder-step-head" needsInput={owned.length > 0}>
                      <span className="builder-glyph" aria-hidden>{GLYPH[n.kind]}</span>
                      <span className="flex flex-col">
                        <span className="builder-step-title">{n.title?.trim() || n.id}</span>
                        <span className="field-hint">{KIND_LABEL[n.kind]} · {stepSummary(spec, n)}</span>
                      </span>
                      {spec.entry === n.id && <Badge variant="outline">starts here</Badge>}
                      <span className="builder-step-actions">
                        <Button
                          variant="ghost" size="icon" aria-label={`move ${n.title || n.id} up`}
                          disabled={i === 0} onClick={() => dispatch({ type: "move-step", id: n.id, by: -1 })}
                        ><ArrowUp size={13} /></Button>
                        <Button
                          variant="ghost" size="icon" aria-label={`move ${n.title || n.id} down`}
                          disabled={i === spec.nodes.length - 1} onClick={() => dispatch({ type: "move-step", id: n.id, by: 1 })}
                        ><ArrowDown size={13} /></Button>
                        <Button variant="outline" size="sm" onClick={() => onOpen(n.id)}><Pencil size={13} />Edit</Button>
                        <Button
                          variant="ghost" size="icon" aria-label={`remove ${n.title || n.id}`}
                          onClick={() => dispatch({ type: "remove-step", id: n.id })}
                        ><Trash2 size={13} /></Button>
                      </span>
                    </Row>
                    {owned.map((p, j) => <div key={j} className="field-error builder-problem">{p.message}</div>)}
                  </div>
                );
              })}
            </div>
          )}
          <div className="builder-add">
            {STEP_KINDS.map((k) => (
              <Button key={k.kind} variant="outline" size="sm" onClick={() => add(k.kind)}>
                <Plus />{k.label}
              </Button>
            ))}
          </div>
          <div className="field-hint">
            A step id is fixed when it is added — the title is what you rename. That is because a
            run's history is written against the id (<code>step#visit</code>), and moving it would
            rewrite what already happened.
          </div>
        </CardContent>
      </Card>

      {problems.filter((p) => !p.node).map((p, i) => (
        <div key={i} className="field-error">{p.message}</div>
      ))}
    </div>
  );
}
