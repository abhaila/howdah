/**
 * `runs:launch` — HOW-23's fan-out built-in: one detached `implement-ticket` run per approved
 * slice of a `plan-feature` decomposition, each with its own worktree, branch, PR and ticket.
 *
 * It runs IN-PROCESS behind the command executor, beside the map built-ins and `probe:pr`, for
 * the same reasons: a shell command cannot read the node's declared reads, cannot append typed
 * events, and cannot take the engine's exactly-once `effects` handle. Launching a run IS a side
 * effect, and the most expensive one in the system — N agent harnesses, each spending tokens —
 * so the whole point of doing it here is that the engine's intent-before / proof-after record
 * covers it.
 *
 * THE PARENT NEVER SUPERVISES ITS CHILDREN. It launches them and finishes. A child is an
 * ordinary independent run: it parks for its own operator, fails on its own terms and merges
 * its own PR, and nothing in this file waits for any of that. `depends_on` is advisory — it
 * orders the launches and is written into the ticket body as prose. (Wave-gating a dependent
 * slice on its prerequisite's merge is a follow-up, not this ticket.)
 *
 * Exactly-once, three guards deep, because a half-finished fan-out is the failure that costs
 * real money:
 *   1. NOTHING IS SPAWNED UNTIL EVERYTHING CHECKS OUT. The plan is re-validated, slices and
 *      tickets must match one-to-one, and every resolved workspace must be a registered repo.
 *      A failure here fails the attempt with the reason — the run parks with nothing launched,
 *      rather than three good slices started and a fourth that can never be.
 *   2. DETERMINISTIC CHILD IDS (`<parent>--<slice id>`, which is why the slice id grammar in
 *      graphs/slice-plan.ts is a path-safe slug). A re-attempt sees the child's run directory
 *      and records it as skipped instead of starting a second run on the same ticket —
 *      observed reality beats recorded state.
 *   3. `effects.claim()` / `done()` around each spawn. A death between the two leaves an
 *      AMBIGUOUS intent, which parks the run for `howdah resolve-effect` rather than guessing.
 *
 * The spawn itself goes through a `spawn` seam, defaulted to a detached, unref'd `Bun.spawn`,
 * for the same reason `ServerOpts.spawnRun` and `CommandExecutorOpts.prProbe` have one: the
 * real thing starts an engine that spends tokens, so a test must never reach it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AttemptResult, ExecArgs, Executor } from "../run";
import { declaredWrites } from "./map";
import { launchArgs, type LaunchRequest } from "../../core/launch-args";
import { normalizeRunName } from "../../core/run-name";
import { validateSlicePlan, type Slice, type SlicePlan } from "../../graphs/slice-plan";

export const LAUNCH_BUILTIN = "runs:launch";

/** The graph every child runs. Named here rather than inlined: the log records it per child. */
export const CHILD_GRAPH = "implement-ticket";

/**
 * The context keys this built-in reads, by NAME — the map built-ins name `map.base` and
 * `map.neighbourhood` the same way. A built-in is half of a graph contract, not a generic
 * shell step, so the keys are part of it and a node that declares different ones is refused
 * rather than guessed at.
 */
export const PLAN_KEY = "plan.slices";
export const TICKETS_KEY = "tickets";

export function isLaunchBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === LAUNCH_BUILTIN;
}

/** A ticket the `tickets.create` step raised, joined to its slice by `slice_id`. */
export interface SliceTicket {
  slice_id: string;
  identifier: string;
  url: string;
  title?: string;
}

/** What `runs:launch` publishes: what started, and what was already running and was not restarted. */
export interface LaunchResult {
  launched: Array<{ slice_id: string; ticket: string; run_id: string; workspace: string }>;
  skipped: Array<{ slice_id: string; run_id: string; reason: string }>;
}

/**
 * The workspace registry, injected rather than loaded — the engine stays free of config
 * reading, exactly as the worktree executor takes `reposDir` / `repoName` from its caller.
 */
export interface WorkspaceLookup {
  /** the registered REPO workspace names — the only workspaces a child run can be built in */
  repoNames(): string[];
  /** the registered name for a path, or null when nothing is registered at it */
  nameFor(path: string): string | null;
}

export interface LaunchBuiltinOpts {
  /** `$HOWDAH_HOME/runs` — where a child's run directory would already be */
  runsDir?: string;
  /** the entrypoint a child is spawned through (there is no installed `howdah` binary) */
  cliEntry?: string;
  workspaces?: WorkspaceLookup;
  /** default: detached, unref'd `bun <cliEntry> <argv>` inheriting this process's env */
  spawn?: (argv: string[]) => void;
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

export function launchBuiltinExecutor(opts: LaunchBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, runId, log, reads, effects } = args;
    if (def.kind !== "command") throw new Error("runs:launch on a non-command node");
    const runsDir = opts.runsDir;
    if (!runsDir) return failed(`${LAUNCH_BUILTIN} has no runs directory to launch into (the executor was built without one)`);
    const workspaces = opts.workspaces;
    if (!workspaces) return failed(`${LAUNCH_BUILTIN} has no workspace registry to resolve a slice's workspace through`);

    const started = log.read().find((e) => e.type === "run-started");
    const checked = precheck(reads, def, workspaces, started?.type === "run-started" ? started.cwd : undefined);
    if ("status" in checked) return checked;

    const cliEntry = opts.cliEntry ?? join(import.meta.dir, "..", "..", "cli", "main.ts");
    const spawn = opts.spawn ?? ((argv: string[]) => void Bun.spawn(["bun", cliEntry, ...argv], { stdout: "ignore", stderr: "ignore", env: { ...process.env } }).unref());
    const overrides = started?.type === "run-started" ? started.overrides : undefined;

    const result: LaunchResult = { launched: [], skipped: [] };
    for (const { slice, ticket, workspace } of checked.targets) {
      const child = childRunId(runId, slice.id);
      // an existing child run dir: a re-attempt, a resume, or an operator jump back onto this
      // node — never a reason to start a second run against the same ticket
      if (existsSync(join(runsDir, child, "run.jsonl"))) {
        result.skipped.push({ slice_id: slice.id, run_id: child, reason: `run ${child} already exists` });
        continue;
      }
      const effect = `launch-run:${child}`;
      if (effects.claim(effect)) {
        result.skipped.push({ slice_id: slice.id, run_id: child, reason: `run ${child} was already launched by an earlier attempt of ${nodeId}` });
        continue;
      }
      spawn(launchArgs(childRequest(slice, ticket, workspace, checked.plan, runId, overrides), child));
      effects.done(effect, { child, workspace, ticket: ticket.identifier });
      log.append({
        type: "run-spawned", node: nodeId, visit,
        child, graph: CHILD_GRAPH, slice_id: slice.id, ticket: ticket.identifier, workspace,
      });
      result.launched.push({ slice_id: slice.id, ticket: ticket.identifier, run_id: child, workspace });
    }

    return { status: "succeeded", writes: declaredWrites(LAUNCH_BUILTIN, def, { launched: result }) };
  };
}

/** `<parent>--<slice id>`: deterministic, so a retry recognises its own earlier launch. */
export function childRunId(parentRunId: string, sliceId: string): string {
  return `${parentRunId}--${sliceId}`;
}

interface Target {
  slice: Slice;
  ticket: SliceTicket;
  /** the registered workspace the child is launched in — never a path */
  workspace: string;
}

/**
 * Everything that could refuse the fan-out, decided BEFORE the first spawn. Returns the
 * launch order (dependencies first) or the one reason the whole node fails.
 */
function precheck(
  reads: ExecArgs["reads"],
  def: Extract<ExecArgs["def"], { kind: "command" }>,
  workspaces: WorkspaceLookup,
  parentCwd: string | undefined,
): { plan: SlicePlan; targets: Target[] } | Failed {
  const declared = ((def.reads ?? []) as readonly string[]);
  for (const key of [PLAN_KEY, TICKETS_KEY])
    if (!declared.includes(key))
      return failed(`${LAUNCH_BUILTIN} reads "${key}", which this node does not declare (it declares: ${declared.join(", ") || "nothing"})`);

  // the plan was already validated when the round opened; checking it again is what makes an
  // operator jump straight onto this node safe, and costs one pass over at most 8 slices
  const validated = validateSlicePlan(reads[PLAN_KEY], { knownWorkspaces: workspaces.repoNames() });
  if (!validated.ok) return failed(`the approved plan in "${PLAN_KEY}" is not launchable: ${validated.errors.join("; ")}`);
  const plan = validated.plan;

  const tickets = readTickets(reads[TICKETS_KEY]);
  if (!tickets) return failed(`"${TICKETS_KEY}" is not { "tickets": [ { "slice_id", "identifier", "url" }, … ] } — nothing was launched`);

  const bySlice = new Map<string, SliceTicket>();
  for (const t of tickets) {
    if (bySlice.has(t.slice_id)) return failed(`two tickets name slice "${t.slice_id}" (${bySlice.get(t.slice_id)!.identifier} and ${t.identifier}) — nothing was launched`);
    bySlice.set(t.slice_id, t);
  }
  const ids = new Set(plan.slices.map((s) => s.id));
  for (const t of tickets) {
    if (!ids.has(t.slice_id)) return failed(`ticket ${t.identifier || "(unnamed)"} names slice "${t.slice_id}", which is not in the approved plan — nothing was launched`);
    if (!t.identifier.trim()) return failed(`the ticket for slice "${t.slice_id}" has no identifier — nothing was launched`);
    if (!t.url.trim()) return failed(`ticket ${t.identifier} (slice "${t.slice_id}") has no url — nothing was launched`);
  }

  const targets: Target[] = [];
  for (const slice of launchOrder(plan.slices)) {
    const ticket = bySlice.get(slice.id);
    if (!ticket) return failed(`slice "${slice.id}" was approved but no ticket was raised for it — nothing was launched`);
    const workspace = slice.workspace ?? (parentCwd ? workspaces.nameFor(parentCwd) : null);
    if (!workspace)
      return failed(
        `slice "${slice.id}" names no workspace and this run's folder (${parentCwd ?? "none"}) is not a registered one, ` +
          `so there is nowhere to launch it — register it with \`howdah workspace add\`, or give the slice a workspace`,
      );
    if (!workspaces.repoNames().includes(workspace))
      return failed(
        `slice "${slice.id}" would be built in workspace "${workspace}", which is not a registered REPO workspace — ` +
          `${CHILD_GRAPH} needs one to make a worktree in (registered: ${workspaces.repoNames().join(", ") || "none"})`,
      );
    targets.push({ slice, ticket, workspace });
  }
  return { plan, targets };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A tolerant read of the tickets step's output; null when it is not that shape at all. */
function readTickets(v: unknown): SliceTicket[] | null {
  const list = isRecord(v) && Array.isArray(v.tickets) ? v.tickets : Array.isArray(v) ? v : null;
  if (!list) return null;
  const tickets: SliceTicket[] = [];
  for (const t of list) {
    if (!isRecord(t) || typeof t.slice_id !== "string") return null;
    tickets.push({
      slice_id: t.slice_id,
      identifier: typeof t.identifier === "string" ? t.identifier : "",
      url: typeof t.url === "string" ? t.url : "",
      ...(typeof t.title === "string" ? { title: t.title } : {}),
    });
  }
  return tickets;
}

/**
 * Plan order, with a slice's dependencies ahead of it (Kahn, ties broken by declaration order,
 * so a plan with no dependencies launches exactly as it was written). The validator already
 * refused cycles; anything that somehow survives one is appended in declaration order rather
 * than dropped — a slice with a ticket always gets launched.
 */
export function launchOrder(slices: readonly Slice[]): Slice[] {
  const ids = new Set(slices.map((s) => s.id));
  const pending = slices.map((s) => ({ slice: s, deps: new Set(s.depends_on.filter((d) => ids.has(d) && d !== s.id)) }));
  const done = new Set<string>();
  const ordered: Slice[] = [];
  while (pending.length) {
    const i = pending.findIndex((p) => [...p.deps].every((d) => done.has(d)));
    const next = pending.splice(i === -1 ? 0 : i, 1)[0]!;
    done.add(next.slice.id);
    ordered.push(next.slice);
  }
  return ordered;
}

/** The child's whole launch: its inputs, its workspace, its label, and the parent's overrides. */
function childRequest(
  slice: Slice,
  ticket: SliceTicket,
  workspace: string,
  plan: SlicePlan,
  parentRunId: string,
  parentOverrides: ParentOverrides,
): LaunchRequest {
  const request: LaunchRequest = {
    graph: CHILD_GRAPH,
    inputs: { goal: childGoal(slice, plan), work: childWork(slice, ticket, plan) },
    workspace,
    parent: parentRunId,
  };
  const name = childName(slice, ticket);
  if (name) request.name = name;
  const overrides = inheritedOverrides(parentOverrides);
  if (overrides) request.overrides = overrides;
  return request;
}

type ParentOverrides = Extract<import("../../log/events").RunEvent, { type: "run-started" }>["overrides"];

/**
 * The parent's run-level overrides, carried to every child: a fan-out started on codex fans
 * out to codex, and one pinned to a model or an effort keeps it.
 *
 * `permissionMode` is DELIBERATELY not inherited. The parent's planning step is read-only by
 * declaration, so an operator who launched the parent in `plan` mode was talking about the
 * planning — inheriting it would hand every child a mode in which it cannot edit a file, and
 * a run override beats the node setting, so every child would fail for a reason that never
 * appeared in the plan the operator approved.
 */
function inheritedOverrides(parent: ParentOverrides): LaunchRequest["overrides"] | undefined {
  if (!parent) return undefined;
  const { permissionMode: _ignored, ...inherited } = parent;
  return Object.values(inherited).some((v) => v !== undefined) ? inherited : undefined;
}

/** The slice's own outcome, with the one line of feature context that says what it is part of. */
function childGoal(slice: Slice, plan: SlicePlan): string {
  return plan.feature ? `${slice.goal} (one vertical slice of: ${plan.feature})` : slice.goal;
}

/**
 * The ticket as `implement-ticket` reads it — its prompts render `work` under the heading
 * "Ticket:", so this is the ticket, not a summary of one.
 */
function childWork(slice: Slice, ticket: SliceTicket, plan: SlicePlan): string {
  const parts = [`${ticket.identifier}: ${ticket.title ?? slice.title}`, ticket.url, "", slice.work, "", `How to verify:\n${slice.verify}`];
  if (slice.depends_on.length)
    parts.push("", `Depends on other slices of this feature (each has its own ticket and PR): ${slice.depends_on.join(", ")}`);
  if (plan.out_of_scope.length) parts.push("", `Out of scope for the whole feature: ${plan.out_of_scope.join("; ")}`);
  return parts.join("\n");
}

/**
 * The child's display label: the ticket, then the slice id if that is not a legal run name
 * (a long enough title is not). A label is never worth refusing a launch over.
 */
function childName(slice: Slice, ticket: SliceTicket): string | undefined {
  for (const candidate of [`${ticket.identifier} ${ticket.title ?? slice.title}`, ticket.identifier, slice.id]) {
    const r = normalizeRunName(candidate);
    if (r.ok && r.name) return r.name;
  }
  return undefined;
}
