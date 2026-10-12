/**
 * Normalized agent events — the adapter seam (shaping A4.1, lifted from
 * agent-deck/spike-findings.md). The engine, log, and viewer only ever see THIS type;
 * adding a fourth harness is one mapper file, nothing downstream changes.
 *
 * Mappers are pure: wire object in, zero-or-more AgentEvents out. Process spawning,
 * stdio plumbing, and reply writing live with the engine; adapters only translate.
 */
/**
 * HOW-34: one turn's usage, as comparable as the harness lets it be. Every field is optional
 * and ABSENT MEANS UNKNOWN, never zero (log/usage.ts sums accordingly).
 *
 *   input_tokens                 input NOT served from or written to the prompt cache
 *   cache_read_input_tokens      input read from the cache (claude; codex's cachedInputTokens)
 *   cache_creation_input_tokens  input written to the cache (claude only)
 *   cost_usd                     this turn's price, or null when the harness reports none
 *   cost_source                  "reported" by the harness, or "unpriced" — no price table is
 *                                kept, so nothing here is ever "estimated" today; the value is
 *                                reserved so an estimate can never be mistaken for a report
 */
export interface TurnUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number | null;
  cost_source?: "reported" | "unpriced" | "estimated";
}

export type AgentEvent =
  | { type: "session_started"; session_id: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error?: boolean }
  | {
      type: "permission_request";
      /** answer with this id via the adapter's buildPermissionResponse */
      id: string;
      tool_name: string;
      input: unknown;
      /** escalations the CLI proposes (claude permission_suggestions) — render as one-key options */
      suggestions?: unknown[];
      /** the tool_use block this permission gates, when the harness names it */
      tool_use_id?: string;
      /**
       * HOW-25: the harness's own declaration that this request needs a HUMAN CHOICE, not a
       * yes/no — an AskUserQuestion whose input carries the questions. Answering it allow/deny
       * loses the answer, so the executor routes it to the question card instead. Absent means
       * an ordinary permission, which is why this is a flag and not a heuristic on tool_name.
       */
      requires_user_interaction?: boolean;
    }
  | {
      type: "turn_end";
      /**
       * claude: `cost_usd` is the CLI's `total_cost_usd`, which is SESSION-CUMULATIVE (pinned by
       * adapter/fixtures/claude-turn-cache.jsonl: 0.0041 then 0.0087 over two turns) while the
       * token figures are per turn. The executor turns it into this turn's share.
       */
      usage?: TurnUsage;
      /** harness-reported error for the turn, if any */
      error?: string;
      /** the final assistant text — where the outputs contract is parsed from */
      result_text?: string;
      /**
       * HOW-14: the adapter's verdict that the turn died because the model's context window
       * filled. Set from the harness's own signal, so executors never re-parse error text.
       */
      context_exceeded?: true;
    }
  | {
      /**
       * HOW-14: the harness summarised earlier turns to make room (claude `compact_boundary`,
       * codex `contextCompaction`). Not a failure — the turn carries on — but the agent now
       * works from a summary, which is worth a visible line in the transcript.
       */
      type: "context_compacted";
      trigger?: string;
      pre_tokens?: number;
    }
  | {
      type: "rate_limit";
      state: "ok" | "exhausted" | "unreachable" | "unavailable";
      remaining?: number;
      resets_at?: string;
      raw: unknown;
    }
  | { type: "error"; message: string; context_exceeded?: true }
  /**
   * HOW-47: the harness echoing back a user message it has just CONSUMED (claude
   * `--replay-user-messages`, `isReplay: true`). A message written mid-turn is echoed at the
   * tool boundary it was delivered at, so the echo is the executor's proof of delivery.
   */
  | { type: "user_echo"; text: string };
