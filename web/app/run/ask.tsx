/**
 * The needs-input surface, one file (HOW-16 P1): the Ask card, the Question card (HOW-25),
 * the Effect card (HOW-3), the harness-login escape hatch the Ask card sometimes carries, and
 * the rule for reading WHY a step parked out of its turn. Which card a park gets is the
 * caller's choice, not this file's — it is decided by `ask.kind` where the cards are drawn.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { submitOnEnter } from "@/lib/keys";
import { useToast } from "@/components/ui/toast";

export function attentionContext(detail: RunDetail, ask: NonNullable<RunDetail["ask"]>): string | null {
  const turn = detail.turns.findLast((t) => t.node === ask.node && t.visit === ask.visit);
  if (!turn) return null;
  const text = turn.parts.filter((p) => p.kind === "text").map((p) => p.content).join("");
  const markers = [...text.matchAll(/\[(attempt failed|output contract violation): ([^\]]+)\]/g)];
  const marker = markers.at(-1);
  if (marker) return `${marker[1]}: ${marker[2]}`;
  const failedTool = turn.parts.findLast((p) => p.kind === "tool_result" && /error|failed|exit \d|denied|no such file/i.test(p.content));
  if (failedTool) return failedTool.content.trim().slice(0, 1200);
  if (!turn.finalized) return "The agent stopped before finalizing its turn.";
  return null;
}

/**
 * The one park the operator cannot answer by typing: the harness CLI is not logged in. Agent
 * nodes run `claude -p` / `codex app-server`, which have no TTY, so there is no session to
 * log into from here. This opens a real terminal in the run's own folder with the login
 * command ready, and always shows the command too, because the terminal only opens on macOS
 * and a copyable command is never wrong.
 *
 * The harness name comes from the node's own `prompt-rendered` event rather than from parsing
 * the park reason — the reason is prose, the render is the record of which harness ran.
 */
export function HarnessLogin({ runId, ask, detail }: { runId: string; ask: NonNullable<RunDetail["ask"]>; detail: RunDetail }) {
  const [result, setResult] = useState<{ command: string; error?: string } | null>(null);
  const harness = detail.renders.find((r) => r.node === ask.node && r.visit === ask.visit)?.harness ?? "claude";
  const open = async () => {
    try {
      const r = await fetch(`/api/runs/${runId}/harness-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ harness }),
      });
      const body = (await r.json().catch(() => ({}))) as { command?: string; error?: string };
      setResult({ command: body.command ?? `${harness} login`, error: r.ok ? undefined : body.error });
    } catch (e) {
      setResult({ command: `${harness} login`, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="field-hint">
      <div className="actions">
        <Button variant="outline" size="sm" onClick={open}>Open a terminal to log in</Button>
      </div>
      {result && (
        <div>
          {result.error ? `${result.error} — run: ` : "Opened a terminal. Run: "}
          <code>{result.command}</code>
        </div>
      )}
      <div>Once you are logged in, send a reply (empty is fine) or resume the run to retry this step.</div>
    </div>
  );
}

export function AskCard({ runId, ask, detail, onResolved }: { runId: string; ask: NonNullable<RunDetail["ask"]>; detail: RunDetail; onResolved: () => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "delivered" | "failed" | "refused">("idle");
  // a refusal (409) names the verb that WILL work for this park (system-map 0.2) — show it,
  // never collapse it into a generic "failed"
  const [refusal, setRefusal] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  useEffect(() => { if (location.hash === "#needs-input") ref.current?.focus(); }, []);
  const context = attentionContext(detail, ask);

  const send = useCallback(async () => {
    setState("sending");
    try {
      const r = await fetch(`/api/runs/${runId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (r.status === 409) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        const why = body.error ?? "This park can't take a reply.";
        setRefusal(why);
        setState("refused");
        toast(why, "error");
        return;
      }
      if (!r.ok) throw new Error(await r.text());
      setState("delivered");
      toast(`reply delivered to ${ask.node}@${ask.visit}`);
      setTimeout(onResolved, 420); // the collapse plays, then the thread takes over — the motion moment
    } catch {
      setState("failed");
      toast("the reply did not reach the runner", "error");
    }
  }, [runId, text, onResolved, toast, ask.node, ask.visit]);

  return (
    <div className={`ask-card ${state === "delivered" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      {context && (
        <div className="field-error">
          {context}
        </div>
      )}
      {ask.code === "harness-unauthenticated" && <HarnessLogin runId={runId} ask={ask} detail={detail} />}
      {(ask.code === "attempt-failed" || ask.reason === "attempt failed") && (
        <div className="field-hint">Reply with instructions to change the retry, or send an empty reply to retry the step as-is.</div>
      )}
      <Textarea
        ref={ref}
        aria-label="your reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={submitOnEnter(() => void send(), { enabled: state !== "sending" && state !== "delivered" })}
        placeholder="Your reply… (Enter to send, Shift+Enter for a new line)"
        disabled={state === "sending" || state === "delivered"}
      />
      <div className="actions">
        <Button onClick={send} disabled={state === "sending" || state === "delivered"}>
          <Send />{state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Reply"}
        </Button>
        {state === "failed" && (
          <span className="send-state">
            failed — <Button variant="link" size="inline" onClick={send}>retry</Button>
          </span>
        )}
      </div>
      {state === "refused" && refusal && <div className="send-state" role="alert">{refusal}</div>}
    </div>
  );
}


/**
 * HOW-25 — the card for a question the agent is asking the OPERATOR, and the reason this
 * ticket exists. Before it, a question parked as "AskUserQuestion needs permission" and drew
 * a bare text box: the question, its options and their descriptions were all in the log and
 * none of them were on screen, so the only way to answer was to guess what was being asked.
 *
 * It renders the ask as itself — one group per question, the header as the label, every
 * option with its own description, single- or multi-select exactly as the asking tool
 * declared — plus a free-text box, because "neither, do this instead" is a real answer and
 * the harness accepts it.
 *
 * Everything AskCard established is kept, because the run view depends on it: the
 * sending → delivered → collapsing lifecycle (the authored motion moment), a 409 shown
 * VERBATIM rather than collapsed into "failed", a toast beside the inline error, and
 * `id="needs-input"` so a notification's deep link lands on the control. A 400 is new and
 * distinct: it means this card sent something the park could not accept, which is a bug here
 * rather than something the operator can fix by retrying, so it says so.
 */
export function AskQuestionCard({ runId, ask, questions, onResolved }: {
  runId: string;
  ask: NonNullable<RunDetail["ask"]>;
  questions: NonNullable<RunDetail["ask_questions"]>;
  onResolved: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "delivered" | "failed" | "refused">("idle");
  const [refusal, setRefusal] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  useEffect(() => { if (location.hash === "#needs-input") first.current?.focus(); }, []);

  const toggle = (q: (typeof questions)[number], label: string) =>
    setPicked((p) => {
      const was = p[q.id] ?? [];
      if (!q.multiSelect) return { ...p, [q.id]: was[0] === label ? [] : [label] };
      return { ...p, [q.id]: was.includes(label) ? was.filter((l) => l !== label) : [...was, label] };
    });

  // the same shape core/ask.ts validateAnswers accepts — a question nobody touched is left out
  const answers = questions.flatMap((q) => {
    const selected = picked[q.id] ?? [];
    const text = (other[q.id] ?? "").trim();
    if (selected.length === 0 && text === "") return [];
    return [{ id: q.id, selected, ...(text ? { other: text } : {}) }];
  });

  const send = useCallback(async () => {
    setState("sending");
    setRefusal(null);
    try {
      const r = await fetch(`/api/runs/${runId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (r.status === 409 || r.status === 400) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        const why = body.error ?? "This park can't take this answer.";
        setRefusal(why);
        setState("refused");
        toast(why, "error");
        return;
      }
      if (!r.ok) throw new Error(await r.text());
      setState("delivered");
      toast(`answer delivered to ${ask.node}@${ask.visit}`);
      setTimeout(onResolved, 420); // the collapse plays, then the thread takes over
    } catch {
      setState("failed");
      toast("the answer did not reach the runner", "error");
    }
  }, [runId, answers, onResolved, toast, ask.node, ask.visit]);

  const busy = state === "sending" || state === "delivered";
  return (
    <div className={`ask-card ${state === "delivered" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      {questions.map((q, qi) => (
        <div key={q.id} className="auq-group" role="group" aria-label={q.header}>
          <div className="auq-header">{q.header}</div>
          <div className="auq-question">{q.question}</div>
          {q.options.length > 0 && (
            <div className="auq-options">
              {q.options.map((o, oi) =>
                q.multiSelect ? (
                  <div key={o.label} className="auq-option">
                    <Checkbox
                      label={o.label}
                      checked={(picked[q.id] ?? []).includes(o.label)}
                      disabled={busy}
                      onChange={() => toggle(q, o.label)}
                    />
                    {o.description && <div className="auq-desc">{o.description}</div>}
                  </div>
                ) : (
                  <div key={o.label} className="auq-option">
                    <Button
                      ref={qi === 0 && oi === 0 ? first : undefined}
                      variant={(picked[q.id] ?? []).includes(o.label) ? "default" : "outline"}
                      size="sm"
                      disabled={busy}
                      aria-pressed={(picked[q.id] ?? []).includes(o.label)}
                      onClick={() => toggle(q, o.label)}
                    >
                      {o.label}
                    </Button>
                    {o.description && <div className="auq-desc">{o.description}</div>}
                  </div>
                ),
              )}
            </div>
          )}
          <Textarea
            aria-label={`other answer for ${q.header}`}
            value={other[q.id] ?? ""}
            disabled={busy}
            onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
            placeholder={q.options.length ? "Something else…" : "Your answer…"}
          />
        </div>
      ))}
      <div className="actions">
        <Button onClick={send} disabled={busy || answers.length === 0}>
          <Send />{state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Answer"}
        </Button>
        {answers.length === 0 && state === "idle" && <span className="send-state">pick an option or type an answer</span>}
        {state === "failed" && (
          <span className="send-state">
            failed — <Button variant="link" size="inline" onClick={send}>retry</Button>
          </span>
        )}
      </div>
      {state === "refused" && refusal && <div className="send-state" role="alert">{refusal}</div>}
    </div>
  );
}

/**
 * HOW-3: the viewer half of `howdah resolve-effect`. A run parks on `ambiguous-effect` when
 * an effect was claimed but never proven done and the resume probe could not decide — the
 * human is the only source of truth about the outside world ("yes, the PR was published").
 * Each verdict is spelled out with its consequence, because the two are not symmetric: one
 * skips the step forever, the other runs it again.
 *
 * A 409 names what to do instead (a live runner, an effect already resolved the other way)
 * and is shown VERBATIM, never collapsed into a generic failure — the same rule as AskCard.
 *
 * HOW-16 keeps that contract and only changes the surfaces: the verdicts are Buttons whose
 * variants carry the asymmetry (the default is the one that skips work, the outline the one
 * that redoes it), the outcome is announced through a toast as well as shown, and the row
 * reads as a labelled group instead of three loose divs.
 */
export function EffectCard({
  runId,
  ask,
  effects,
  onResolved,
}: {
  runId: string;
  ask: NonNullable<RunDetail["ask"]>;
  effects: RunDetail["ambiguous_effects"];
  onResolved: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "recorded" | "failed">("idle");
  const [refusal, setRefusal] = useState<string | null>(null);
  const { toast } = useToast();

  const resolve = useCallback(
    async (effect: { node: string; effect: string }, verdict: "happened" | "not-happened") => {
      setState("sending");
      setRefusal(null);
      try {
        const r = await fetch(`/api/runs/${runId}/effects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ effect: effect.effect, verdict, node: effect.node }),
        });
        if (r.status === 409) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          const why = body.error ?? "This effect can't be resolved.";
          setRefusal(why);
          setState("idle"); // the verdicts stay usable — the refusal names what to do first
          toast(why, "error");
          return;
        }
        if (!r.ok) throw new Error(await r.text());
        setState("recorded");
        toast(`${effect.effect} recorded as ${verdict === "happened" ? "already done" : "not done"}`);
        setTimeout(onResolved, 420);
      } catch {
        setState("failed");
        toast("the verdict did not reach the run", "error");
      }
    },
    [runId, onResolved, toast],
  );

  const busy = state === "sending" || state === "recorded";
  return (
    <div className={`ask-card ${state === "recorded" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      <div className="field-hint">
        The step was interrupted after it started this work, and nothing proved whether it finished. Only you can say.
      </div>
      {effects.length === 0 ? (
        <div className="send-state">Recorded — waiting for the run to resume.</div>
      ) : (
        effects.map((e) => (
          <div key={`${e.node}\u0000${e.effect}`} className="effect-row" role="group" aria-label={`${e.effect} at ${e.node}@${e.visit}`}>
            <div>
              <code>{e.effect}</code> · {e.node}@{e.visit}
            </div>
            <div className="actions">
              <Button onClick={() => resolve(e, "happened")} disabled={busy}>
                It happened
              </Button>
              <Button variant="outline" onClick={() => resolve(e, "not-happened")} disabled={busy}>
                It didn't happen
              </Button>
            </div>
            <div className="field-hint">
              “It happened” skips this step's effect for good. “It didn't happen” runs it again on the retry.
            </div>
          </div>
        ))
      )}
      {state === "recorded" && <div className="send-state">Recorded — resuming…</div>}
      {state === "failed" && <div className="send-state" role="alert">failed — try again</div>}
      {refusal && <div className="send-state" role="alert">{refusal}</div>}
    </div>
  );
}
