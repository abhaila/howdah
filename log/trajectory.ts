/**
 * The behavioural trajectory profile (HOW-35) — what an agent DID in one node@visit, derived
 * from the log by rule. No LLM judge: it is deterministic, testable, and cheap enough to run
 * over every run a prompt ever rendered in.
 *
 * Most of the harness-design study's explanatory power (HOW-32) is this analysis: where runs
 * stop, how many end without editing anything, and whether extra turns are localisation or
 * redundant verification — it is how the paper found that planning helps strong models by
 * cutting verification AFTER THE LAST EDIT, not by fixing faster. Howdah logged every tool call
 * and derived nothing from them; this is that derivation, shared by the run view
 * (web/derive.ts), the reviser (reviser/revise.ts) and the A/B harness (reviser/eval/ab.ts).
 *
 * Honesty rules, each from the ticket's edge cases:
 *   - a visit with no tool chunks is `no-data`, never a profile of zeros (an old log, or a
 *     harness that did nothing observable);
 *   - a call is classified from what the LOG kept (adapter/tools.ts classifyCall): a decision
 *     the 400-char clip could overturn is `unclassified`, not a guess;
 *   - a visit that hit context exhaustion, a pause, an abort, a stuck stop or a ceiling has
 *     its own `termination` and `ended_without_edit: null` — "ran out of room" is not "chose
 *     not to edit";
 *   - the identical-call streak uses the full-argument `input_hash` (HOW-38) when the chunks
 *     carry it, and falls back to the clipped content otherwise — marked `approximate`.
 *
 * Node-free: the browser bundle imports it through web/derive.ts.
 */
import type { LoggedEvent } from "./events";
import { classifyCall, type ToolClass } from "../adapter/tools";

export type Termination =
  | "succeeded" | "failed" | "context-exhausted" | "stuck" | "turn-timeout"
  | "paused" | "aborted" | "running";

export interface CommandRun {
  command: string;
  /** true: succeeded, false: failed, null: the log does not say (pre-HOW-38 chunk) */
  ok: boolean | null;
}

export interface TrajectoryData {
  status: "ok";
  node: string;
  visit: number;
  harness: string;
  termination: Termination;
  turns: number;
  calls: Record<ToolClass, number> & { total: number };
  /** null when the visit did not end normally (see termination) */
  ended_without_edit: boolean | null;
  /** edits to a file already edited earlier in this visit */
  repatch_count: number;
  /** verify calls after the final edit; null when the visit made no edit */
  verify_after_last_edit: number | null;
  longest_identical_streak: number;
  /** the streak was measured on clipped content (no input_hash): two calls that differ past the clip read as identical */
  streak_approximate: boolean;
  /** files read and edited, de-duplicated, in first-seen order */
  files_read: string[];
  files_edited: string[];
  /** every shell command, in order (possibly clipped) */
  commands: CommandRun[];
}

export interface TrajectoryNoData {
  status: "no-data";
  node: string;
  visit: number;
  termination: Termination;
}

export type TrajectoryProfile = TrajectoryData | TrajectoryNoData;

export interface ProfileOpts {
  /** the workspace's verifyCommand — running it counts as verify. Default: read off the log's own verify.result */
  verifyCommand?: string;
}

type Chunk = Extract<LoggedEvent, { type: "chunk" }>;

/** the command `verify:run` ran, if any node of this run published a verify.result */
export function verifyCommandFromLog(events: readonly LoggedEvent[]): string | undefined {
  for (const e of events) {
    if (e.type !== "node-finished") continue;
    const result = e.writes["verify.result"] as { command?: unknown } | undefined;
    if (result && typeof result.command === "string" && result.command) return result.command;
  }
  return undefined;
}

/** how the visit ended, from its own node-finished and the park that followed it */
export function visitTermination(events: readonly LoggedEvent[], node: string, visit: number): Termination {
  const startedAt = events.findIndex((e) => e.type === "node-started" && e.node === node && e.visit === visit);
  const finished = events.find((e) => e.type === "node-finished" && e.node === node && e.visit === visit);
  if (finished?.type === "node-finished") {
    if (finished.status === "succeeded") return "succeeded";
    // HOW-43: an exhaustion the engine continued itself raised no park
    if (events.some((e) => e.type === "context-continued" && e.node === node && e.visit === visit)) return "context-exhausted";
    const park = events.find((e) => e.type === "attention-raised" && e.node === node && e.visit === visit && e.seq > finished.seq);
    const code = park?.type === "attention-raised" ? park.code : undefined;
    if (code === "context-exhausted" || code === "stuck" || code === "turn-timeout") return code;
    return "failed";
  }
  // no node-finished: the runner was interrupted mid-attempt, or it is still going
  const after = startedAt < 0 ? [] : events.slice(startedAt + 1);
  if (after.some((e) => e.type === "run-finished" && e.outcome === "aborted")) return "aborted";
  if (after.some((e) => e.type === "run-paused")) return "paused";
  return "running";
}

export function deriveProfile(events: readonly LoggedEvent[], node: string, visit: number, opts: ProfileOpts = {}): TrajectoryProfile {
  const termination = visitTermination(events, node, visit);
  const chunks = events.filter((e): e is Chunk => e.type === "chunk" && e.node === node && e.visit === visit);
  const callChunks = chunks.filter((c) => c.kind === "tool_call");
  if (callChunks.length === 0) return { status: "no-data", node, visit, termination };

  const rendered = events.filter((e) => e.type === "prompt-rendered" && e.node === node && e.visit === visit).at(-1);
  const harness = (rendered?.type === "prompt-rendered" ? rendered.harness : undefined) ?? "claude";
  const verifyCommand = opts.verifyCommand ?? verifyCommandFromLog(events);
  const results = new Map<string, Chunk>();
  for (const c of chunks) if (c.kind === "tool_result" && c.tool_id) results.set(c.tool_id, c);

  const calls = { inspect: 0, edit: 0, verify: 0, other: 0, unclassified: 0, total: 0 };
  const filesRead: string[] = [];
  const filesEdited: string[] = [];
  const commands: CommandRun[] = [];
  let repatch = 0;
  let lastEdit = -1;
  const classes: ToolClass[] = [];
  let streak = 0, longest = 0, prevKey: string | undefined;
  const approximate = callChunks.some((c) => c.input_hash === undefined);

  callChunks.forEach((c, i) => {
    const cls = classifyCall(harness, c.tool_name ?? "", c.content, verifyCommand ? { verifyCommand } : {});
    calls[cls.cls]++;
    calls.total++;
    classes.push(cls.cls);
    if (cls.cls === "edit") {
      lastEdit = i;
      if (cls.path) {
        if (filesEdited.includes(cls.path)) repatch++;
        else filesEdited.push(cls.path);
      }
    } else if (cls.cls === "inspect" && cls.path && !filesRead.includes(cls.path)) {
      filesRead.push(cls.path);
    }
    if (cls.command !== undefined) {
      const result = c.tool_id ? results.get(c.tool_id) : undefined;
      commands.push({ command: cls.command, ok: result?.is_error === undefined ? null : !result.is_error });
    }
    const key = `${c.tool_name}\u0000${c.input_hash ?? c.content}`;
    streak = key === prevKey ? streak + 1 : 1;
    prevKey = key;
    longest = Math.max(longest, streak);
  });

  const turns = new Set(chunks.map((c) => c.turn)).size;
  const normalEnd = termination === "succeeded" || termination === "failed";
  return {
    status: "ok", node, visit, harness, termination, turns, calls,
    ended_without_edit: normalEnd ? calls.edit === 0 : null,
    repatch_count: repatch,
    verify_after_last_edit: lastEdit < 0 ? null : classes.slice(lastEdit + 1).filter((k) => k === "verify").length,
    longest_identical_streak: longest,
    streak_approximate: approximate,
    files_read: filesRead,
    files_edited: filesEdited,
    commands,
  };
}

/** every agent visit's profile, in the order the visits started */
export function deriveProfiles(events: readonly LoggedEvent[], opts: ProfileOpts = {}): TrajectoryProfile[] {
  const seen = new Set<string>();
  const out: TrajectoryProfile[] = [];
  for (const e of events) {
    if (e.type !== "prompt-rendered") continue;
    const key = `${e.node}@${e.visit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(deriveProfile(events, e.node, e.visit, opts));
  }
  return out;
}

/** one line for the run view: "12 inspect · 3 edit · 4 verify (3 after last edit)" */
export function describeProfile(p: TrajectoryProfile): string {
  if (p.status === "no-data") return p.termination === "running" ? "no tool calls yet" : "no tool calls logged";
  const parts = [`${p.calls.inspect} inspect`, `${p.calls.edit} edit`, `${p.calls.verify} verify`];
  if (p.verify_after_last_edit !== null && p.calls.verify > 0) parts[2] += ` (${p.verify_after_last_edit} after last edit)`;
  if (p.calls.other) parts.push(`${p.calls.other} other`);
  if (p.calls.unclassified) parts.push(`${p.calls.unclassified} unclassified`);
  if (p.repatch_count) parts.push(`${p.repatch_count} re-patch${p.repatch_count === 1 ? "" : "es"}`);
  if (p.ended_without_edit) parts.push("ended without an edit");
  if (p.longest_identical_streak >= 3) parts.push(`longest repeat ×${p.longest_identical_streak}${p.streak_approximate ? " (approx.)" : ""}`);
  if (p.termination !== "succeeded" && p.termination !== "failed") parts.push(`ended: ${p.termination}`);
  return parts.join(" · ");
}
