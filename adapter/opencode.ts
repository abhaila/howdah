/**
 * opencode adapter — capability-matrix placeholder. opencode's server mode exposes an
 * SSE event stream; the mapping below covers only the two shapes we have observed
 * (message part deltas, session idle). Everything else is declared unsupported in
 * capabilities.ts rather than guessed at — the matrix is the contract (OV-7).
 */
import type { AgentEvent } from "./events";

export function mapOpencodeEvent(raw: unknown): AgentEvent[] {
  const e = raw as Record<string, any>;
  if (e === null || typeof e !== "object") return [];
  switch (e.type) {
    case "message.part.updated": {
      const part = e.properties?.part;
      if (part?.type === "text" && typeof part.text === "string") return [{ type: "text_delta", text: part.text }];
      return [];
    }
    case "session.idle":
      return [{ type: "turn_end" }];
    case "session.error":
      return [{ type: "error", message: String(e.properties?.error ?? "opencode error") }];
    default:
      return [];
  }
}
