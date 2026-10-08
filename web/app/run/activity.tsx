/**
 * Activity — what actually happened inside one step, read as a journey rather than a feed.
 *
 * The Logs tab rendered one row per stored `chunk`, which is one row per STREAMING DELTA.
 * Measured on a real implement-slice run: 12,609 text chunks averaging 13 characters, so the
 * sentence "I'll explore the harness abstraction before designing the slice." arrived as six
 * consecutive rows reading "I'll expl", "ore the har", "ness ab", "straction before",
 * " designing the", " slice." — plus 2,252 `thinking` rows carrying nothing at all. The
 * information was there and unreadable.
 *
 * Nothing about the log changes. `coalesce()` already stitches deltas back into prose for the
 * read model; this pane is the first thing to render that per STEP, which is the scope an
 * operator actually asks about ("what did slice.propose do?").
 *
 * The shape is narrative first, detail on demand:
 *   - the prompt beat opens it, naming what context the step was allowed to read;
 *   - prose is prose;
 *   - a tool call is ONE line — name plus a one-line argument summary — that opens to its
 *     full input and output;
 *   - a FAILED tool opens itself, because a failure you have to click to find is a failure
 *     you miss, and the cause of a parked step is almost always in a tool result;
 *   - the outputs the step wrote close it, because that is what the next node reads.
 *
 * Empty `thinking` parts are dropped rather than drawn. The adapter maps `thinking_delta`
 * correctly (adapter/fixtures/claude-turn.jsonl pins it), but the live CLI sends no text with
 * them, and 2,252 blank rows are noise. If a harness ever does send thinking, it renders —
 * the content check is what decides, not the kind.
 */
import { createContext, useContext, useMemo, useState } from "react";
import { ChevronRight, Wrench, TriangleAlert, FileOutput, Sparkles } from "lucide-react";
import type { CoalescedTurn, TurnPart } from "../../../log/coalesce";
import type { RunDetail } from "../../derive";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { Markdown } from "@/components/ui/markdown";
import { splitOutputs } from "../../../core/outputs";
import { OutputDocs } from "./document";

/** a tool result that reads as a failure — same test the thread used, kept in one place */
const FAILED = /\berror\b|\bfailed\b|exit [1-9]|denied|not found|traceback/i;

/**
 * The one line a tool call gets. Tool inputs are JSON whose INTERESTING field differs per
 * tool, so pick the field that names the work — the command, the path, the pattern — and
 * fall back to the compact JSON rather than printing "[object Object]" at someone.
 */
export function toolSummary(input: string): string {
  let v: unknown;
  try {
    v = JSON.parse(input);
  } catch {
    return input.replace(/\s+/g, " ").trim();
  }
  if (v === null || typeof v !== "object") return String(v);
  const o = v as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const hit = o[k];
    if (typeof hit === "string" && hit.trim()) return hit.replace(/\s+/g, " ").trim();
  }
  return JSON.stringify(o).replace(/\s+/g, " ");
}

/**
 * A transcript-wide "collapse/expand every tool call" instruction (HOW-27).
 *
 * Each `ToolBeat` owns its own open state, which is what makes one tool openable without
 * disturbing its neighbours — so a bulk control cannot simply be a prop, or every beat would
 * snap back to the bulk value the next time the pane re-rendered and per-beat toggling would
 * stop working. It is an EPOCH instead: the provider bumps `epoch` when the operator asks for
 * all-open or all-closed, and a beat adopts `open` exactly once per epoch it has not seen.
 * Between epochs the beat is on its own again.
 *
 * The context is optional, so `StepActivity` and any other caller render unchanged without a
 * provider — `null` means "nobody is asking", which is the pre-HOW-27 behaviour exactly.
 */
export interface ToolDisclosure {
  epoch: number;
  open: boolean;
}
export const ToolDisclosureContext = createContext<ToolDisclosure | null>(null);

/**
 * The open/closed state every disclosure in a transcript shares: its own default, toggled on
 * its own, and adopting a bulk instruction exactly once per epoch. One hook, because the tool
 * beat and the tool group (HOW-30) must obey the same bulk control the same way — two copies
 * of the epoch dance is how one of them starts snapping back.
 */
function useDisclosure(initial: boolean): [boolean, (open: boolean) => void] {
  const bulk = useContext(ToolDisclosureContext);
  // a disclosure MOUNTED after a bulk instruction starts in it: a beat inside a group the bulk
  // control just opened, or one streamed in after "Expand all", is covered by what was asked
  const [open, setOpen] = useState(bulk !== null && bulk.epoch > 0 ? bulk.open : initial);
  const [seenEpoch, setSeenEpoch] = useState(bulk?.epoch ?? 0);
  // adjusting state during render rather than in an effect: React re-renders this component
  // before touching the DOM, so the disclosure never paints in the stale state first
  if (bulk !== null && bulk.epoch !== seenEpoch) {
    setSeenEpoch(bulk.epoch);
    setOpen(bulk.open);
  }
  return [open, setOpen];
}

/**
 * The name a tool is shown under (HOW-30). An MCP tool arrives as `mcp__<server>__<tool>`, and
 * `mcp__claude_ai_Linear__save_issue` printed in full was the longest, loudest thing on a row
 * whose point is the argument after it. The server's own trailing segment and the tool are
 * what a reader needs; the raw name is still in the opened body's input for anyone who wants it.
 */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m || m[1] === undefined || m[2] === undefined) return name;
  const server = m[1].split("_").filter(Boolean).at(-1) ?? m[1];
  return `${server} · ${m[2]}`;
}

/** exported for the Chat transcript (HOW-25): one tool renderer, not two */
export function ToolBeat({ call, result }: { call: TurnPart; result?: TurnPart }) {
  const failed = result !== undefined && FAILED.test(result.content);
  // a failure opens itself; everything else waits to be asked
  const [open, setOpen] = useDisclosure(failed);
  return (
    <div className={`act-tool${failed ? " failed" : ""}`} data-open={open ? "open" : "closed"}>
      <Row className="act-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className="act-caret" size={12} aria-hidden />
        {failed ? <TriangleAlert size={12} aria-hidden /> : <Wrench size={12} aria-hidden />}
        <span className="act-tool-name">{toolLabel(call.tool_name ?? "tool")}</span>
        <span className="m act-tool-sum">{toolSummary(call.content)}</span>
        {failed && <Badge variant="destructive">failed</Badge>}
      </Row>
      {open && (
        <div className="act-tool-body">
          <div className="act-label">input</div>
          <pre className="act-pre">{call.content}</pre>
          {result && (
            <>
              <div className="act-label">output</div>
              <pre className="act-pre">{result.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export type Beat = { kind: "text" | "thinking" | "tool"; part: TurnPart; result?: TurnPart };
export type BeatGroup = Beat | { kind: "tools"; beats: Beat[] };

/**
 * Fold every run of two or more ADJACENT tool beats into one group (HOW-30). On the run in the
 * ticket's screenshot the agent's own sentences were one row in eight; the rest was tool calls,
 * each a full-width line at the same weight as the prose, so the transcript read as a command
 * log with the occasional remark. A run of tools is one thing the agent DID between two things
 * it SAID, and is drawn as one line until opened. Prose is never folded, and a lone tool stays
 * a beat: a group of one is a second click for nothing.
 */
export function groupBeats(beats: readonly Beat[]): BeatGroup[] {
  const out: BeatGroup[] = [];
  let run: Beat[] = [];
  const flush = () => {
    if (run.length === 1 && run[0] !== undefined) out.push(run[0]);
    else if (run.length > 1) out.push({ kind: "tools", beats: run });
    run = [];
  };
  for (const b of beats) {
    if (b.kind === "tool") run.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

/**
 * One line for a run of tool calls: how many, and which. It opens itself when any call inside
 * failed, for the same reason a failed beat does — and the failed beat inside is then already
 * open, so the failure is two levels deep and zero clicks away.
 */
export function ToolGroup({ beats }: { beats: Beat[] }) {
  const failedCount = beats.filter((b) => b.result !== undefined && FAILED.test(b.result.content)).length;
  const [open, setOpen] = useDisclosure(failedCount > 0);
  const names = [...new Set(beats.map((b) => toolLabel(b.part.tool_name ?? "tool")))];
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
  return (
    <div className={`act-group${failedCount ? " failed" : ""}`} data-open={open ? "open" : "closed"}>
      <Row className="act-tool-head act-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className="act-caret" size={12} aria-hidden />
        {failedCount ? <TriangleAlert size={12} aria-hidden /> : <Wrench size={12} aria-hidden />}
        <span className="act-tool-name">Used {beats.length} tools</span>
        <span className="act-tool-sum">{shown}</span>
        {failedCount > 0 && <Badge variant="destructive">{failedCount} failed</Badge>}
      </Row>
      {open && (
        <div className="act-group-body">
          {beats.map((b, i) => <ToolBeat key={i} call={b.part} result={b.result} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Pair each tool_result with the call it answers. The stream carries them as separate parts;
 * `tool_id` is what ties them, and a result whose call never arrived still gets drawn rather
 * than silently dropped — an orphan result is a fact about the run, not a rendering problem.
 */
export function beatsOf(parts: readonly TurnPart[]): Beat[] {
  const used = new Set<number>();
  const out: Beat[] = [];
  parts.forEach((p, i) => {
    if (used.has(i)) return;
    if (p.kind === "tool_call") {
      const j = parts.findIndex((q, k) => k > i && q.kind === "tool_result" && q.tool_id === p.tool_id);
      if (j >= 0) used.add(j);
      out.push({ kind: "tool", part: p, result: j >= 0 ? parts[j] : undefined });
    } else if (p.kind === "tool_result") {
      out.push({ kind: "tool", part: { ...p, tool_name: p.tool_name ?? "result" }, result: p });
    } else if (p.content.trim()) {
      // empty thinking is the 2,252-row case: drawn only when it actually says something
      out.push({ kind: p.kind === "thinking" ? "thinking" : "text", part: p });
    }
  });
  return out;
}

/**
 * One run of the agent's own words (HOW-29). Prose is markdown, so it is drawn as markdown; and
 * the `{"outputs": ...}` object the step closes with is lifted out of it and drawn as what it
 * published — a plan as a document, a verdict as a value — instead of one JSON line of `\n`
 * escapes. A contract still being streamed is named rather than printed half-written.
 * Exported for the Chat transcript: one prose renderer, not two.
 */
export function AgentProse({ text }: { text: string }) {
  const split = useMemo(() => splitOutputs(text.trim()), [text]);
  return (
    <>
      {split.before.trim() && <Markdown className="act-text" text={split.before} />}
      {split.outputs && <OutputDocs outputs={split.outputs} />}
      {split.pending && <div className="act-note-quiet">writing outputs…</div>}
      {split.after.trim() && <Markdown className="act-text" text={split.after} />}
    </>
  );
}

export function StepActivity({ turns, render, row, context }: {
  turns: CoalescedTurn[];
  render?: RunDetail["renders"][number];
  row: RunDetail["timeline"][number];
  /** the run's context keys; what THIS step published is read back off their write lists */
  context: RunDetail["context"];
}) {
  const mine = turns.filter((t) => t.node === row.node && t.visit === row.visit);
  const beats = mine.flatMap((t) => beatsOf(t.parts));
  const unfinished = mine.some((t) => !t.finalized);
  // what this step handed the next one. Read off the context entries rather than widening
  // TimelineRow: `node-finished.writes` already lands there, and one source beats two.
  const wrote = context.filter((c) => c.writes.some((w) => w.node === row.node && w.visit === row.visit)).map((c) => c.key);

  if (!render && beats.length === 0)
    return <EmptyState>nothing ran in this step yet</EmptyState>;

  return (
    <div className="activity">
      {render && (
        <div className="act-beat act-prompt">
          <Sparkles size={12} aria-hidden />
          <div className="act-beat-body">
            <span className="m act-prompt-id">{render.prompt} v{render.prompt_version}</span>
            <span className="act-prompt-read">
              read {Object.keys(render.context_read).join(", ") || "nothing"}
            </span>
          </div>
        </div>
      )}

      {beats.map((b, i) =>
        b.kind === "tool" ? (
          <ToolBeat key={i} call={b.part} result={b.result} />
        ) : (
          b.kind === "thinking"
            ? <p key={i} className="act-thinking">{b.part.content.trim()}</p>
            : <AgentProse key={i} text={b.part.content} />
        ),
      )}

      {unfinished && <div className="act-note">the process died inside this turn — what you see is what it had said</div>}

      {wrote.length > 0 && (
        <div className="act-beat act-wrote">
          <FileOutput size={12} aria-hidden />
          <div className="act-beat-body">
            wrote {wrote.map((k) => <Badge key={k} variant="id">{k}</Badge>)}
          </div>
        </div>
      )}
    </div>
  );
}
