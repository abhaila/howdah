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
 *
 * HOW-47 — steering a running turn, spiked against claude 2.1.296 and pinned in
 * adapter/fixtures/claude-steer.jsonl. A stream-json user message written to stdin while a tool
 * call is in flight is delivered at that tool's result boundary — after the `tool_result`, as
 * its own user message, NOT inside the result — and the agent adopted it in the same turn, which
 * ended in one `result`. The tool call is not lost (unlike a PreToolUse-hook block). With
 * `--replay-user-messages` the CLI echoes every consumed stdin message back as
 * `user { isReplay: true }`, in stream order — so the echo of a steer arrives exactly where it
 * landed, and is mapped to `user_echo` as the executor's proof of delivery.
 *
 * HOW-14 — context exhaustion. Read from claude 2.1.283's own strings and SDK types, NOT from
 * a captured turn (unverified-live, like the cursor adapter; capture one into fixtures/ the
 * first time it happens for real):
 *   - turn died: `result { is_error: true, result: "Prompt is too long…" }` — the CLI's own
 *     constant. Mapped to turn_end.context_exceeded so executors never re-read the text.
 *   - context summarised mid-turn: `system { subtype: "compact_boundary",
 *     compact_metadata: { trigger: "manual"|"auto", pre_tokens, post_tokens? } }` →
 *     `context_compacted`. Not a failure; the turn goes on, on a summary.
 */
import type { AgentEvent } from "./events";
import { harnessSpec } from "../core/harnesses";

/** HOW-41: the flag names live in the harness table, the one home of per-harness facts */
const CLAUDE_TOOL_FLAGS = harnessSpec("claude").toolFlags!;

/** argv for a headless claude session the engine can own. */
export function claudeArgs(opts: {
  sessionId: string; permissionMode?: string; resume?: boolean; model?: string; maxTurns?: number;
  /** HOW-33: already mapped for claude by core/harnesses.ts effortFor — sent verbatim */
  effort?: string;
  /** HOW-41: the node's action space; each name its own argv item, so `Bash(git *)` stays whole */
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  /** HOW-39: a settings JSON (the post-edit diagnostics hook) */
  settings?: string;
  /** HOW-55: which of the operator's settings load */
  settingSources?: string;
}): string[] {
  return [
    "-p",
    "--verbose", // required by --output-format stream-json under -p (claude >= 2.1.2xx)
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool", "stdio",
    // HOW-47: echo every consumed stdin user message (isReplay) — the proof a steer was delivered
    "--replay-user-messages",
    "--permission-mode", opts.permissionMode ?? "auto",
    // HOW-55: which of the operator's settings load — "project,local" unless the workspace opts in
    ...(opts.settingSources ? ["--setting-sources", opts.settingSources] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
    ...(opts.allowedTools?.length ? [CLAUDE_TOOL_FLAGS.allow, ...opts.allowedTools] : []),
    ...(opts.disallowedTools?.length ? [CLAUDE_TOOL_FLAGS.deny, ...opts.disallowedTools] : []),
    ...(opts.settings ? ["--settings", opts.settings] : []),
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
  ];
}

/**
 * HOW-14: does this turn error say the context window filled? Claude's constant first, then a
 * narrow fallback for "exceeds the context window" phrasings. Kept narrow on purpose: a miss
 * degrades to an ordinary `turn error` park carrying the CLI's own words, a false hit would
 * brief the next attempt about a problem it never had.
 */
export function looksContextExceeded(text: string): boolean {
  return /^\s*prompt is too long/i.test(text) || (/\bcontext window\b/i.test(text) && /\bexceed/i.test(text));
}

export function mapClaudeEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];

  switch (e.type) {
    case "system":
      if (e.subtype === "init" && typeof e.session_id === "string")
        return [{ type: "session_started", session_id: e.session_id }, { type: "agent_env", ...agentEnvOf(e) }];
      // HOW-55: a hook ran — SessionStart ones before `init`, others around tool calls
      if ((e.subtype === "hook_started" || e.subtype === "hook_response") && typeof e.hook_name === "string") {
        const out = typeof e.output === "string" ? e.output : typeof e.stdout === "string" ? e.stdout : "";
        const injected = e.subtype === "hook_response" ? injectedContext(out) : undefined;
        return [{
          type: "hook", phase: e.subtype === "hook_started" ? "started" : "response", name: e.hook_name,
          ...(typeof e.exit_code === "number" ? { exit_code: e.exit_code } : {}),
          ...(injected !== undefined ? { injected } : {}),
        }];
      }
      if (e.subtype === "compact_boundary") {
        const meta = e.compact_metadata ?? {};
        return [{
          type: "context_compacted",
          ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
          ...(typeof meta.pre_tokens === "number" ? { pre_tokens: meta.pre_tokens } : {}),
        }];
      }
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
      // HOW-47: a replayed stdin message — the echo that proves a mid-turn steer was consumed
      if (e.isReplay === true) {
        const text = content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
        return text ? [{ type: "user_echo", text }] : [];
      }
      return content
        .filter((b: any) => b?.type === "tool_result")
        .map((b: any): AgentEvent => ({
          type: "tool_result",
          id: String(b.tool_use_id),
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
          // HOW-38: false is a fact too ("it succeeded"), distinct from not reported
          is_error: typeof b.is_error === "boolean" ? b.is_error : undefined,
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

    case "result": {
      const error = e.is_error ? String(e.result ?? e.subtype ?? "error") : undefined;
      return [{
        type: "turn_end",
        // HOW-34: the cache figures are separate fields on the wire, and on a long agent turn
        // most input is cached — `input_tokens` alone was a large undercount
        usage: {
          input_tokens: num(e.usage?.input_tokens),
          cache_read_input_tokens: num(e.usage?.cache_read_input_tokens),
          cache_creation_input_tokens: num(e.usage?.cache_creation_input_tokens),
          output_tokens: num(e.usage?.output_tokens),
          ...(typeof e.total_cost_usd === "number" ? { cost_usd: e.total_cost_usd, cost_source: "reported" as const } : {}),
        },
        error,
        result_text: !e.is_error && typeof e.result === "string" ? e.result : undefined,
        ...(error !== undefined && looksContextExceeded(error) ? { context_exceeded: true as const } : {}),
      }];
    }

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

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

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

/**
 * HOW-55: what the CLI's `system/init` says this session loaded — the agent's ENVIRONMENT, which
 * the rendered prompt and its hash do not cover. Names only; nothing here is trusted to have a
 * shape, so every field degrades to empty rather than throwing.
 */
function agentEnvOf(e: Record<string, any>): Omit<Extract<AgentEvent, { type: "agent_env" }>, "type"> {
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String((x as { name?: unknown })?.name ?? ""))).filter(Boolean) : []);
  return {
    version: typeof e.claude_code_version === "string" ? e.claude_code_version : undefined,
    model: typeof e.model === "string" ? e.model : undefined,
    permission_mode: typeof e.permissionMode === "string" ? e.permissionMode : undefined,
    tools: names(e.tools),
    ...(Array.isArray(e.skills) ? { skills: names(e.skills) } : {}),
    plugins: Array.isArray(e.plugins) ? e.plugins.map((p: any) => ({ name: String(p?.name ?? ""), source: String(p?.source ?? "") })).filter((p: { name: string }) => p.name) : [],
    mcp_servers: Array.isArray(e.mcp_servers) ? e.mcp_servers.map((m: any) => ({ name: String(m?.name ?? ""), source: String(m?.source ?? "") })).filter((m: { name: string }) => m.name) : [],
    memory_paths: e.memory_paths && typeof e.memory_paths === "object" ? Object.values(e.memory_paths).filter((v): v is string => typeof v === "string") : [],
  };
}

/** the `additionalContext` a hook's JSON output injected into the session, if it injected any */
function injectedContext(output: string): string | undefined {
  try {
    const v = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const ctx = v?.hookSpecificOutput?.additionalContext;
    return typeof ctx === "string" && ctx ? ctx : undefined;
  } catch {
    return undefined;
  }
}
