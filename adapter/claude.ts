/**
 * Claude Code adapter — maps `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages --permission-prompt-tool stdio` wire events to
 * normalized AgentEvents. Wire shapes verified in agent-deck/spike-findings.md (S2):
 * the permission round-trip REQUIRES --permission-prompt-tool stdio; `manual` alone is
 * a dead end that emits permission_denied and ends the turn.
 *
 * HOW-25 — how a question for the HUMAN arrives, captured from claude 2.1.278 into
 * adapter/fixtures/claude-ask-user-question.jsonl. It does NOT arrive on a dialog channel.
 * The CLI does carry one (`request_user_dialog`, whose kinds a host declares with
 * `supportedDialogKinds` on an `initialize` control_request), but under `-p` that channel
 * belongs to the cloud host: declaring `ask_user_question` and having the declaration
 * ACKNOWLEDGED still routed the question here, as an ordinary
 *
 *   control_request { subtype: "can_use_tool", tool_name: "AskUserQuestion",
 *                     input: { questions: [...] }, tool_use_id, requires_user_interaction: true }
 *
 * so that is the shape this file maps, and `requires_user_interaction` is the flag that tells
 * an ask-the-human apart from an ordinary permission. The answer channel is narrow to match:
 * the response schema is `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message}`
 * and has no result field, so the operator's choice travels in the deny `message` — answering
 * `allow` runs the tool with no one to ask and returns "The user did not answer the
 * questions." Both halves were probed against the live CLI before this was written.
 * Re-verify on upgrade; the meaning of the payload lives in core/ask.ts.
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
          ...(typeof e.request.tool_use_id === "string" ? { tool_use_id: e.request.tool_use_id } : {}),
          ...(e.request.requires_user_interaction === true ? { requires_user_interaction: true } : {}),
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
