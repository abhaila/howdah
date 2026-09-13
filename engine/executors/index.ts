/**
 * Executor registry (T15): the engine's node-kind implementations, resolved in one place.
 * T15 lands `wait` for real and honest stubs for the rest; T16 fills `agent`, T18 fills
 * `command` and `worktree`. A stubbed node PARKS the run with a reason naming the gap —
 * never a silent no-op.
 */
import type { Executor, EngineOpts } from "../run";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import type { Notifier } from "../attention";

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

/** stub-only registry — tests and dry runs */
export function stubExecutors(): EngineOpts["executors"] {
  return {
    wait: waitExecutor,
    agent: notYet("agent", "stub registry"),
    command: notYet("command", "T18"),
    worktree: notYet("worktree", "T18"),
  };
}

export interface LiveExecutorDeps {
  attentionDir: string;
  viewerBase?: string;
  notifiers?: Notifier[];
  claudeBinary?: string;
  codexBinary?: string;
}

/** the real registry: agent nodes dispatch on their declared harness (default claude) */
export function liveExecutors(deps: LiveExecutorDeps): EngineOpts["executors"] {
  // HOWDAH_MODEL sets the default model until per-node config lands (T17)
  const claude = claudeExecutor({ attentionDir: deps.attentionDir, viewerBase: deps.viewerBase, notifiers: deps.notifiers, binary: deps.claudeBinary, model: process.env.HOWDAH_MODEL });
  const codex = codexExecutor({ attentionDir: deps.attentionDir, viewerBase: deps.viewerBase, notifiers: deps.notifiers, binary: deps.codexBinary });
  return {
    wait: waitExecutor,
    agent: async (args) =>
      (args.def.kind === "agent" && args.def.harness === "codex" ? codex : claude)(args),
    command: notYet("command", "T18"),
    worktree: notYet("worktree", "T18"),
  };
}
