/**
 * `repair:changed` (HOW-75) — did the delivery repair that just ran change the worktree?
 *
 * A review repair that answers a thread and rightly changes no file used to be parked by HOW-54
 * as `no-progress`. The repairs now declare `changesFiles: false`, and this built-in, run as
 * `delivery.repair_check` straight after each of them, publishes `repair.changed`: false routes
 * to `delivery.wait` (nothing new to review, nothing new to push — the run waits for the PR to
 * move), anything else to the review of repairs exactly as before. The stall HOW-54 guarded
 * against is now caught by the probe (core/repair-stall.ts), which can say what is outstanding.
 *
 * The repair is the step whose `node-started` precedes this one's; where it STARTED is the
 * `reconciled` probe the engine logged before that start (engine/repair-scope.ts
 * startObservation, the same derivation the repair review's scope uses). "Unchanged" needs
 * proof — the same HEAD, and a clean tree both then and now. Every doubtful case (no reconcile
 * on the log, no HEAD, a tree that was dirty at the start, no git at all) answers CHANGED: the
 * cost of that direction is one extra review and publish, the cost of the other is work that
 * is never pushed.
 */
import type { AttemptResult, Executor } from "../run";
import type { LoggedEvent } from "../../log/events";
import { probeGit, type GitObservation } from "../reconcile";
import { startObservation } from "../repair-scope";
import { effectiveCwd } from "./worktree-record";
import { declaredWrites } from "./map";
import { REPAIR_CHANGED_KEY, REPAIR_CHECK_BUILTIN, REPAIR_CHECK_PRODUCES, REPAIR_CHECK_READS } from "../../core/repair-stall";

export { REPAIR_CHECK_BUILTIN } from "../../core/repair-stall";

export function isRepairCheckBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === REPAIR_CHECK_BUILTIN;
}

type StartGit = Extract<LoggedEvent, { type: "reconciled" }>["git"];

/** Changed, or not, with the reason in words. Pure over the two observations. */
export function repairChanged(start: StartGit | undefined, now: Pick<GitObservation, "repo" | "head" | "uncommitted">): { changed: boolean; why: string } {
  if (start === undefined) return { changed: true, why: "no git observation was logged when the repair started" };
  if (!start.repo || !now.repo) return { changed: true, why: "the run is not in a git worktree" };
  if (typeof start.head !== "string" || start.head === "" || typeof now.head !== "string" || now.head === "")
    return { changed: true, why: "HEAD could not be read" };
  if (start.uncommitted > 0) return { changed: true, why: `the worktree already had ${start.uncommitted} uncommitted change(s) when the repair started` };
  if (now.head !== start.head) return { changed: true, why: `HEAD moved ${start.head.slice(0, 7)} → ${now.head.slice(0, 7)}` };
  if (now.uncommitted > 0) return { changed: true, why: `${now.uncommitted} uncommitted change(s) in the worktree` };
  return { changed: false, why: `HEAD is still ${now.head.slice(0, 7)} and the tree is clean` };
}

const firstLine = (v: unknown): string => {
  const text = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

export function repairCheckBuiltinExecutor(opts: { probe?: (cwd: string) => GitObservation } = {}): Executor {
  return async (args): Promise<AttemptResult> => {
    const { def, nodeId, visit, log, cwd, reads } = args;
    if (def.kind !== "command") throw new Error("repair:changed on a non-command node");
    const extra = def.run.trim().split(/\s+/).slice(1);
    if (extra.length) return { status: "failed", writes: {}, reason: `${REPAIR_CHECK_BUILTIN} takes no arguments (got "${extra.join(" ")}")` };
    const producible = REPAIR_CHECK_PRODUCES as readonly string[];
    const unproducible = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
    if (unproducible.length) return { status: "failed", writes: {}, reason: `${REPAIR_CHECK_BUILTIN} cannot produce ${unproducible.join(", ")} — it publishes only ${producible.join(", ")}` };
    // it quotes the repair's own summary in the thread, so the step must read it (the table's `reads`)
    const unread = REPAIR_CHECK_READS.filter((k) => !((def.reads ?? []) as string[]).includes(k));
    if (unread.length) return { status: "failed", writes: {}, reason: `${REPAIR_CHECK_BUILTIN} works from ${unread.join(", ")}, which this step does not read` };

    const events = log.read();
    const mine = events.findLastIndex((e) => e.type === "node-started" && e.node === nodeId && e.visit === visit);
    const at = mine === -1 ? events.length : mine;
    const repairIndex = events.findLastIndex((e, i) => i < at && e.type === "node-started");
    const repairStart = events[repairIndex];
    const repair = repairStart?.type === "node-started" ? `${repairStart.node}@${repairStart.visit}` : "the previous step";
    const workDir = effectiveCwd(log.path, cwd);
    const now = workDir ? (opts.probe ?? probeGit)(workDir) : { repo: false, head: null, uncommitted: 0 };
    const verdict = repairChanged(repairIndex === -1 ? undefined : startObservation(events, repairIndex), now);

    const summary = firstLine(reads.repair_summary);
    const note = verdict.changed
      ? `${repair} changed the worktree (${verdict.why}); on to the review of repairs`
      : `${repair} made no change${summary ? `: ${summary}` : ""}; waiting for the PR to move (${verdict.why})`;
    log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: 0, kind: "text", content: note });
    return { status: "succeeded", writes: declaredWrites(REPAIR_CHECK_BUILTIN, def, { [REPAIR_CHANGED_KEY]: verdict.changed }) };
  };
}
