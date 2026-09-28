/**
 * Chat — the central pane (HOW-25, rebuilt in HOW-27). One conversation: what each step was
 * asked to do, what the agent said and did, what it asked YOU, what you answered, and what the
 * step published.
 *
 * HOW-25 filed this because "we don't follow the normal chat flow" — a run that asked a
 * question had nowhere to show it. HOW-27 is the same complaint one level up: the pane still
 * did not READ like an agentic chat, and two things were why.
 *
 * ONE TIMELINE, NOT TWO TABS. The pane used to split Transcript and Ask across a `PanelTabs`,
 * and only the Ask half had a composer — so the surface you actually watch had no input at all,
 * and asking anything hid the thing you were asking about. There is now one scrolling
 * transcript with the composer permanently at its foot, and your own questions land in that
 * same timeline as their own rows. The tab is gone, not moved.
 *
 * THE READER'S POSITION IS HELD. `.chat-log { overflow-y: auto }` scrolled, and that is all it
 * did: output arriving mid-read yanked you away, and there was no way back to the live edge but
 * to drag. That is `components/ui/message-scroller` now — auto-scroll only while you are
 * already at the edge, position kept when you are not, a turn boundary anchoring with the
 * previous turn still peeking above it, and a control that returns you to the bottom. Every
 * step is a `scrollAnchor`, because a step IS the turn boundary here.
 *
 * WHAT THE COMPOSER DOES, AND WHAT IT DELIBERATELY DOES NOT. It asks the read-only question
 * route about this run. It does NOT reply to the agent, even though one box that silently
 * changes target on whether the run is parked would look more like the CLIs: `ask` spends
 * tokens on a fresh read-only agent and `reply` unparks a live run and cannot be taken back.
 * A box that does either depending on state is a box that sends the wrong one. Answering the
 * run stays where HOW-25 put it — inline, at the foot of the transcript, on the standing ask's
 * own card, which is where the question is.
 *
 * On the AI SDK suggestion in HOW-25's ticket, which still stands: `@shadcn/helpers`'
 * `createChat()` is a mock ChatTransport for demos, and the chat COMPONENTS live in AI
 * Elements, which pulls Radix (ScrollArea, Collapsible, DropdownMenu, Tooltip) plus a
 * markdown/syntax stack. `useChat` wants a UI-message-stream endpoint, which an append-only run
 * log is not and should not become — a transcript is a REPLAYED LOG, not a live LLM
 * conversation. What was worth taking is the MESSAGE-PARTS shape, and howdah already had it:
 * `log/coalesce.ts` TurnPart is text / thinking / tool_call / tool_result. `message-scroller`
 * is the opposite trade and that is why it is here: `@shadcn/react` is 20KB with no runtime
 * dependencies and no primitives library under it.
 *
 * Tool work is drawn by activity.tsx's `beatsOf` + `ToolBeat` — the same renderer the Steps
 * pane uses, not a second one, so a failed tool still opens itself here.
 *
 * Model output stays UNTRUSTED INPUT: an answer's citations are matched against a whitelist of
 * this run's own node@visit keys and rendered as TEXT, never markup. That rule predates both
 * rewrites and is unchanged.
 */
import { useMemo, useState } from "react";
import { Sparkles, FileOutput, UserRound, HelpCircle, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { submitOnEnter } from "@/lib/keys";
import type { RunDetail } from "../../derive";
import { citeParts } from "../../cite";
import { AgentProse, beatsOf, ToolBeat, ToolDisclosureContext } from "./activity";
import { Button } from "@/components/ui/button";
import { StandingAsk } from "./ask";
import { Chip } from "@/components/ui/chip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

export function suggestionsFor(detail: RunDetail, ask: RunDetail["ask"]): string[] {
  const out: string[] = [];
  if (ask) out.push("What is it waiting for?");
  const failed = detail.timeline.find((t) => t.status === "failed");
  if (failed) out.push(`Why did ${failed.node}@${failed.visit} fail?`);
  const rewritten = detail.context.find((c) => c.writes.length > 1);
  if (rewritten) out.push(`What changed in ${rewritten.key}?`);
  return out.slice(0, 3);
}

/** one message in the transcript — the parts model, in the order the run produced them */
export type ChatMessage =
  | { kind: "step"; key: string; node: string; visit: number; prompt: { id: string; version: number; read: string[] } | null }
  | { kind: "beats"; key: string; beats: ReturnType<typeof beatsOf>; unfinished: boolean }
  | { kind: "asked"; key: string; reason: string }
  | { kind: "answered"; key: string; text: string }
  | { kind: "wrote"; key: string; keys: string[] };

/** one exchange with the read-only question route — the operator's own side-conversation */
type AskTurn = { q: string; a: string | null; error?: string; cost?: number };

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
    // An un-finalized turn normally means the process died inside it. It does NOT mean that at
    // the node the run is PARKED on: a mid-turn ask (HOW-25) holds the session open on purpose
    // while `awaitOperator` waits, so there is no `turn-finalized` yet and nothing has died.
    // Saying so put "the process died inside this turn" directly above the "Needs you" card
    // that was waiting for an answer — the pane contradicting itself by two lines.
    const waitingHere = detail.ask?.node === row.node && detail.ask?.visit === row.visit;
    if (beats.length)
      out.push({ kind: "beats", key: `beats:${key}`, beats, unfinished: mine.some((t) => !t.finalized) && !waitingHere });

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

/** one transcript row. Split out so the scroller's item wrapper stays one line per message. */
function Row({ m, onPickStep }: { m: ChatMessage; onPickStep: (key: string) => void }) {
  switch (m.kind) {
    case "step":
      return (
        <div className="cv-step">
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
        <div className="cv-agent">
          {m.beats.map((b, i) =>
            b.kind === "tool"
              ? <ToolBeat key={i} call={b.part} result={b.result} />
              : b.kind === "thinking"
                ? <p key={i} className="act-thinking">{b.part.content.trim()}</p>
                : <AgentProse key={i} text={b.part.content} />,
          )}
          {m.unfinished && <div className="act-note">the process died inside this turn — what you see is what it had said</div>}
        </div>
      );
    case "asked":
      return (
        <div className="cv-asked">
          <HelpCircle size={12} aria-hidden />
          <span>{m.reason}</span>
        </div>
      );
    case "answered":
      return (
        <div className="cv-answered">
          <UserRound size={12} aria-hidden />
          <span>{m.text}</span>
        </div>
      );
    case "wrote":
      return (
        <div className="cv-wrote">
          <FileOutput size={12} aria-hidden />
          <span>wrote {m.keys.map((k) => <Badge key={k} variant="id">{k}</Badge>)}</span>
        </div>
      );
  }
}

export function RunChat({ runId, detail, ask, onPickStep, onResolved }: {
  runId: string;
  detail: RunDetail;
  ask: RunDetail["ask"];
  onPickStep: (key: string) => void;
  onResolved: () => void;
}) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  // HOW-27: the bulk tool disclosure. `epoch: 0` is "nobody has asked yet", which is what
  // leaves each beat on its own default — closed, or open if its result reads as a failure.
  const [disclosure, setDisclosure] = useState<{ epoch: number; open: boolean }>({ epoch: 0, open: false });
  const known = new Set(detail.timeline.map((t) => `${t.node}@${t.visit}`));
  const messages = conversation(detail);
  const suggestions = suggestionsFor(detail, ask);
  const toolCount = useMemo(
    () => messages.reduce((n, m) => n + (m.kind === "beats" ? m.beats.filter((b) => b.kind === "tool").length : 0), 0),
    [messages],
  );
  // the context object is memoised on its VALUES, not rebuilt per render: a new object every
  // render would re-run every ToolBeat's epoch check for nothing
  const disclosureValue = useMemo(() => disclosure, [disclosure]);

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
        <span className="chat-title">The run, as a conversation</span>
        {/* one control for every tool call in the transcript — a long run is mostly tool work,
            and opening or closing it one beat at a time is not skimming. Absent when the run
            has no tool calls to act on, rather than present and inert. */}
        {toolCount > 0 && (
          <Button
            className="chat-disclosure"
            variant="outline"
            size="sm"
            aria-pressed={disclosure.epoch > 0 && disclosure.open}
            onClick={() => setDisclosure((d) => ({ epoch: d.epoch + 1, open: !d.open }))}
          >
            {disclosure.open ? <ChevronsDownUp /> : <ChevronsUpDown />}
            {disclosure.open ? "Collapse" : "Expand"} {toolCount} tool {toolCount === 1 ? "call" : "calls"}
          </Button>
        )}
      </div>

      {/* `last-anchor` opens on the newest step rather than the very bottom, so the step that
          is running is at the top of the view with its own prompt visible — and the peek keeps
          the tail of the previous step on screen, which is the context you need to read it. */}
      <ToolDisclosureContext.Provider value={disclosureValue}>
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport preserveScrollOnPrepend aria-label="the run, as a conversation" tabIndex={0}>
            {/* gap-0: the rows carry their own vertical rhythm in howdah.css, and the
                component's default `gap-8` would double it */}
            <MessageScrollerContent className="chat-log gap-0">
              {messages.length === 0 && turns.length === 0 && (
                <EmptyState>nothing has happened in this run yet</EmptyState>
              )}
              {messages.map((m) => (
                <MessageScrollerItem key={m.key} messageId={m.key} scrollAnchor={m.kind === "step"}>
                  <Row m={m} onPickStep={onPickStep} />
                </MessageScrollerItem>
              ))}
              {turns.map((t, i) => (
                <MessageScrollerItem key={`turn:${i}`} messageId={`turn:${i}`} scrollAnchor>
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
                </MessageScrollerItem>
              ))}
              {ask && (
                <MessageScrollerItem messageId="needs-input" scrollAnchor>
                  <div className="cv-standing">
                    <StandingAsk runId={runId} detail={detail} ask={ask} onResolved={onResolved} />
                  </div>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {/* Both pins, the way the Logs pane's ScrollShell has always had them: Top to get
              back to the start of a long run, Bottom to return to the live edge after reading
              away from it. Each one is inert and invisible until that direction is actually
              scrollable, so an unscrollable transcript shows neither. */}
          <MessageScrollerButton direction="start" />
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>
      </ToolDisclosureContext.Provider>

      {turns.length === 0 && suggestions.length > 0 && (
        <div className="chat-suggestions">
          {suggestions.map((sug) => (
            <Chip key={sug} onClick={() => send(sug)}>{sug}</Chip>
          ))}
        </div>
      )}
      <div className="chat-input">
        <Input
          aria-label="ask about this run"
          placeholder="Ask about this run…"
          value={q}
          disabled={busy}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={submitOnEnter(() => send(q), { enabled: !busy })}
        />
        <div className="chat-note">
          <Badge>read-only</Badge> Reads this run's steps, prompts and context. It cannot reply to the agent or move
          the run — to answer what the run is waiting for, use the card above.
        </div>
      </div>
    </div>
  );
}
