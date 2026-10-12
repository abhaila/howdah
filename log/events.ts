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
import type { AskAnswer } from "../core/ask";
import type { PromptId } from "../core/prompt-ids";
import type { Harness } from "../core/graph";
import type { TurnUsage } from "../adapter/events";
import type { DriftItem, DriftOutcome } from "../map/drift";

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
  /** the harness CLI is not logged in: outside the graph's control, fixed by a human, then resume */
  | "harness-unauthenticated"
  /**
   * HOW-14: the agent's turn died because its context window filled. Not the model breaking
   * its contract and not an allowance problem — so it never hops harnesses; a reply is carried
   * into the retry, and the retry is rendered with a re-entry briefing (core/template.ts v4).
   */
  | "context-exhausted"
  /**
   * HOW-38: the agent reissued one call with identical arguments and it kept failing
   * (engine/executors/stuck.ts). The turn was interrupted; the reason quotes the call and the
   * error. Never hops harnesses — another harness would not unstick the same call.
   */
  | "stuck"
  /** HOW-38: an agent turn ran past its `turnTimeoutMs` ceiling and its process group was killed */
  | "turn-timeout"
  | "executor-threw"
  | "max-visits"
  | "no-edge"
  | "max-steps"
  | "ambiguous-effect"
  | "awaiting-approval"
  | "approval-missing"
  | "stale-base";

export type ResolutionSource = "operator" | "resume";

/**
 * system-map 1a (D18): the worktree identity a proposal was drawn against. Computed by
 * engine/reconcile.ts fingerprint(); defined here because events carry it.
 *   head       HEAD commit (null: no commit yet)
 *   tracked    hash of `git status --porcelain` (tracked only) + worktree diff + staged diff
 *   untracked  hash of the untracked, non-ignored files' NAMES AND CONTENTS
 */
export interface Fingerprint {
  head: string | null;
  tracked: string;
  untracked: string;
}

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
      /**
       * HOW-18: the operator's label for the run (core/run-name.ts normalizes it). Display
       * only — the run id stays identity for the run dir, worktree and branch. Absent when no
       * name was given, so a log written before this field reads exactly as it did.
       */
      name?: string;
      /**
       * HOW-23: the run that launched this one (`plan-feature`'s `runs:launch`). Lineage and
       * display only — exactly like `name`, the run id stays identity, and nothing in the
       * engine routes on it: a child is an ordinary independent run whose parent does not
       * supervise it. Absent for a run an operator started, so an older log reads unchanged.
       */
      parent?: string;
      /** where the run works — recorded once; the reconciler probes it, the IDE button opens it */
      cwd?: string;
      folder_kind?: "repo" | "plain";
      /** run-level agent overrides — persisted so RESUME keeps them (they beat everything) */
      overrides?: { harness?: Harness; model?: string; effort?: string; permissionMode?: string; maxTurns?: number; skills?: string[] };
      /** prompt versions pinned at start (OV-2) — revisions apply to new runs only */
      pinned_prompts: Partial<Record<PromptId, number>>;
      /**
       * system-map 1c review: per pinned prompt that `{{> id }}`-includes others, the version of
       * every prompt it included (transitively) — the pinned text is the expansion of all of them
       */
      pinned_includes?: Record<string, Record<string, number>>;
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
      /** the effort the harness was SENT (already mapped for it by core/harnesses.ts effortFor) */
      effort?: string;
      /**
       * HOW-33: why an effort some layer set did NOT reach this harness ("effort high: not
       * supported by cursor"). Absent: no effort was set, or it was sent as `effort` says.
       */
      effort_inert?: string;
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
      /**
       * system-map 1c review: the prompts this one `{{> id }}`-included, with their pinned
       * versions — prompt_version alone does not identify the text when an included prompt moved
       */
      includes?: Record<string, number>;
      /**
       * HOW-14: the visit of this node whose context window filled, when this render carries the
       * re-entry briefing (suffix v4+). A suffix INPUT like `skills`, so reconstruction rebuilds
       * the briefing from the log rather than guessing. Absent: no briefing was rendered.
       */
      reentry_after_visit?: number;
      /**
       * HOW-37: which core/template.ts substitution rules rendered the body. Absent: v1 (every
       * pre-HOW-37 render). Reconstruction picks the same rules, so old runs stay VERIFIED.
       */
      render_version?: number;
      /** HOW-37 (v2): the cap in force — a render input like `skills` */
      context_cap?: number;
      /**
       * HOW-37 (v2): the keys whose value was ELIDED in this render, each with the source its
       * stub named. Only elided keys appear; `context_read` still holds every value in full.
       */
      context_sources?: Record<string, string>;
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
      /**
       * HOW-38 — tool_call only: adapter/tools.ts argumentsHash over the FULL arguments, taken
       * before `content` was clipped to 400 chars. Absent on older chunks.
       */
      input_hash?: string;
      /** HOW-38 — tool_result only: the harness said the call failed. Absent: not reported. */
      is_error?: boolean;
    }
  | {
      /**
       * HOW-43: a visit filled its context window and the ENGINE continued the node itself — a
       * fresh visit on the same harness, briefed with the handoff (suffix v5) — instead of
       * parking. The decision is a fact in the log so a human reading it sees that an automatic
       * continuation happened and why; `retry` of `budget` is how much of the node's
       * `contextRetries` this used, and `head` the worktree HEAD at that moment (the no-progress
       * check compares the next exhaustion against it).
       */
      type: "context-continued";
      node: string;
      visit: number;
      retry: number;
      budget: number;
      head: string | null;
    }
  | {
      /**
       * HOW-38: the agent has called one tool with identical arguments `count` times in a row
       * (`failing` of them failed, consecutively) — logged once per streak at the warn
       * threshold. A fact, not a park: the turn carries on, and `reminded` says whether the
       * harness was also sent a mid-turn reminder (claude only, see stuck.ts).
       */
      type: "stuck-warning";
      node: string;
      visit: number;
      tool_name: string;
      /** the call's arguments as logged, clipped */
      input_summary: string;
      count: number;
      failing: number;
      reminded: boolean;
    }
  | {
      type: "turn-finalized";
      node: string;
      visit: number;
      /** HOW-34: 1 for the attempt's turn, 2 for the outputs-repair follow-up on the same session */
      turn: number;
      /** HOW-34: absent fields are UNKNOWN (pre-HOW-34 events have no cache figures) — log/usage.ts */
      usage?: TurnUsage;
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
      /**
       * system-map 1c: a failed attempt whose proposal the graph's validateProposal refused —
       * the refusal text. Replay carries it to the node's next attempt, which renders it
       * (core/template.ts refusalInstruction, suffix v3); reconstruction rebuilds it from here.
       */
      refused?: string;
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
      /**
       * HOW-3: a human attested to an AMBIGUOUS effect (an intent with no done, which the
       * resume probe could not decide). Additive — the intent is never edited. `happened`
       * replays exactly like side-effect-done; `not-happened` clears the intent so the
       * retry claims and runs the effect again. `node`/`visit`/`attempt_id` are copied
       * verbatim from the intent, so the identity matches it and the viewer row lands on
       * the right node@visit.
       */
      type: "side-effect-resolved";
      node: string;
      visit: number;
      attempt_id: string;
      effect: string;
      verdict: "happened" | "not-happened";
      by: "operator";
    }
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
      /**
       * HOW-25: the STRUCTURED answer to a `user-question` ask — which options were picked,
       * per question. Additive, exactly like `code` and `source` before it: `reply` still
       * carries the same answer as prose (core/ask.ts answersToReplyText), so every existing
       * reader of `reply` — the thread, the digest, deriveLogRows, `howdah reply` — is
       * untouched. Absent on every other kind of resolution.
       */
      answers?: AskAnswer[];
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
  /*
   * system-map 1a — proposal rounds and the decisions on them (engine/slice-decision.ts is
   * the only reader that answers "what is the current proposal, and what was decided?").
   */
  | {
      /**
       * A proposal ROUND opened: `node` wrote `approval`'s proposal key and the graph's
       * validateProposal accepted it. `proposal_id` is this event's own seq, so an identical
       * redraw is a new, decidable round. Named for 1c's ghosts; 1a treats `proposal` as opaque.
       */
      type: "ghost-proposed";
      node: string;
      /** the approval node that decides this round */
      approval: string;
      proposal_id: number;
      proposal_hash: string;
      /** the base snapshot's manifest_hash when the round opened — decisions bind to it */
      manifest_hash: string | null;
      /** the live worktree fingerprint when the round opened: tells "changed during the proposer" from "changed since" */
      fingerprint: Fingerprint | null;
      proposal: unknown;
    }
  | {
      /** an operator comment pinned to an entity of the CURRENT round; sent with its feedback */
      type: "comment-pinned";
      id: string;
      entity_id: string;
      proposal_id: number;
      text: string;
    }
  | {
      type: "slice-feedback-sent";
      proposal_id: number;
      proposal_hash: string;
      manifest_hash: string | null;
      /** the round's comment-pinned ids, in pin order */
      comment_ids: string[];
    }
  | { type: "slice-approved"; proposal_id: number; proposal_hash: string; manifest_hash: string | null }
  | {
      /**
       * `redesign <run> <msg>`: written in ONE append with its operator-jump (reset_budgets)
       * to `approval`'s redesignTo. Consumed when that redesignTo node next succeeds (it
       * seeds the approval's feedback key), which is how the message reaches the proposer once.
       */
      type: "slice-redesign-requested";
      /** the approval node whose proposer this message is for */
      approval: string;
      message: string;
    }
  /*
   * system-map 1c — the map built-ins (engine/executors/map.ts). The manifests themselves live
   * in runs/<id>/maps/<manifest_hash>.json and the objects in the content-addressed store;
   * these events carry only bounded summaries, so the log stays small.
   */
  | {
      /** a snapshot was extracted (map:extract / map:reextract) and its manifest written */
      type: "map-extracted";
      node: string;
      visit: number;
      manifest_hash: string;
      /** the commit the snapshot's tracked files came from (HEAD; the worktree diff is on top) */
      commit: string | null;
      /** the worktree had uncommitted or untracked source changes: the snapshot is commit + those changes */
      dirty: boolean;
      /** the object store the snapshot's objects were written to — loaders assemble from it */
      store: string;
      /** the worktree fingerprint the snapshot was extracted at (D18) */
      fingerprint: Fingerprint;
      /** which extraction layers ran (SM-D4) — slice 1 runs tree-sitter only: ["syntactic"] */
      tiers_run: string[];
      /** counts, not lists: the manifest names each file and region */
      unparsed: number;
      skipped: number;
      not_checked: number;
      files: number;
    }
  | {
      /** extraction progress, throttled — the viewer shows movement on a cold parse */
      type: "map-progress";
      node: string;
      visit: number;
      done: number;
      total: number;
      skipped: number;
    }
  | {
      /**
       * map:drift compared the approved ghosts with base vs after (D19). `commit` is the after
       * snapshot's commit — what every `verified` refers to (D21). Items are capped (worst
       * outcome first); `counts` covers every item.
       */
      type: "drift-detected";
      node: string;
      visit: number;
      commit: string | null;
      /** "<sha>" or "<sha> + uncommitted changes" — a dirty after snapshot reports nothing verified */
      stamp: string;
      dirty: boolean;
      base_commit: string | null;
      manifest_hash: string;
      base_manifest_hash: string;
      counts: Record<DriftOutcome, number>;
      items: DriftItem[];
      truncated: number;
      /** the recorded base came from another extractor version and was re-extracted at its commit (base_manifest_hash is the new one) */
      base_reextracted?: boolean;
      /** base and after still come from different extractors (re-extraction impossible): every ghost item is not-checked */
      extractor_mismatch?: { base: string; after: string };
    }
  | {
      /**
       * HOW-23: this run launched a child run — one `implement-ticket` per approved slice of a
       * `plan-feature` decomposition (`runs:launch`, engine/executors/launch.ts).
       *
       * It is a FACT about the fan-out, recorded once per child, beside the
       * `side-effect-intent` / `side-effect-done` pair that makes the spawn exactly-once. The
       * child's own log is the authority on what the child did — this event only says that it
       * exists, and which slice and ticket it came from, so the viewer can link the two without
       * a sidecar record of a relationship the logs already imply.
       */
      type: "run-spawned";
      node: string;
      visit: number;
      /** the child's run id (`<parent>--<slice id>`, deterministic so a retry cannot double-launch) */
      child: string;
      /** the graph the child runs — `implement-ticket` today, named so it stays readable if that changes */
      graph: string;
      slice_id: string;
      /** the tracker identifier the slice was raised as, when there is one */
      ticket?: string;
      workspace?: string;
    }
  | { type: "run-finished"; outcome: RunOutcome };

export type LoggedEvent = RunEvent & Stamped;
