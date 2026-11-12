/**
 * HOW-78: the Plan tab — the first of the run's three homes (Plan → Build → Report).
 *
 * The plan is the step's own `implementation_plan`, drawn as a document, with the acceptance
 * contract that was opened from it underneath. The operator answers it in place, and that answer
 * GOES INTO THE BUILD through the two channels Howdah already has. No new event and no new route:
 *
 *   - while an agent turn is live on a harness that can be steered, a comment is a STEER to that
 *     turn (HOW-47) — the planner or the implementer reads it at its next tool call;
 *   - otherwise it is a JUMP back to `implementation.plan` carrying the comment as the jump's
 *     instruction, so the plan is rewritten with it and criteria → implement run on the new plan.
 *     "Edit the plan" is the same jump carrying the operator's own text as the plan to adopt.
 *
 * Which one a send will take is said beside the button before it is pressed, and a refusal from
 * either route ("runner is live — pause or abort first, then jump") is shown verbatim.
 *
 * HOW-68: the pane is ONE scroller holding a 720px reading column — the plan as a document on
 * the page's own ground (it was a card, with the criteria in a second card and the composer in
 * a third), then the acceptance list, then the answer box, which is the one held object here.
 * The Comment / Edit switch is a pair of toggle chips rather than two buttons trading variants.
 */
import { useState } from "react";
import { MessageSquarePlus, PencilLine, Send } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Markdown } from "@/components/ui/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { Chip } from "@/components/ui/chip";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { useToast } from "@/components/ui/toast";
import { AcceptanceCard } from "./acceptance";
import { steerableTurn } from "./progress";
import { fmtWhen } from "@/lib/format";

export const PLAN_KEY = "implementation_plan";
export const PLAN_NODE = "implementation.plan";

/** how a send from the Plan tab reaches the run — decided once, shown before it is pressed */
export type PlanRoute =
  | { kind: "steer"; node: string }
  | { kind: "jump" }
  | { kind: "closed"; why: string };

export function planRoute(detail: Pick<RunDetail, "summary" | "timeline" | "turn_states" | "renders">): PlanRoute {
  if (detail.summary.outcome !== null) return { kind: "closed", why: `the run has finished (${detail.summary.outcome})` };
  const live = steerableTurn(detail);
  if (live) return { kind: "steer", node: live.node };
  return { kind: "jump" };
}

/** the instruction a jump carries — the planner reads it as the operator's own words */
export function planInstruction(mode: "comment" | "edit", text: string): string {
  return mode === "edit"
    ? `The operator has edited your plan. Adopt the version below as the plan, changing it only where it contradicts the code, and say what you changed:\n\n${text}`
    : `The operator has commented on your plan. Revise the plan to address these comments:\n\n${text}`;
}

export function RunPlan({ runId, detail, onChanged }: { runId: string; detail: RunDetail; onChanged: () => void }) {
  const entry = detail.context.find((c) => c.key === PLAN_KEY);
  const plan = entry?.written && !entry.veiled && typeof entry.value === "string" ? entry.value : null;
  const writer = entry?.writes.at(-1);
  const [mode, setMode] = useState<"comment" | "edit">("comment");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  if (!entry) {
    return (
      <ScrollPane label="Plan" className="plan-pane">
        <EmptyState title="No plan">This run's graph has no planning step, so there is no plan to review. The Build tab has everything it did.</EmptyState>
      </ScrollPane>
    );
  }
  const route = planRoute(detail);
  const send = async () => {
    const body = text.trim();
    if (!body || route.kind === "closed") return;
    setBusy(true);
    setError(null);
    try {
      const r = route.kind === "steer"
        ? await fetch(`/api/runs/${runId}/steer`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ node: route.node, text: mode === "edit" ? planInstruction("edit", body) : `About the plan: ${body}` }),
        })
        : await fetch(`/api/runs/${runId}/jump`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ node: PLAN_NODE, message: planInstruction(mode, body) }),
        });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "send failed");
      toast(route.kind === "steer" ? `Sent — ${route.node} reads it at its next tool call` : "Sent — the plan is being revised, then the build continues from it");
      setText("");
      setMode("comment");
      setTimeout(onChanged, 300);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      toast(why, "error");
    } finally {
      setBusy(false);
    }
  };

  const pickMode = (m: "comment" | "edit") => {
    if (m === mode) return;
    setMode(m);
    setText(m === "edit" ? plan ?? "" : "");
  };

  return (
    <ScrollPane label="Plan" className="plan-pane">
      <div className="plan-column">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="m-0 text-xl font-semibold text-foreground">The plan</h2>
          {writer && (
            <span className="text-xs text-muted-foreground">
              written by <span className="font-mono">{writer.node}@{writer.visit}</span> · {fmtWhen(writer.at)}
            </span>
          )}
        </header>
        {plan
          ? <Markdown className="plan-doc" text={plan} />
          : <p className="m-0 text-body text-muted-foreground">{entry.veiled ? "The plan is being rewritten." : "The plan has not been written yet."} It appears here as soon as the planning step publishes it.</p>}

        {detail.acceptance && <AcceptanceCard runId={runId} detail={detail} onChanged={onChanged} />}

        <section className="plan-compose" aria-label="answer the plan">
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel as="h3">Answer the plan</SectionLabel>
            <span className="ml-auto flex gap-1" role="group" aria-label="How to answer">
              <Chip on={mode === "comment"} onClick={() => pickMode("comment")}><MessageSquarePlus size={14} aria-hidden />Comment</Chip>
              <Chip on={mode === "edit"} disabled={!plan} onClick={() => pickMode("edit")}><PencilLine size={14} aria-hidden />Edit the plan</Chip>
            </span>
          </div>
          <Textarea
            aria-label={mode === "edit" ? "the plan, edited" : "your comment on the plan"}
            placeholder={mode === "edit" ? "" : "What should change? For example: keep the old endpoint and add a flag instead."}
            value={text}
            rows={mode === "edit" ? 14 : 3}
            mono={mode === "edit"}
            disabled={route.kind === "closed"}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="plan-route min-w-0 flex-1 basis-60 text-sm text-muted-foreground">
              {route.kind === "steer" && <>Goes to <span className="font-mono text-foreground">{route.node}</span> at its next tool call.</>}
              {route.kind === "jump" && <>Sends the run back to <span className="font-mono text-foreground">{PLAN_NODE}</span> with this, then the build continues from the revised plan.</>}
              {route.kind === "closed" && <>Nothing to send to — {route.why}.</>}
            </span>
            <Button size="sm" loading={busy} disabled={!text.trim() || route.kind === "closed"} onClick={send}>
              {!busy && <Send aria-hidden />}
              {mode === "edit" ? "Send the edited plan" : "Send comment"}
            </Button>
          </div>
          {error && <div className="field-error">{error}</div>}
        </section>
      </div>
    </ScrollPane>
  );
}
