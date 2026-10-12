/**
 * Codex adapter — maps `codex app-server` JSON-RPC frames (v2 notifications verified in
 * agent-deck/spike-findings.md S3) to normalized AgentEvents. Skeleton: the notification
 * mapping is complete for the shapes we captured; thread lifecycle RPC (thread/start,
 * turn/start) is the engine's job and arrives with T8.
 *
 * Operational notes carried from the spike:
 *  - app-server logs verbose traces INCLUDING full system prompts to stderr — keep stderr
 *    out of the UI.
 *  - pin the codex version; regenerate the schema on upgrade (0.137.0 choked on its own
 *    models cache after an enum grew).
 *
 * HOW-14 — a FAILED turn and a full context. Read from the schema 0.154.0 generates
 * (`codex app-server generate-json-schema`), not from a captured turn (unverified-live):
 *   - `turn/completed { turn: { status: "failed", error: TurnError } }` is a failed turn, and
 *     turn_end now says so. Before this every turn/completed read as success, so a failed
 *     codex turn fell through to the outputs check and blamed the model.
 *   - `TurnError.codexErrorInfo === "contextWindowExceeded"` (on that turn error, or on an
 *     `error` notification) is the context window filling → `context_exceeded`.
 *   - an `item/started` of type `contextCompaction` (and the deprecated `thread/compacted`)
 *     is codex summarising the thread → `context_compacted`.
 */
import type { AgentEvent, TurnUsage } from "./events";

/** HOW-14: codex's structured verdict that a turn error was the context window filling */
function isContextWindowExceeded(err: unknown): boolean {
  const info = (err as Record<string, unknown> | null | undefined)?.codexErrorInfo;
  // the enum is a bare string; a variant that grows a payload serialises as { variant: {...} }
  return info === "contextWindowExceeded" || (typeof info === "object" && info !== null && "contextWindowExceeded" in info);
}

/**
 * HOW-34: codex's token figures in the shared TurnUsage shape. Its `inputTokens` INCLUDES the
 * cached part (`cachedInputTokens`), where claude's `input_tokens` excludes it, so the cached
 * share is moved across to make the two comparable. Codex reports no price: `cost_usd` is null
 * and says so, never 0.
 */
export function codexUsage(u: Record<string, any>): TurnUsage {
  const input = num(u.inputTokens ?? u.input_tokens);
  const cached = num(u.cachedInputTokens ?? u.cached_input_tokens);
  return {
    input_tokens: input !== undefined && cached !== undefined ? Math.max(0, input - cached) : input,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    output_tokens: num(u.outputTokens ?? u.output_tokens),
    cost_usd: null,
    cost_source: "unpriced",
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function mapCodexEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];

  // server → client REQUESTS (carry an id) — approvals
  if (e.id !== undefined && typeof e.method === "string" && e.method.endsWith("/requestApproval")) {
    const p = e.params ?? {};
    return [{
      type: "permission_request",
      id: String(e.id),
      tool_name: e.method.includes("commandExecution") ? "commandExecution" : "fileChange",
      input: { command: p.command, reason: p.reason, grantRoot: p.grantRoot },
    }];
  }

  // notifications
  switch (e.method) {
    case "thread/started":
      return [{ type: "session_started", session_id: String(e.params?.threadId ?? "") }];

    case "item/agentMessage/delta":
      return [{ type: "text_delta", text: String(e.params?.delta ?? "") }];

    case "item/started": {
      const item = e.params?.item;
      if (item?.type === "commandExecution" || item?.type === "fileChange")
        return [{ type: "tool_call", id: String(item.id), name: String(item.type), input: item }];
      if (item?.type === "contextCompaction") return [{ type: "context_compacted" }];
      return [];
    }

    case "thread/compacted": // deprecated twin of the contextCompaction item; codex sends one or the other
      return [{ type: "context_compacted" }];

    case "item/completed": {
      const item = e.params?.item;
      if (item?.type === "commandExecution" || item?.type === "fileChange")
        return [{
          type: "tool_result",
          id: String(item.id),
          content: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : JSON.stringify(item.status ?? "done"),
          is_error: item.status === "failed" ? true : undefined,
        }];
      return [];
    }

    case "turn/completed": {
      const usage = e.params?.usage;
      const turn = e.params?.turn;
      const failed = turn?.status === "failed";
      return [{
        type: "turn_end",
        usage: usage ? codexUsage(usage) : undefined,
        ...(failed ? { error: String(turn?.error?.message ?? "codex turn failed") } : {}),
        ...(failed && isContextWindowExceeded(turn?.error) ? { context_exceeded: true as const } : {}),
      }];
    }

    case "account/rateLimits/updated": {
      const rl = e.params ?? {};
      const primary = rl.rateLimits?.primary ?? rl.primary;
      const used = typeof primary?.usedPercent === "number" ? primary.usedPercent : undefined;
      return [{
        type: "rate_limit",
        state: used !== undefined && used >= 100 ? "exhausted" : "ok",
        remaining: used !== undefined ? Math.max(0, 1 - used / 100) : undefined,
        resets_at: primary?.resetsAt,
        raw: e,
      }];
    }

    case "error": {
      // ErrorNotification carries { error: TurnError, willRetry } — surface the real message
      const err = e.params?.error ?? e.params;
      const message = String(err?.message ?? "codex error");
      return [{
        type: "error",
        message: e.params?.willRetry ? `${message} (retrying)` : message,
        ...(isContextWindowExceeded(err) ? { context_exceeded: true as const } : {}),
      }];
    }

    default:
      return [];
  }
}

/** JSON-RPC reply to an approval request (S2: answered with {decision} on the same id). */
export function buildCodexApprovalResponse(id: string | number, decision: "approved" | "denied"): string {
  return JSON.stringify({ id, result: { decision } }) + "\n";
}
