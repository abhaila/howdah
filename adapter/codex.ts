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
 *
 * Server→client REQUESTS (a frame with both `id` and `method`). The 0.162.1 schema lists ten
 * kinds and every one holds the turn until the client answers on that id. Two were answered
 * and the rest were dropped, so a turn that hit one hung with nothing in the transcript —
 * observed live for ten hours on `mcpServer/elicitation/request` (the ChatGPT Linear
 * connector asking to be reconnected; adapter/fixtures/codex-elicitation.jsonl is that
 * capture). Now each kind maps to a `permission_request`, an `elicitation`, or an
 * `unsupported_request`, and the executor answers all three on the wire.
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

/**
 * The items that are NOT tool calls. Everything else codex starts with an id — commandExecution,
 * fileChange, mcpToolCall, the code-mode `exec` (dynamicToolCall), webSearch, and whatever a
 * later version adds — is one, and is shown as one. The list used to be the other way round
 * (two kinds in, the rest dropped), which is how a run sat ten hours inside an MCP call with a
 * transcript that showed nothing and a stuck detector that saw nothing.
 */
const NON_TOOL_ITEMS = new Set(["agentMessage", "userMessage", "reasoning", "contextCompaction", "plan", "todoList", "enteredReviewMode", "exitedReviewMode"]);

function isToolItem(item: unknown): item is Record<string, any> & { type: string; id: string } {
  const it = item as Record<string, unknown> | null | undefined;
  return typeof it?.type === "string" && typeof it.id === "string" && !NON_TOOL_ITEMS.has(it.type);
}

/** what a tool item did, for the transcript — codex spells the output three ways across item kinds */
function toolItemOutput(item: Record<string, any>): string {
  for (const key of ["aggregatedOutput", "output", "result"]) {
    const v = item[key];
    if (typeof v === "string") return v;
    if (v !== undefined && v !== null) return JSON.stringify(v);
  }
  if (typeof item.error === "string") return item.error;
  if (item.error && typeof item.error === "object") return String((item.error as { message?: unknown }).message ?? JSON.stringify(item.error));
  return JSON.stringify(item.status ?? "done");
}

export function mapCodexEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];

  // server → client REQUESTS (carry an id). Every one of these holds the turn until it is
  // answered, so each kind is either modelled here or reported as unsupported — never dropped.
  if (e.id !== undefined && typeof e.method === "string") {
    const id = String(e.id);
    const p = e.params ?? {};
    switch (e.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return [{
          type: "permission_request", id,
          tool_name: e.method.includes("commandExecution") ? "commandExecution" : "fileChange",
          input: { command: p.command, reason: p.reason, grantRoot: p.grantRoot },
        }];
      // the v1 names, still in the 0.162.1 schema; same {decision} answer
      case "execCommandApproval":
      case "applyPatchApproval":
        return [{ type: "permission_request", id, tool_name: e.method, input: { command: p.command, reason: p.reason, cwd: p.cwd } }];
      case "item/permissions/requestApproval":
        return [{ type: "permission_request", id, tool_name: "permissions", input: { permissions: p.permissions, reason: p.reason, cwd: p.cwd } }];
      // HOW-25 for codex: the agent asking the OPERATOR — the questions ride in `input` in the
      // shape core/ask.ts reads, with codex's own question ids kept for the answer
      case "item/tool/requestUserInput":
        return [{ type: "permission_request", id, tool_name: "request_user_input", input: p, requires_user_interaction: true }];
      case "mcpServer/elicitation/request":
        return [{
          type: "elicitation", id,
          server: String(p.serverName ?? "an MCP server"),
          mode: String(p.mode ?? "form"),
          message: String(p.message ?? ""),
          ...(typeof p.url === "string" ? { url: p.url } : {}),
        }];
      default:
        return [{ type: "unsupported_request", id, method: e.method }];
    }
  }

  // notifications
  switch (e.method) {
    case "thread/started":
      return [{ type: "session_started", session_id: String(e.params?.threadId ?? "") }];

    case "item/agentMessage/delta":
      return [{ type: "text_delta", text: String(e.params?.delta ?? "") }];

    case "item/started": {
      const item = e.params?.item;
      if (item?.type === "contextCompaction") return [{ type: "context_compacted" }];
      if (isToolItem(item)) return [{ type: "tool_call", id: item.id, name: item.type, input: item }];
      return [];
    }

    case "thread/compacted": // deprecated twin of the contextCompaction item; codex sends one or the other
      return [{ type: "context_compacted" }];

    case "item/completed": {
      const item = e.params?.item;
      if (isToolItem(item))
        return [{
          type: "tool_result",
          id: item.id,
          content: toolItemOutput(item),
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

/**
 * The id a reply goes back under. mapCodexEvent stringifies every request id (AgentEvent ids
 * are strings), but JSON-RPC matches a response to its request by id VALUE AND TYPE, and the
 * app-server numbers its requests — so a numeric string goes back as the number it was.
 */
function wireId(id: string | number): string | number {
  return typeof id === "string" && /^-?\d+$/.test(id) ? Number(id) : id;
}

/** JSON-RPC reply to an approval request (S2: answered with {decision} on the same id). */
export function buildCodexApprovalResponse(id: string | number, decision: "approved" | "denied"): string {
  return JSON.stringify({ id: wireId(id), result: { decision } }) + "\n";
}

/**
 * `item/permissions/requestApproval` (0.162.1 schema, not captured): the agent asks for an
 * ADDITIONAL permission profile ({fileSystem, network}) and the answer is the profile GRANTED,
 * not a decision — approving grants exactly what was asked, denying grants nothing. It used to
 * match the `/requestApproval` suffix and get a {decision} the schema does not accept.
 */
export function buildCodexPermissionsResponse(id: string | number, granted: unknown): string {
  return JSON.stringify({ id: wireId(id), result: { permissions: granted ?? {}, scope: "turn" } }) + "\n";
}

/**
 * `item/tool/requestUserInput` (0.162.1 schema, not captured — a bare app-server client is not
 * offered the tool, so the shape is read from the schema and pinned by fake-codex): the answers
 * are keyed by codex's OWN question ids, each a list of strings.
 */
export function buildCodexUserInputResponse(id: string | number, answers: Record<string, { answers: string[] }>): string {
  return JSON.stringify({ id: wireId(id), result: { answers } }) + "\n";
}

/** `mcpServer/elicitation/request`: accept / decline / cancel (captured: decline fails the tool cleanly) */
export function buildCodexElicitationResponse(id: string | number, action: "accept" | "decline" | "cancel"): string {
  return JSON.stringify({ id: wireId(id), result: { action } }) + "\n";
}

/** the JSON-RPC refusal for a request nothing here can answer — so the turn carries on */
export function buildCodexErrorResponse(id: string | number, message: string): string {
  return JSON.stringify({ id: wireId(id), error: { code: -32601, message } }) + "\n";
}
