/**
 * Prompt & context (R3.1) plus Add feedback (R2's loop, T21). Out of main.tsx, HOW-16 P1.
 *
 * The log stores the rendered_hash, never the rendered text, so the text is fetched from
 * the server, which rebuilds it from the run's PINNED template and re-hashes to prove it.
 * An unproven reconstruction says so — showing a guess as fact is the failure mode here.
 *
 * HOW-68: the prompt and the context it read are the shared `CodeBlock` (the rendered prompt
 * had a 2px indigo stripe down its left edge — a side stripe, which DESIGN.md bans). An
 * UNVERIFIED rebuild was amber; amber means a run is waiting on you and nothing else, so it is
 * a warning glyph and plain words instead. `defaultOpen` is for the Steps panel's own
 * "Prompt & context" tab, where a second click to see the prompt was a click for nothing.
 */
import { useEffect, useState } from "react";
import { submitOnEnter } from "@/lib/keys";
import { ChevronDown, ChevronRight, MessageSquarePlus, Send, TriangleAlert } from "lucide-react";
import type { RunDetail } from "../../derive";
import type { ReconstructedRender } from "../../../prompts/library";
import { getJSON } from "@/lib/net";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/ui/markdown";
import { SectionLabel } from "@/components/ui/section-label";
import { LoadingBlock } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";

const NOTE = "m-0 text-sm leading-[1.5] text-muted-foreground";
const WARN = "m-0 flex items-start gap-1.5 text-sm font-medium leading-[1.5] text-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0";

export function PromptAndContext({ runId, render, defaultOpen = false }: { runId: string; render: RunDetail["renders"][number]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Button variant="ghost" size="sm" className="min-w-0 px-1.5" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          Prompt &amp; context · <span className="font-mono font-normal">{render.prompt}</span> v{render.prompt_version}
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => { setFeedback(!feedback); setOpen(true); }}>
          <MessageSquarePlus aria-hidden /> Add feedback
        </Button>
      </div>
      {open && (
        <>
          {instance === null && <LoadingBlock label="Rebuilding the rendered prompt" rows={4} />}
          {instance === "missing" && (
            <p className={WARN}>
              <TriangleAlert aria-hidden />
              <span>The rendered prompt cannot be rebuilt — this run's pinned copy of <span className="font-mono">{render.prompt}</span> is gone.</span>
            </p>
          )}
          {instance && instance !== "missing" && (
            <>
              {instance.verified
                ? <p className={NOTE}>Verified against the recorded hash — this is exactly what the agent read.</p>
                : <p className={WARN}><TriangleAlert aria-hidden /><span><strong className="font-semibold">Unverified.</strong> The rebuild does not match the recorded hash, so treat this text as approximate.</span></p>}
              <CodeBlock wrap clamp label="Rendered prompt">{instance.text}</CodeBlock>
            </>
          )}
          <SectionLabel as="h3" className="mt-1">Context read</SectionLabel>
          <CodeBlock wrap clamp label="Context read">{JSON.stringify(render.context_read, null, 2)}</CodeBlock>
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
    toast(`Feedback recorded against ${promptId}`);
  };

  if (state === "saved")
    return (
      <div className="feedback-card">
        <p className={NOTE}>
          Feedback recorded against <span className="font-mono">{node}@{visit}</span> — nothing changed yet.{" "}
          <a className="text-primary underline underline-offset-2" href={`/prompts/${encodeURIComponent(promptId)}`}>Open <span className="font-mono">{promptId}</span></a> to draft a revision.
        </p>
        <Button variant="ghost" size="sm" onClick={onDone}>Close</Button>
      </div>
    );

  return (
    <div className="feedback-card">
      <p className={NOTE}>
        Feedback on <span className="font-mono text-foreground">{promptId}</span> at <span className="font-mono">{node}@{visit}</span> · hash <span className="font-mono [overflow-wrap:anywhere]">{renderedHash}</span>
      </p>
      <Tabs
        label="Your verdict on this prompt"
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
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!note.trim() || state === "saving"} onClick={send}>
          <Send aria-hidden />{state === "saving" ? "Saving…" : "Save feedback"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
