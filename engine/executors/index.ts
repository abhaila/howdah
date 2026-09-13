/**
 * Executor registry (T15): the engine's node-kind implementations, resolved in one place.
 * T15 lands `wait` for real and honest stubs for the rest; T16 fills `agent`, T18 fills
 * `command` and `worktree`. A stubbed node PARKS the run with a reason naming the gap —
 * never a silent no-op.
 */
import type { Executor, EngineOpts } from "../run";

export function parseDuration(spec: string): number {
  const m = spec.match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`bad duration: "${spec}"`);
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60_000, h: n * 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"]!;
}

export const waitExecutor: Executor = async ({ def }) => {
  if (def.kind !== "wait") throw new Error("waitExecutor on non-wait node");
  await new Promise((r) => setTimeout(r, parseDuration(def.duration)));
  return { status: "succeeded", writes: {} };
};

const notYet = (what: string, task: string): Executor => async () => {
  throw new Error(`${what} executor not built yet (${task})`);
};

/** the default registry; callers may override any kind (tests do) */
export function defaultExecutors(): EngineOpts["executors"] {
  return {
    wait: waitExecutor,
    agent: notYet("agent", "T16"),
    command: notYet("command", "T18"),
    worktree: notYet("worktree", "T18"),
  };
}
