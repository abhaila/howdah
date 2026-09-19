/**
 * Howdah event log types (shaping A5, eng review D4 + D10, design T6 gains).
 *
 * Append-only JSONL, one file per run. Two principles:
 *
 *   1. DURABLE CHUNKS (D10): agent output is written as it streams — `chunk` events —
 *      and stitched back together at view time (log/coalesce.ts). A crash preserves
 *      everything up to the moment of death; nothing waits for a turn to finish before
 *      touching disk. `turn-finalized` is an explicit event, so "the turn ended" and
 *      "the process died mid-turn" are distinguishable in the record.
 *
 *   2. ATTRIBUTION (D4/A5.3): every rendered prompt gets a `rendered_hash`;
 *      `prompt-outcome` events join on it — including LATE outcomes (a PR merged days
 *      after the turn) written as follow-up events, never edits.
 *
 * Events are never mutated or deleted. Sequence numbers are per-run and assigned by the
 * writer; wall-clock ts is informational.
 */
import type { PromptId } from "../core/prompt-ids";
import type { Harness } from "../core/graph";

/** fields the writer stamps on every event */
export interface Stamped {
  seq: number;
  ts: string; // ISO-8601
}

export type RunOutcome = "success" | "failed" | "aborted";

export type ChunkKind = "text" | "thinking" | "tool_call" | "tool_result";

export type AllowanceState = "ok" | "exhausted" | "unreachable" | "unavailable";

/**
 * system-map 0.2 — why a run parked. Each code has exactly one reply rule
 * (engine/control.ts REPLY_RULES). The last three are raised by slice 1's approval flow;
 * they are defined now so their refusal text exists before the first event carries them.
 */
export type ParkCode =
  | "attempt-failed"
  | "executor-threw"
  | "max-visits"
  | "no-edge"
  | "max-steps"
  | "ambiguous-effect"
  | "awaiting-approval"
  | "approval-missing"
  | "stale-base";

export type ResolutionSource = "operator" | "resume";

/** Who resolved an ask. Legacy events carry no source: resume() always wrote reply "resume". */
export function resolutionSource(e: { reply?: string; source?: ResolutionSource }): ResolutionSource {
  return e.source ?? (e.reply === "resume" ? "resume" : "operator");
}

/** everything the engine and adapters may append — the closed union the viewer renders */
export type RunEvent =
  | {
      type: "run-started";
      graph: string;
      inputs: Record<string, unknown>;
      /** where the run works — recorded once; the reconciler probes it, the IDE button opens it */
      cwd?: string;
      folder_kind?: "repo" | "plain";
      /** run-level agent overrides — persisted so RESUME keeps them (they beat everything) */
      overrides?: { harness?: Harness; model?: string; effort?: string; permissionMode?: string; maxTurns?: number; skills?: string[] };
      /** prompt versions pinned at start (OV-2) — revisions apply to new runs only */
      pinned_prompts: Partial<Record<PromptId, number>>;
    }
  | { type: "node-started"; node: string; visit: number; attempt_id: string }
  | {
      type: "prompt-rendered";
      node: string;
      visit: number;
      prompt: PromptId;
      prompt_version: number;
      /** hash of the full prompt as sent (suffixes included since system-map 0.1) — the join key for prompt-outcome */
      rendered_hash: string;
      /** exactly the context the template read, at render time (A5.1) */
      context_read: Record<string, unknown>;
      /** resolved execution config — run override → node → graph default */
      harness?: Harness;
      model?: string;
      effort?: string;
      /**
       * system-map 0.1 — the suffix inputs, so reconstruction can rebuild the prompt AS SENT.
       * Absent on pre-0.1 events, whose hash covered the template (+ jump suffix) only.
       * `skills` is what the hint actually named (codex: always []).
       */
      skills?: string[];
      /** the node's declared write keys, in order — the outputs contract's input */
      output_keys?: string[];
      /** which core/template.ts suffix builders produced the skill hint + outputs contract */
      suffix_version?: number;
    }
  | {
      type: "chunk";
      node: string;
      visit: number;
      /** turn counter within the visit — chunks of one turn share it */
      turn: number;
      /** ordering within the turn, assigned by the adapter as bytes arrive */
      index: number;
      kind: ChunkKind;
      /** text/thinking: the delta; tool_call/tool_result: rendered summary */
      content: string;
      /** tool_call/tool_result correlation */
      tool_id?: string;
      tool_name?: string;
    }
  | {
      type: "turn-finalized";
      node: string;
      visit: number;
      turn: number;
      usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
    }
  | {
      type: "prompt-outcome";
      rendered_hash: string;
      node: string;
      visit: number;
      /** what the next reviewer/condition concluded about this prompt's output */
      verdict_downstream?: string;
      /** set when the run itself ended — may arrive days later as a follow-up write */
      terminal_outcome?: RunOutcome;
      error?: string;
    }
  | {
      type: "node-finished";
      node: string;
      visit: number;
      status: "succeeded" | "failed";
      /** the values written, keyed by context key — replay rebuilds context from these */
      writes: Record<string, unknown>;
    }
  | {
      /** written BEFORE a side-effecting step (OV-1) — intent without a matching done
       *  marks an AMBIGUOUS execution that must be probed before any retry */
      type: "side-effect-intent";
      node: string;
      visit: number;
      attempt_id: string;
      effect: string;
    }
  | { type: "side-effect-done"; node: string; visit: number; attempt_id: string; effect: string; result?: unknown }
  | {
      /** reconciler observation before a node (A6): git always, forge only for declared
       *  readers. Disagreements between intended and observed identity are FACTS here —
       *  surfaced, never auto-resolved. */
      type: "reconciled";
      node: string;
      git: {
        repo: boolean;
        branch: string | null;
        head: string | null;
        uncommitted: number;
        unpushed: number | null;
      };
      forge?: { kind: "pr"; state: string; url: string } | { kind: "no-pr" } | { kind: "unreachable"; error: string } | null;
      intended?: { branch?: string; prUrl?: string };
      disagreements: string[];
    }
  | { type: "edge-taken"; from: string; to: string; label?: string }
  | { type: "run-paused"; by: string }
  | { type: "run-resumed"; by: string }
  | {
      /** operator moved the run to a node; the message is injected into that node's next
       *  prompt as an operator instruction */
      type: "operator-jump";
      to: string;
      message?: string;
      /**
       * system-map 0.3: the operator took responsibility for the run, so every node's
       * maxVisits budget restarts from its visit count at this event (a floor — visit
       * NUMBERS never reset, they are attempt identity). Absent on legacy events, which
       * replay with no floors.
       */
      reset_budgets?: boolean;
    }
  | {
      type: "attention-raised";
      node: string;
      visit: number;
      /** human-readable; kept as free text so the thread reads the same as before 0.2 */
      reason: string;
      /**
       * system-map 0.2: WHY the run parked, machine-readable — it decides what a reply may
       * do (engine/control.ts resolveReply). Absent on legacy events and on mid-node
       * harness permission asks, which keep their live reply path (executors/reply.ts).
       */
      code?: ParkCode;
      ask?: unknown;
    }
  | {
      type: "attention-resolved";
      node: string;
      visit: number;
      reply?: string;
      /**
       * system-map 0.2: who resolved it. Only an `operator` reply can reach a prompt;
       * resume()'s own resolution is bookkeeping. Absent on legacy events — read those
       * through resolutionSource(), which treats `reply: "resume"` as resume.
       */
      source?: ResolutionSource;
    }
  | {
      type: "allowance";
      harness: Harness;
      state: AllowanceState;
      /** remaining fraction 0..1 when the harness reports one — never an invented estimate */
      remaining?: number;
      resets_at?: string;
      /** raw payload (claude rate_limit_event / codex account/rateLimits/updated) */
      raw?: unknown;
    }
  | { type: "run-finished"; outcome: RunOutcome };

export type LoggedEvent = RunEvent & Stamped;
