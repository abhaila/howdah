/**
 * Executor registry (T15): the engine's node-kind implementations, resolved in one place.
 * T15 lands `wait` for real and honest stubs for the rest; T16 fills `agent`, T18 fills
 * `command` and `worktree`. A stubbed node PARKS the run with a reason naming the gap —
 * never a silent no-op.
 *
 * `approval` (system-map 1a) is the same real executor in both registries: it spawns no
 * agent and spends no tokens, it only reads the log and probes the worktree.
 *
 * Read-only agent nodes (system-map 1a, D6/5A) resolve to permissionMode "plan"
 * (Engine.resolveAgentConfig). Claude honours that flag directly; codex ignores permission
 * modes, so a plan-mode codex turn runs in codex's read-only sandbox instead, and cursor
 * (HOW-17) drops its auto-approve flag.
 *
 * HOW-17: the agent dispatch is a LOOKUP over every harness, not `!== "codex"`. That old
 * test read "claude or anything else", which is why opencode already ran through the claude
 * executor by accident of phrasing rather than by decision — and why a third harness would
 * have silently spawned `claude` instead of failing loudly.
 */
import type { Executor, EngineOpts } from "../run";
import { claudeExecutor } from "./claude";
import { codexExecutor } from "./codex";
import { cursorExecutor } from "./cursor";
import { defaultHarness, type HarnessName } from "../../core/harnesses";
import { commandExecutor, worktreeExecutor } from "./worktree";
import type { WorkspaceLookup } from "./launch";
import type { VerifyCommand } from "./verify";
import { approvalExecutor } from "./approval";
import type { Notifier } from "../attention";
import { join } from "node:path";

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
    approval: approvalExecutor,
  };
}

export interface LiveExecutorDeps {
  attentionDir: string;
  /** where repos keep their worktrees — $HOWDAH_HOME/repos/<name>/worktrees */
  reposDir?: string;
  /** repo path → the folder name its worktrees live under (default: the directory name) */
  repoName?: (repoPath: string) => string;
  /** HOW-23: $HOWDAH_HOME/runs — where `runs:launch` checks whether a child already exists */
  runsDir?: string;
  /** HOW-23: the workspace registry `runs:launch` resolves a slice's workspace through */
  workspaces?: WorkspaceLookup;
  /** HOW-12: the verification command registered for a repo path (`verify:run`) */
  verifyCommandFor?: (repoPath: string) => VerifyCommand | null;
  viewerBase?: string;
  notifiers?: Notifier[];
  claudeBinary?: string;
  codexBinary?: string;
  cursorBinary?: string;
}

/** the real registry: agent nodes dispatch on their declared harness (default claude) */
export function liveExecutors(deps: LiveExecutorDeps): EngineOpts["executors"] {
  const claude = claudeExecutor({ attentionDir: deps.attentionDir, viewerBase: deps.viewerBase, notifiers: deps.notifiers, binary: deps.claudeBinary });
  const codexDeps = { attentionDir: deps.attentionDir, viewerBase: deps.viewerBase, notifiers: deps.notifiers, binary: deps.codexBinary };
  const codex = codexExecutor(codexDeps);
  const codexReadOnly = codexExecutor({ ...codexDeps, sandbox: "read-only" });
  const cursor = cursorExecutor({ binary: deps.cursorBinary });
  const cursorReadOnly = cursorExecutor({ binary: deps.cursorBinary, readOnly: true });
  // opencode has no CLI of its own yet: it runs through the claude executor, as it always
  // has (core/harnesses.ts marks it `internal` and points its binary at claude's)
  const byHarness: Record<HarnessName, Executor> = { claude, opencode: claude, codex, cursor };
  const readOnlyByHarness: Record<HarnessName, Executor> = { claude, opencode: claude, codex: codexReadOnly, cursor: cursorReadOnly };
  return {
    wait: waitExecutor,
    approval: approvalExecutor,
    agent: async (args) => {
      const harness = args.agentConfig?.harness ?? defaultHarness();
      const table = args.agentConfig?.permissionMode === "plan" ? readOnlyByHarness : byHarness;
      return (table[harness] ?? claude)(args);
    },
    command: commandExecutor({
      launch: {
        runsDir: deps.runsDir ?? join(deps.attentionDir, "..", "runs"),
        ...(deps.workspaces ? { workspaces: deps.workspaces } : {}),
      },
      ...(deps.verifyCommandFor ? { verify: { verifyCommandFor: deps.verifyCommandFor } } : {}),
    }),
    worktree: worktreeExecutor({
      reposDir: deps.reposDir ?? join(deps.attentionDir, "..", "repos"),
      repoName: deps.repoName,
    }),
  };
}
