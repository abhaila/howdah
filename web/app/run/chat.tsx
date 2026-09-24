/**
 * Chat — the central pane (HOW-25). One conversation: what each step was asked to do, what
 * the agent said and did, what it asked YOU, what you answered, and what the step published.
 *
 * The ticket this came from was filed because "we don't follow the normal chat flow" — a run
 * that asked a question had nowhere to show it, and the operator had to go hunting through
 * Steps for a park. So the question now appears where the conversation is, at the bottom of
 * the transcript, as the thing you are being asked.
 *
 * On the AI SDK suggestion in the ticket: `@shadcn/helpers`' `createChat()` is a mock
 * ChatTransport for demos, not a UI kit, and the chat COMPONENTS live in AI Elements, which
 * pulls Radix (ScrollArea, Collapsible, DropdownMenu, Tooltip) plus a markdown/syntax stack.
 * `No Radix, ever` is a load-bearing rule here, and `useChat` wants a UI-message-stream
 * endpoint, which an append-only run log is not and should not become — a transcript is a
 * REPLAYED LOG, not a live LLM conversation. What was worth taking is the MESSAGE-PARTS
 * shape, and howdah already had it: `log/coalesce.ts` TurnPart is text / thinking / tool_call
 * / tool_result. So the parts model is adopted and the dependency is not.
 *
 * Tool work is drawn by activity.tsx's `beatsOf` + `ToolBeat` — the same renderer the Steps
 * pane uses, not a second one, so a failed tool still opens itself here.
 *
 * Model output stays UNTRUSTED INPUT: the Ask mode's answers are matched against a whitelist
 * of this run's own node@visit keys and rendered as TEXT, never markup. That rule predates
 * this file's rewrite and is unchanged.
 */
import { useState } from "react";
import { Sparkles, FileOutput, UserRound, HelpCircle } from "lucide-react";
import { submitOnEnter } from "@/lib/keys";
import type { RunDetail } from "../../derive";
import { citeParts } from "../../cite";
import { beatsOf, ToolBeat } from "./activity";
import { AskCard, AskQuestionCard, EffectCard } from "./ask";
import { Chip } from "@/components/ui/chip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelTabs } from "@/components/ui/tabs";

export function suggestionsFor(detail: RunDetail, ask: RunDetail["ask"]): string[] {
  const out: string[] = [];
  if (ask) out.push("What is it waiting for?");
  const failed = detail.timeline.find((t) => t.status === "failed");
  if (failed) out.push(`Why did ${failed.node}@${failed.visit} fail?`);
  const rewritten = detail.context.find((c) => c.writes.length > 1);
  if (rewritten) out.push(`What changed in ${rewritten.key}?`);
  return out.slice(0, 3);
}

type ChatMode = "transcript" | "ask";

/** one message in the transcript — the parts model, in the order the run produced them */
export type ChatMessage =
  | { kind: "step"; key: string; node: string; visit: number; prompt: { id: string; version: number; read: string[] } | null }
  | { kind: "beats"; key: string; beats: ReturnType<typeof beatsOf>; unfinished: boolean }
  | { kind: "asked"; key: string; reason: string }
  | { kind: "answered"; key: string; text: string }
  | { kind: "wrote"; key: string; keys: string[] };

/**
 * Fold the read model into one ordered transcript. Pure and exported so the ordering is
 * testable without a DOM: everything it needs is already derived (`timeline`, `turns`,
 * `renders`, `log_rows`, `context`) — nothing here re-walks the log.
 *
 * Steps come in timeline order. Inside a step: the prompt that opened it, then what the agent
 * said and did, then the exchanges with you, then what it published. The operator's turns sit
 * after the agent's beats rather than being threaded into them by timestamp — a mid-turn
 * answer is ALREADY in the beats (the executor logs it as the tool result it became), so
 * splicing by time would show the same answer twice and read worse than it looks.
 */
export function conversation(detail: RunDetail): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const row of detail.timeline) {
    const key = `${row.node}@${row.visit}`;
    const render = detail.renders.find((r) => r.node === row.node && r.visit === row.visit);
    out.push({
      kind: "step",
      key: `step:${key}`,
      node: row.node,
      visit: row.visit,
      prompt: render ? { id: render.prompt, version: render.prompt_version, read: Object.keys(render.context_read) } : null,
    });

    const mine = detail.turns.filter((t) => t.node === row.node && t.visit === row.visit);
    const beats = mine.flatMap((t) => beatsOf(t.parts));
    if (beats.length)
      out.push({ kind: "beats", key: `beats:${key}`, beats, unfinished: mine.some((t) => !t.finalized) });

    for (const r of detail.log_rows) {
      if (r.node !== row.node || r.visit !== row.visit) continue;
      if (r.type === "attention-raised") out.push({ kind: "asked", key: `ask:${r.seq}`, reason: r.summary });
      else if (r.type === "attention-resolved") out.push({ kind: "answered", key: `ans:${r.seq}`, text: r.summary });
    }

    const wrote = detail.context
      .filter((c) => c.writes.some((w) => w.node === row.node && w.visit === row.visit))
      .map((c) => c.key);
    if (wrote.length) out.push({ kind: "wrote", key: `wrote:${key}`, keys: wrote });
  }
  return out;
}

/** the standing park, drawn inline at the foot of the conversation rather than in another tab */
function StandingAsk({ runId, detail, ask, onResolved }: {
  runId: string;
  detail: RunDetail;
  ask: NonNullable<RunDetail["ask"]>;
  onResolved: () => void;
}) {
  // HOW-25: the ask's OWN kind picks the card. A question gets the question card; an
  // ambiguous effect gets the effect card; everything else is answered in prose.
  if (detail.ask_questions)
    return <AskQuestionCard runId={runId} ask={ask} questions={detail.ask_questions} onResolved={onResolved} />;
  if (ask.code === "ambiguous-effect")
    return <EffectCard runId={runId} ask={ask} effects={detail.ambiguous_effects} onResolved={onResolved} />;
  return <AskCard runId={runId} ask={ask} detail={detail} onResolved={onResolved} />;
}

export function RunChat({ runId, detail, ask, onPickStep, onResolved }: {
  runId: string;
  detail: RunDetail;
  ask: RunDetail["ask"];
  onPickStep: (key: string) => void;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<ChatMode>("transcript");
  const [turns, setTurns] = useState<Array<{ q: string; a: string | null; error?: string; cost?: number }>>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const known = new Set(detail.timeline.map((t) => `${t.node}@${t.visit}`));
  const messages = conversation(detail);

  const send = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setQ("");
    setTurns((t) => [...t, { q: question, a: null }]);
    const res = await fetch(`/api/runs/${runId}/ask`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { answer?: unknown; error?: string; cost_usd?: number } | null;
    setTurns((t) => t.map((turn, i) => (i === t.length - 1
      ? { ...turn, a: res?.ok ? String(body?.answer ?? "") : null, error: res?.ok ? undefined : (body?.error ?? "could not ask"), cost: body?.cost_usd }
      : turn)));
    setBusy(false);
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">{mode === "transcript" ? "The run, as a conversation" : "Ask about this run"}</span>
        <PanelTabs
          className="chat-modes"
          look="chip"
          value={mode}
          onValueChange={setMode}
          items={[{ value: "transcript", label: "Transcript" }, { value: "ask", label: "Ask" }] as const}
        />
      </div>

      {mode === "transcript" ? (
        <div className="chat-log">
          {messages.length === 0 && <EmptyState>nothing has happened in this run yet</EmptyState>}
          {messages.map((m) => {
            switch (m.kind) {
              case "step":
                return (
                  <div key={m.key} className="cv-step">
                    <Chip className="cv-step-key" onClick={() => onPickStep(`${m.node}@${m.visit}`)}>
                      {m.node}@{m.visit}
                    </Chip>
                    {m.prompt && (
                      <span className="cv-prompt">
                        <Sparkles size={12} aria-hidden />
                        <span className="m">{m.prompt.id} v{m.prompt.version}</span>
                        <span className="cv-read">read {m.prompt.read.join(", ") || "nothing"}</span>
                      </span>
                    )}
                  </div>
                );
              case "beats":
                return (
                  <div key={m.key} className="cv-agent">
                    {m.beats.map((b, i) =>
                      b.kind === "tool"
                        ? <ToolBeat key={i} call={b.part} result={b.result} />
                        : <p key={i} className={b.kind === "thinking" ? "act-thinking" : "act-text"}>{b.part.content.trim()}</p>,
                    )}
                    {m.unfinished && <div className="act-note">the process died inside this turn — what you see is what it had said</div>}
                  </div>
                );
              case "asked":
                return (
                  <div key={m.key} className="cv-asked">
                    <HelpCircle size={12} aria-hidden />
                    <span>{m.reason}</span>
                  </div>
                );
              case "answered":
                return (
                  <div key={m.key} className="cv-answered">
                    <UserRound size={12} aria-hidden />
                    <span>{m.text}</span>
                  </div>
                );
              case "wrote":
                return (
                  <div key={m.key} className="cv-wrote">
                    <FileOutput size={12} aria-hidden />
                    <span>wrote {m.keys.map((k) => <Badge key={k} variant="id">{k}</Badge>)}</span>
                  </div>
                );
            }
          })}
          {ask && (
            <div className="cv-standing">
              <StandingAsk runId={runId} detail={detail} ask={ask} onResolved={onResolved} />
            </div>
          )}
        </div>
      ) : (
        <>
          {turns.length === 0 && (
            <div className="chat-suggestions">
              {suggestionsFor(detail, ask).map((sug) => (
                <Chip key={sug} onClick={() => send(sug)}>{sug}</Chip>
              ))}
            </div>
          )}
          <div className="chat-log">
            {turns.map((t, i) => (
              <div key={i}>
                <div className="chat-q">{t.q}</div>
                {t.a === null && !t.error && <div className="chat-a pd-note">thinking…</div>}
                {t.error && <div className="chat-a chat-error">{t.error}</div>}
                {t.a !== null && (
                  <div className="chat-a">
                    {citeParts(t.a, known).map((part, j) =>
                      part.cite
                        ? <Chip key={j} className="chat-cite" onClick={() => onPickStep(part.text)}>{part.text}</Chip>
                        : <span key={j}>{part.text}</span>)}
                    {t.cost !== undefined && <span className="m chat-cost">${t.cost.toFixed(4)}</span>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="chat-input">
            <Input
              aria-label="ask about this run"
              placeholder="Ask about this run…"
              value={q}
              disabled={busy}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={submitOnEnter(() => send(q))}
            />
            <div className="chat-note">
              <Badge>read-only</Badge> Reads this run's steps, prompts and context. It cannot reply to the agent or move
              the run — to answer what the run is waiting for, use the Transcript.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
