/**
 * The needs-input surface, one file (HOW-16 P1): the Ask card, the Question card (HOW-25),
 * the Effect card (HOW-3), the harness-login escape hatch the Ask card sometimes carries, and
 * the rule for reading WHY a step parked out of its turn.
 *
 * Which card a park gets is decided HERE, by `StandingAsk`, and nowhere else (HOW-27). It used
 * to be the caller's choice, and the two callers disagreed: the Chat pane dispatched on the
 * ask's own kind, while the Steps pane rendered `AskCard` unconditionally at both of its call
 * sites. So a run parked on an `AskUserQuestion` showed the full question — its options, their
 * descriptions, single- or multi-select — in Chat, and a bare "your reply" textarea in Steps.
 * That is exactly the defect HOW-25 was filed to fix, still live in the other pane, and a
 * second caller was always going to re-introduce it. One dispatcher means a new park kind is
 * added in one place and every pane gets it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, Send } from "lucide-react";
import type { RunDetail } from "../../derive";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
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
  // An un-finalized turn is the normal state of a question park (HOW-27): the mid-turn ask
  // holds the session open on purpose while `awaitOperator` waits, so there is no
  // `turn-finalized` yet and nothing has stopped. Reporting it printed a red "The agent stopped
  // before finalizing its turn." at the top of the very card that was asking the question.
  // HOW-46: and since then the read model decides it once, for every pane: only a turn derived
  // `died` is one the agent stopped inside. A mid-turn ask of either kind derives `waiting`.
  if (detail.turn_states[`${turn.node}@${turn.visit}`] === "died") return "The agent stopped before finalizing its turn.";
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

/**
 * An MCP server behind codex asking the OPERATOR to go somewhere (captured: the ChatGPT Linear
 * connector's "reconnect me" link; engine/executors/codex.ts answerElicitation). The park's
 * reason already quotes the message and the URL; this makes the link a link and says what a
 * reply does, because "done" and "decline" mean different wire answers here.
 */
function elicitationAsk(ask: NonNullable<RunDetail["ask"]>): { server: string; url?: string } | null {
  const a = ask.ask as { kind?: unknown; server?: unknown; url?: unknown } | null | undefined;
  if (!a || a.kind !== "mcp-elicitation") return null;
  return { server: typeof a.server === "string" ? a.server : "the MCP server", ...(typeof a.url === "string" ? { url: a.url } : {}) };
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
  const elicitation = elicitationAsk(ask);

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
      {elicitation && (
        <div className="field-hint">
          {elicitation.url && <><a className="pr-link" href={elicitation.url} target="_blank" rel="noreferrer">Open {elicitation.server}'s link</a>, do what it asks, then </>}
          send an empty reply or "done" to let the agent continue. Reply "decline" to refuse — the tool call fails and the agent carries on without it.
        </div>
      )}
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
 * HOW-25 — the card for a question the agent is asking the OPERATOR, and the reason that
 * ticket exists. Before it, a question parked as "AskUserQuestion needs permission" and drew
 * a bare text box: the question, its options and their descriptions were all in the log and
 * none of them were on screen, so the only way to answer was to guess what was being asked.
 *
 * HOW-27 keeps every one of those guarantees and changes only the SHAPE of the asking, because
 * the flat all-questions-at-once form was the thing that did not read like the CLIs this
 * viewer is judged against. It is now `components/ui/questionnaire` — one question at a time,
 * the options numbered, `1`…`9` to choose, Enter to advance, Previous to go back, a progress
 * line saying where you are. That is Claude Code's own terminal behaviour, and it is a state
 * machine (ordered items, active item, per-item answered status, required-ness, shortcuts that
 * do not steal keys from a text field, `aria-keyshortcuts` on the right elements) worth
 * borrowing rather than hand-rolling.
 *
 * THE ANSWER STATE IS CONTROLLED, and that is not a style preference. `QuestionnaireInput`
 * joins the form under the ITEM's own field name — the same name the choices carry — as soon as
 * it becomes that item's selected answer, which is to say the moment the operator types in it.
 * `new FormData(form).getAll(id)` then returns picked labels and typed text indistinguishably,
 * while `validateAnswers` REFUSES a `selected` value that is not one of the question's own
 * option labels. Reading the form would therefore turn "something else" into a 400 exactly when
 * it was used. `picked`/`other` stay the source of truth and `FormData` is never read, which
 * also keeps free text able to contain anything — including something that reads like a label.
 *
 * NO SKIP CONTROL, deliberately. `validateAnswers` tolerates an untouched question, but a
 * question reaching the model unanswered is the freeze HOW-25 exists to fix, and the CLI does
 * not offer it either. Every item is `required`, and the primitive treats a filled free-text
 * box as satisfying it (`required && !multiple && !hasInputAnswer`), so "neither, do this
 * instead" is still a complete answer.
 *
 * Everything AskCard established is kept, because the run view depends on it: the
 * sending → delivered → collapsing lifecycle (the authored motion moment), a 409 shown
 * VERBATIM rather than collapsed into "failed", a toast beside the inline error, and
 * `id="needs-input"` so a notification's deep link lands on the control. A 400 is distinct: it
 * means this card sent something the park could not accept, which is a bug here rather than
 * something the operator can fix by retrying, so it says so.
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
  const card = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  // the deep link lands on the card; the questionnaire moves focus to the active item itself
  useEffect(() => { if (location.hash === "#needs-input") card.current?.focus(); }, []);

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

  /** what the primitive needs to know about the set: the order, and each item's own choices */
  const items = questions.map((q) => ({
    name: q.id,
    required: true,
    choices: q.options.map((o) => ({ value: o.label, disabled: busy })),
  }));

  return (
    <div
      ref={card}
      tabIndex={-1}
      className={`ask-card ${state === "delivered" ? "collapsing" : ""}`}
      id="needs-input"
    >
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <Questionnaire
        items={items}
        shortcuts="numbers"
        onSubmit={(e) => { e.preventDefault(); if (answers.length > 0 && !busy) void send(); }}
      >
        {questions.length > 1 && <QuestionnaireProgress />}
        {questions.map((q) => (
          <QuestionnaireItem key={q.id} name={q.id} required multiple={q.multiSelect}>
            <div className="auq-header">{q.header}</div>
            <QuestionnaireTitle>{q.question}</QuestionnaireTitle>
            {q.options.length > 0 && (
              <QuestionnaireChoices>
                {q.options.map((o) => (
                  <QuestionnaireChoice
                    key={o.label}
                    value={o.label}
                    disabled={busy}
                    checked={(picked[q.id] ?? []).includes(o.label)}
                    onChange={() => toggle(q, o.label)}
                  >
                    <span>{o.label}</span>
                    {o.description && (
                      <QuestionnaireChoiceDescription className="text-xs">
                        {o.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            )}
            <QuestionnaireInput
              aria-label={`other answer for ${q.header}`}
              value={other[q.id] ?? ""}
              disabled={busy}
              onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
              placeholder={q.options.length ? "Something else…" : "Your answer…"}
            />
            <QuestionnaireError />
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <QuestionnairePrevious variant="outline" size="sm">Back</QuestionnairePrevious>
          <QuestionnaireNext size="sm">Next</QuestionnaireNext>
          <QuestionnaireSubmit size="sm" disabled={busy || answers.length === 0}>
            <Send />{state === "sending" ? "Sending…" : state === "delivered" ? "Delivered" : "Answer"}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
      {answers.length === 0 && state === "idle" && (
        <span className="send-state">pick an option or type an answer</span>
      )}
      {state === "failed" && (
        <span className="send-state">
          failed — <Button variant="link" size="inline" onClick={send}>retry</Button>
        </span>
      )}
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

/**
 * HOW-69 — a park a reply cannot answer. The operator saw a command node (`probe:pr`) park on
 * "forge unreachable", drew the reply box, typed into it, and got back a refusal the server had
 * known all along: a command node has no prompt to carry a reply. So whether the box is drawn
 * is now the READ MODEL's answer (`detail.ask_reply`, engine/control.ts replyVerdict — the very
 * function the reply route runs), never a rule re-derived here. This card draws no composer:
 * it says why, quoting the route's refusal VERBATIM, and offers the action that does work.
 * Where the refusal's own remedy is "fix the cause, then resume" that is "Retry this step" —
 * the same POST the run's Resume button makes — with AskCard's sending → delivered →
 * collapsing moment and `id="needs-input"`, so a notification's deep link still lands here.
 * Every other refusal (approval, routing, acceptance) already names its verb in the text.
 */
export function NoReplyCard({ runId, ask, detail, refusal, retry, onResolved }: {
  runId: string;
  ask: NonNullable<RunDetail["ask"]>;
  detail: RunDetail;
  refusal: string;
  retry: boolean;
  onResolved: () => void;
}) {
  const [state, setState] = useState<"idle" | "sending" | "delivered" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const context = attentionContext(detail, ask);

  const resume = useCallback(async () => {
    setState("sending");
    setError(null);
    try {
      const r = await fetch(`/api/runs/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        const why = body.error ?? `resume failed (${r.status})`;
        setError(why);
        setState("failed");
        toast(why, "error");
        return;
      }
      setState("delivered");
      toast(`retrying ${ask.node}@${ask.visit}`);
      setTimeout(onResolved, 420); // the collapse plays, then the thread takes over — the motion moment
    } catch {
      setError("the retry did not reach the runner");
      setState("failed");
      toast("the retry did not reach the runner", "error");
    }
  }, [runId, onResolved, toast, ask.node, ask.visit]);

  return (
    <div className={`ask-card ${state === "delivered" ? "collapsing" : ""}`} id="needs-input">
      <h3>Needs you — {ask.node}@{ask.visit}</h3>
      <div>{ask.reason}</div>
      {context && <div className="field-error">{context}</div>}
      <div className="field-hint">
        {retry
          ? "A reply can't help here — this step has no agent to read one. Fix the cause if there is one, then retry the step."
          : "A reply can't move this run. Here is what can:"}
      </div>
      <div className="send-state no-reply-why">{refusal}</div>
      {retry && (
        <div className="actions">
          <Button onClick={resume} disabled={state === "sending" || state === "delivered"}>
            <RotateCcw />{state === "sending" ? "Retrying…" : state === "delivered" ? "Retry requested" : "Retry this step"}
          </Button>
          {state === "failed" && (
            <span className="send-state">
              failed — <Button variant="link" size="inline" onClick={resume}>retry</Button>
            </span>
          )}
        </div>
      )}
      {state === "failed" && error && <div className="send-state" role="alert">{error}</div>}
    </div>
  );
}

/**
 * The park, drawn as whatever it actually is. The ONE place that maps an ask to its card:
 * a question gets the question card, an ambiguous side effect gets the effect card, a park a
 * reply would be refused for gets the no-reply card (HOW-69), and everything else is answered
 * in prose. Every pane that shows a standing ask calls this.
 */
export function StandingAsk({ runId, detail, ask, onResolved }: {
  runId: string;
  detail: RunDetail;
  ask: NonNullable<RunDetail["ask"]>;
  onResolved: () => void;
}) {
  // `ask_questions` is the read model's own answer to "is this a question park", parsed once
  // by core/ask.ts — not re-derived here, and not guessed from the reason text
  if (detail.ask_questions && detail.ask_questions.length > 0 && askIsCurrent(detail, ask))
    return <AskQuestionCard runId={runId} ask={ask} questions={detail.ask_questions} onResolved={onResolved} />;
  if (ask.code === "ambiguous-effect")
    return <EffectCard runId={runId} ask={ask} effects={detail.ambiguous_effects} onResolved={onResolved} />;
  // HOW-69: the read model already knows whether the reply route would accept a reply to THIS
  // park; where it would not, drawing the box only invites a refusal
  const verdict = detail.ask_reply;
  if (verdict && !verdict.accept && askIsCurrent(detail, ask))
    return <NoReplyCard runId={runId} ask={ask} detail={detail} refusal={verdict.message} retry={verdict.retry} onResolved={onResolved} />;
  return <AskCard runId={runId} ask={ask} detail={detail} onResolved={onResolved} />;
}

/**
 * `detail.ask_questions` is derived from the run's CURRENT park. The Steps pane can hand this
 * a different ask than that one (a rowless park, or a step other than the parked step), and
 * answering a question card built from someone else's questions would post answers the park
 * cannot accept — a 400 the operator did not cause. So the question card is used only when the
 * ask being drawn IS the current park.
 */
function askIsCurrent(detail: RunDetail, ask: NonNullable<RunDetail["ask"]>): boolean {
  const cur = detail.ask;
  return cur !== null && cur !== undefined && cur.node === ask.node && cur.visit === ask.visit && cur.seq === ask.seq;
}
