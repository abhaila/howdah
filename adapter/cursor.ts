/**
 * Cursor adapter (HOW-17) — maps `cursor-agent -p --output-format stream-json` records to
 * normalized AgentEvents, the third sibling of adapter/claude.ts and adapter/codex.ts.
 * Nothing downstream of AgentEvent changes when a harness is added; that is the whole point
 * of this seam (OV-7 / A4.1).
 *
 * HONESTY NOTE, and it matters: `cursor-agent` is NOT installed on the machine this was
 * written on, so unlike adapter/claude.ts and adapter/codex.ts — whose shapes came from
 * captured live turns in agent-deck/spike-findings.md, replayed in adapter/fixtures/ — the
 * record shapes below come from Cursor's documented stream-json envelope, not from a capture.
 * Two consequences are deliberate:
 *
 *   - Every mapping is DEFENSIVE about the parts the envelope does not pin down (text as a
 *     string or a content array, snake_case or camelCase ids), because guessing one spelling
 *     would silently drop a whole turn's output.
 *   - An UNRECOGNISED record kind maps to [] and is dropped. It is never guessed at, never
 *     coerced into a text chunk. A dropped record costs the viewer one line; a guessed one
 *     would put words in the agent's mouth.
 *
 * Capture a real run into adapter/fixtures/ and pin it the day cursor-agent is installed —
 * adapter/capabilities.ts marks cursor's entries `untested` until then.
 */
import type { AgentEvent } from "./events";

/**
 * argv for a headless cursor-agent turn. Mirrors adapter/claude.ts claudeArgs so the flag
 * policy is unit-testable without spawning anything, and so the executor stays a transport.
 *
 * The prompt rides as the trailing positional argument, which is the documented print-mode
 * form (`cursor-agent -p "..."`). It is not piped on stdin: stdin in that form is EXTRA
 * context appended to a positional prompt, not the prompt itself, so a piped prompt would
 * arrive as an empty request with a note attached.
 *
 * `--trust` is NOT an approval flag: cursor-agent 2026.10.14 refuses to start at all in a
 * directory nobody has trusted ("Workspace Trust Required", exit 1, before any output), and
 * a run's worktree is howdah's own. A read-only node still needs it to read. Approval flags
 * stay the caller's decision (cursorApprovalMode), so a plan node is trusted and still asks.
 */
export function cursorArgs(opts: {
  prompt: string;
  model?: string;
  /** a prior cursor chat id — the in-session repair turn resumes rather than starting over */
  resume?: string;
  /** cursor's approval flags, from engine/executors/cursor.ts cursorApprovalMode */
  approvalFlags?: readonly string[];
}): string[] {
  return [
    "-p", // print mode: one turn, no TTY
    "--output-format", "stream-json",
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.resume ? ["--resume", opts.resume] : []),
    "--trust",
    ...(opts.approvalFlags ?? []),
    opts.prompt,
  ];
}

/** text out of either spelling: a bare string, or claude-shaped content blocks. */
function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  const m = message as Record<string, any> | null;
  if (!m || typeof m !== "object") return "";
  if (typeof m.text === "string") return m.text;
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string)
    .join("");
}

/** the tool a `tool_call` record is about — cursor names the call by its wrapper key */
function toolName(call: unknown): string {
  const c = call as Record<string, any> | null;
  if (!c || typeof c !== "object") return "tool";
  if (typeof c.name === "string") return c.name;
  const key = Object.keys(c)[0];
  return key ?? "tool";
}

export function mapCursorEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];

  switch (e.type) {
    case "system":
      // the init record carries the chat id the repair turn resumes
      if (e.subtype === "init") {
        const id = e.session_id ?? e.sessionId ?? e.chat_id ?? e.chatId;
        return typeof id === "string" && id ? [{ type: "session_started", session_id: id }] : [];
      }
      return [];

    case "assistant": {
      // assistant records stream INCREMENTS of the reply, the way claude's deltas do
      const text = messageText(e.message ?? e.delta ?? e.text);
      return text ? [{ type: "text_delta", text }] : [];
    }

    case "thinking": {
      const text = messageText(e.message ?? e.delta ?? e.text);
      return text ? [{ type: "thinking_delta", text }] : [];
    }

    case "tool_call": {
      const call = e.tool_call ?? e.toolCall;
      const id = String(e.call_id ?? e.callId ?? e.id ?? "");
      const name = toolName(call);
      if (e.subtype === "started") return [{ type: "tool_call", id, name, input: call }];
      if (e.subtype === "completed" || e.subtype === "failed") {
        const inner = (call as Record<string, any> | null)?.[Object.keys(call ?? {})[0] ?? ""];
        const result = inner?.result ?? e.result;
        return [{
          type: "tool_result",
          id,
          content: typeof result === "string" ? result : JSON.stringify(result ?? e.subtype),
          is_error: e.subtype === "failed" ? true : undefined,
        }];
      }
      return []; // an unknown subtype is dropped, not guessed at
    }

    case "result": {
      // the end of the turn: `result` is the final assistant message the contract is read from
      const failed = e.is_error === true || e.subtype === "error";
      const text = typeof e.result === "string" ? e.result : messageText(e.result);
      const usage = e.usage as Record<string, any> | undefined;
      return [{
        type: "turn_end",
        result_text: text || undefined,
        // `||`, not `??`: a failed result with no words at all leaves both operands as the
        // EMPTY STRING, and an empty error reads as no error downstream — the executor's
        // `if (turn.turnError)` would fall through to the outputs check and blame the model
        // for a turn cursor itself said had failed. A failure always carries a sentence.
        error: failed ? String(e.error || text || "cursor reported an error") : undefined,
        // HOW-34: cursor documents tokens and no price — unpriced, never a silent 0
        usage: usage
          ? {
              input_tokens: usage.input_tokens ?? usage.inputTokens,
              output_tokens: usage.output_tokens ?? usage.outputTokens,
              cost_usd: null,
              cost_source: "unpriced" as const,
            }
          : undefined,
      }];
    }

    case "error":
      // `||` for the same reason as the result branch: an empty message is not a message
      return [{ type: "error", message: String(e.message || e.error || "cursor error") }];

    default:
      return []; // unmapped record kinds are dropped, never guessed at
  }
}
