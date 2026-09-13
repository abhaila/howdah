/**
 * Normalized agent events — the adapter seam (shaping A4.1, lifted from
 * agent-deck/spike-findings.md). The engine, log, and viewer only ever see THIS type;
 * adding a fourth harness is one mapper file, nothing downstream changes.
 *
 * Mappers are pure: wire object in, zero-or-more AgentEvents out. Process spawning,
 * stdio plumbing, and reply writing live with the engine; adapters only translate.
 */
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
    }
  | {
      type: "turn_end";
      usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
      /** harness-reported error for the turn, if any */
      error?: string;
    }
  | {
      type: "rate_limit";
      state: "ok" | "exhausted" | "unreachable" | "unavailable";
      remaining?: number;
      resets_at?: string;
      raw: unknown;
    }
  | { type: "error"; message: string };
