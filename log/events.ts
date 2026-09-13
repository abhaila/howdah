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

/** everything the engine and adapters may append — the closed union the viewer renders */
export type RunEvent =
  | {
      type: "run-started";
      graph: string;
      inputs: Record<string, unknown>;
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
      /** hash of the fully rendered text — the join key for prompt-outcome */
      rendered_hash: string;
      /** exactly the context the template read, at render time (A5.1) */
      context_read: Record<string, unknown>;
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
  | { type: "node-finished"; node: string; visit: number; status: "succeeded" | "failed"; writes: string[] }
  | { type: "edge-taken"; from: string; to: string; label?: string }
  | { type: "attention-raised"; node: string; visit: number; reason: string; ask?: unknown }
  | { type: "attention-resolved"; node: string; visit: number; reply?: string }
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
