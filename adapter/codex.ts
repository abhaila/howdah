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
 */
import type { AgentEvent } from "./events";

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
      return [];
    }

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
      return [{
        type: "turn_end",
        usage: usage
          ? { input_tokens: usage.input_tokens ?? usage.inputTokens, output_tokens: usage.output_tokens ?? usage.outputTokens }
          : undefined,
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

    case "error":
      return [{ type: "error", message: String(e.params?.message ?? "codex error") }];

    default:
      return [];
  }
}

/** JSON-RPC reply to an approval request (S2: answered with {decision} on the same id). */
export function buildCodexApprovalResponse(id: string | number, decision: "approved" | "denied"): string {
  return JSON.stringify({ id, result: { decision } }) + "\n";
}
