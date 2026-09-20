/**
 * Prompt & context (R3.1) plus Add feedback (R2's loop, T21). Out of main.tsx, HOW-16 P1.
 *
 * The log stores the rendered_hash, never the rendered text, so the text is fetched from
 * the server, which rebuilds it from the run's PINNED template and re-hashes to prove it.
 * An unproven reconstruction says so — showing a guess as fact is the failure mode here.
 *
 * Two raw controls die here: the `.linkish` span with an onClick (keyboard-unreachable,
 * P2.8) and the `.pc-feedback` hand-CSS button (P1.5) are both Buttons now.
 */
import { useEffect, useState } from "react";
import { submitOnEnter } from "@/lib/keys";
import { MessageSquarePlus, Send } from "lucide-react";
import type { RunDetail } from "../../derive";
import type { ReconstructedRender } from "../../../prompts/library";
import { getJSON } from "@/lib/net";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";

export function PromptAndContext({ runId, render }: { runId: string; render: RunDetail["renders"][number] }) {
  const [open, setOpen] = useState(false);
  const [instance, setInstance] = useState<ReconstructedRender | "missing" | null>(null);
  const [feedback, setFeedback] = useState(false);

  useEffect(() => {
    if (!open || instance) return;
    getJSON<ReconstructedRender>(`/api/runs/${runId}/render/${render.rendered_hash}`)
      .then(setInstance)
      .catch(() => setInstance("missing"));
  }, [open, instance, runId, render.rendered_hash]);

  return (
    <div className="prompt-context">
      <div className="pc-head">
        <Button variant="link" size="inline" aria-expanded={open} onClick={() => setOpen(!open)}>
          Prompt &amp; context · {render.prompt} v{render.prompt_version} {open ? "▾" : "▸"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { setFeedback(!feedback); setOpen(true); }}>
          <MessageSquarePlus /> Add feedback
        </Button>
      </div>
      {open && (
        <>
          {instance === null && <div className="pc-note">rebuilding the rendered prompt…</div>}
          {instance === "missing" && (
            <div className="pc-note warn">
              the rendered prompt cannot be rebuilt — this run's pinned copy of {render.prompt} is gone
            </div>
          )}
          {instance && instance !== "missing" && (
            <>
              <div className={`pc-note ${instance.verified ? "" : "warn"}`}>
                {instance.verified
                  ? "verified against the recorded rendered_hash — this is exactly what the agent read"
                  : "UNVERIFIED — the rebuild does not match the recorded hash, so treat it as approximate"}
              </div>
              <pre className="pc-rendered">{instance.text}</pre>
            </>
          )}
          <div className="pc-note">context read</div>
          <pre>{JSON.stringify(render.context_read, null, 2)}</pre>
        </>
      )}
      {feedback && (
        <FeedbackForm
          promptId={render.prompt}
          runId={runId}
          node={render.node}
          visit={render.visit}
          renderedHash={render.rendered_hash}
          onDone={() => setFeedback(false)}
        />
      )}
    </div>
  );
}

/** Writes one reviser-format line, pre-filled with the turn it refers to (A2.2). */
export function FeedbackForm({ promptId, runId, node, visit, renderedHash, onDone }: {
  promptId: string; runId: string; node: string; visit: number; renderedHash: string; onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState<"reject" | "accept">("reject");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const send = async () => {
    setState("saving");
    setError(null);
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: runId, node, visit, note, verdict, rendered_hash: renderedHash }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const why = ((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? "could not save feedback";
      setError(why);
      setState("failed");
      toast(why, "error");
      return;
    }
    setState("saved");
    toast(`feedback recorded against ${promptId}`);
  };

  if (state === "saved")
    return (
      <div className="feedback-card">
        <div className="pc-note">
          feedback recorded against {node}@{visit} — nothing changed yet (R2).{" "}
          <a href={`/prompts/${encodeURIComponent(promptId)}`}>Open {promptId}</a> to draft a revision.
        </div>
        <Button variant="ghost" size="sm" onClick={onDone}>Close</Button>
      </div>
    );

  return (
    <div className="feedback-card">
      <div className="pc-note">
        feedback on <strong>{promptId}</strong> at {node}@{visit} · hash {renderedHash}
      </div>
      <Tabs
        value={verdict}
        onValueChange={(v) => setVerdict(v as "reject" | "accept")}
        items={[{ value: "reject", label: "Needs work" }, { value: "accept", label: "Good" }]}
      />
      <Textarea
        autoFocus
        aria-label="feedback note"
        placeholder="What should this prompt do differently? Be specific — the reviser reflects on exactly this."
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={submitOnEnter(() => void send(), { enabled: Boolean(note.trim()) && state !== "saving" })}
      />
      {error && <div className="field-error">{error}</div>}
      <div className="feedback-actions">
        <Button size="sm" disabled={!note.trim() || state === "saving"} onClick={send}>
          <Send />{state === "saving" ? "saving…" : "Save feedback"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
