/**
 * Chat (T24, stories 11-13) — LangSmith's Polly pattern: ask about THIS run instead of
 * scrolling it. READ-ONLY by decision: it cannot reply to the agent or move the run.
 *
 * Model output is untrusted input, so citations are matched against a whitelist of this
 * run's own node@visit keys and rendered as TEXT — never as markup. That has NOT changed
 * here; what changed is that the suggestions and citations were `<span className="chip">`
 * with an onClick (a class with no base rule, and no keyboard path), and are Chips now.
 */
import { useState } from "react";
import { submitOnEnter } from "@/lib/keys";
import type { RunDetail } from "../../derive";
import { citeParts } from "../../cite";
import { Chip } from "@/components/ui/chip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

export function suggestionsFor(detail: RunDetail, ask: RunDetail["ask"]): string[] {
  const out: string[] = [];
  if (ask) out.push("What is it waiting for?");
  const failed = detail.timeline.find((t) => t.status === "failed");
  if (failed) out.push(`Why did ${failed.node}@${failed.visit} fail?`);
  const rewritten = detail.context.find((c) => c.writes.length > 1);
  if (rewritten) out.push(`What changed in ${rewritten.key}?`);
  return out.slice(0, 3);
}

export function RunChat({ runId, detail, ask, onPickStep }: {
  runId: string;
  detail: RunDetail;
  ask: RunDetail["ask"];
  onPickStep: (key: string) => void;
}) {
  const [turns, setTurns] = useState<Array<{ q: string; a: string | null; error?: string; cost?: number }>>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const known = new Set(detail.timeline.map((t) => `${t.node}@${t.visit}`));

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
        <span className="chat-title">Ask about this run</span>
        <Badge className="ml-auto">read-only</Badge>
      </div>
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
        <div className="chat-note">Reads this run's steps, prompts and context. It cannot reply to the agent or move the run.</div>
      </div>
    </div>
  );
}
