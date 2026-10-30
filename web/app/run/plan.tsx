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
 */
import { useState } from "react";
import { FileText, Loader2, MessageSquarePlus, PencilLine, Send } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Markdown } from "@/components/ui/markdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { AcceptanceCard } from "./acceptance";
import { steerableTurn } from "./progress";

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
      <div className="plan-pane">
        <p className="plan-empty">This run's graph has no planning step, so there is no plan to review. The Build tab has everything it did.</p>
      </div>
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
      toast(route.kind === "steer" ? `sent — ${route.node} reads it at its next tool call` : "sent — the plan is being revised, then the build continues from it");
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

  return (
    <div className="plan-pane">
      <div className="plan-head">
        <FileText size={14} aria-hidden />
        <h2>The plan</h2>
        {writer && <span className="plan-meta">{writer.node}@{writer.visit} · {new Date(writer.at).toLocaleString()}</span>}
      </div>
      {plan
        ? <Markdown className="plan-doc" text={plan} />
        : <p className="plan-empty">{entry.veiled ? "The plan is being rewritten." : "The plan has not been written yet."} It appears here as soon as the planning step publishes it.</p>}

      {detail.acceptance && <AcceptanceCard runId={runId} detail={detail} onChanged={onChanged} />}

      <div className="plan-compose" aria-label="answer the plan">
        <div className="plan-modes">
          <Button variant={mode === "comment" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "comment"} onClick={() => { setMode("comment"); setText(""); }}>
            <MessageSquarePlus size={12} aria-hidden />Comment
          </Button>
          <Button variant={mode === "edit" ? "outline" : "ghost"} size="sm" aria-pressed={mode === "edit"} disabled={!plan} onClick={() => { setMode("edit"); setText(plan ?? ""); }}>
            <PencilLine size={12} aria-hidden />Edit the plan
          </Button>
        </div>
        <Textarea
          aria-label={mode === "edit" ? "the plan, edited" : "your comment on the plan"}
          placeholder={mode === "edit" ? "" : "What should change? e.g. \"keep the old endpoint; add a flag instead\""}
          value={text}
          rows={mode === "edit" ? 14 : 3}
          disabled={route.kind === "closed"}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="plan-send">
          <span className="plan-route">
            {route.kind === "steer" && <>Goes to <strong>{route.node}</strong> at its next tool call.</>}
            {route.kind === "jump" && <>Sends the run back to <strong>{PLAN_NODE}</strong> with this, then the build continues from the revised plan.</>}
            {route.kind === "closed" && <>Nothing to send to — {route.why}.</>}
          </span>
          <Button size="sm" disabled={busy || !text.trim() || route.kind === "closed"} onClick={send}>
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
            {mode === "edit" ? "Send the edited plan" : "Send comment"}
          </Button>
        </div>
        {error && <div className="field-error">{error}</div>}
      </div>
    </div>
  );
}
