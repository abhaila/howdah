/**
 * Claude Code adapter — maps `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages --permission-prompt-tool stdio` wire events to
 * normalized AgentEvents. Wire shapes verified in agent-deck/spike-findings.md (S2):
 * the permission round-trip REQUIRES --permission-prompt-tool stdio; `manual` alone is
 * a dead end that emits permission_denied and ends the turn.
 */
import type { AgentEvent } from "./events";

/** argv for a headless claude session the engine can own. */
export function claudeArgs(opts: { sessionId: string; permissionMode?: string; resume?: boolean; model?: string; maxTurns?: number }): string[] {
  return [
    "-p",
    "--verbose", // required by --output-format stream-json under -p (claude >= 2.1.2xx)
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    "--permission-mode", opts.permissionMode ?? "auto",
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
  ];
}

export function mapClaudeEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];

  switch (e.type) {
    case "system":
      if (e.subtype === "init" && typeof e.session_id === "string")
        return [{ type: "session_started", session_id: e.session_id }];
      return [];

    case "stream_event": {
      const inner = e.event;
      if (inner?.type === "content_block_delta") {
        if (inner.delta?.type === "text_delta") return [{ type: "text_delta", text: inner.delta.text ?? "" }];
        if (inner.delta?.type === "thinking_delta") return [{ type: "thinking_delta", text: inner.delta.thinking ?? "" }];
      }
      return [];
    }

    case "assistant": {
      // complete assistant message: tool_use blocks become tool_call events
      const content = e.message?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b: any) => b?.type === "tool_use")
        .map((b: any): AgentEvent => ({ type: "tool_call", id: String(b.id), name: String(b.name), input: b.input }));
    }

    case "user": {
      const content = e.message?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b: any) => b?.type === "tool_result")
        .map((b: any): AgentEvent => ({
          type: "tool_result",
          id: String(b.tool_use_id),
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          is_error: b.is_error === true ? true : undefined,
        }));
    }

    case "control_request":
      if (e.request?.subtype === "can_use_tool")
        return [{
          type: "permission_request",
          id: String(e.request_id),
          tool_name: String(e.request.tool_name),
          input: e.request.input,
          suggestions: e.request.permission_suggestions,
        }];
      return [];

    case "result":
      return [{
        type: "turn_end",
        usage: {
          input_tokens: e.usage?.input_tokens,
          output_tokens: e.usage?.output_tokens,
          cost_usd: e.total_cost_usd,
        },
        error: e.is_error ? String(e.result ?? e.subtype ?? "error") : undefined,
        result_text: !e.is_error && typeof e.result === "string" ? e.result : undefined,
      }];

    case "rate_limit_event": {
      const status = e.rate_limit?.status ?? e.status;
      return [{
        type: "rate_limit",
        state: status === "rejected" || status === "exhausted" ? "exhausted" : "ok",
        remaining: typeof e.rate_limit?.remaining === "number" ? e.rate_limit.remaining : undefined,
        resets_at: e.rate_limit?.resetsAt ?? e.rate_limit?.resets_at,
        raw: e,
      }];
    }

    default:
      return []; // unknown types are ignored, never fatal — the CLI is a moving target
  }
}

/** stdin reply to a permission_request (S2 wire shape, verified). */
export function buildClaudePermissionResponse(
  requestId: string,
  decision: { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message?: string },
): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response: decision },
  }) + "\n";
}

/** stdin frame for a user turn. */
export function buildClaudeUserTurn(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n";
}
