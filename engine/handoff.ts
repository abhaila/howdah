/**
 * The structured handoff (HOW-36) — what a visit that ran out of context window had done, so
 * the re-entry is briefed with more than "rediscover everything with git".
 *
 * Re-entry v4 carried one fact from the log (which visit filled up) and told the agent to run
 * git. Everything not in git was lost: which files it read, the failing command it was chasing,
 * what it said it would do next. The harness-design study (HOW-32) finds overflow is the
 * dominant loss under a tight window, and that cheap RULE-BASED elision is the first fix, with
 * LLM summarisation only as a second stage — deferred here until this is measured (HOW-42).
 *
 * A PURE function of the log up to the render, so the engine (rendering) and the prompt
 * library (reconstructing) derive the identical handoff and the render stays VERIFIED. It reads
 * the exhausted visit's chunks through log/trajectory.ts — the same per-harness classification
 * the profile uses — so claude's Read/Edit and codex's commandExecution/fileChange produce the
 * same shape. Tool inputs were logged clipped to 400 characters; the handoff works from what
 * was logged and says so rather than pretending to more.
 */
import type { LoggedEvent } from "../log/events";
import type { Handoff } from "../core/template";
import { deriveProfile } from "../log/trajectory";

/** an executor's or the engine's bracketed transcript note — not the agent speaking */
const NOTE = /^\s*\[[^\]]*\]\s*$/s;

export function deriveHandoff(events: readonly LoggedEvent[], node: string, visit: number, outputKeys: readonly string[]): Handoff {
  const profile = deriveProfile(events, node, visit);
  const chunks = events.filter((e): e is Extract<LoggedEvent, { type: "chunk" }> => e.type === "chunk" && e.node === node && e.visit === visit);
  // the last run of assistant text: everything said after the final tool call or result
  const lastTool = chunks.findLastIndex((c) => c.kind === "tool_call" || c.kind === "tool_result");
  const said = chunks
    .slice(lastTool + 1)
    .filter((c) => c.kind === "text" && !NOTE.test(c.content))
    .map((c) => c.content)
    .join("")
    .trim();
  return {
    visit,
    filesRead: profile.status === "ok" ? profile.files_read : [],
    filesEdited: profile.status === "ok" ? profile.files_edited : [],
    commands: profile.status === "ok" ? profile.commands : [],
    // the TAIL — the most recent statement of intent is at the end of what it said
    lastText: said ? (said.length > 1500 ? `…${said.slice(-1499)}` : said) : null,
    outputsOwed: [...outputKeys],
    noToolCalls: profile.status === "no-data",
  };
}
