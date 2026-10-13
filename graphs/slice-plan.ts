/**
 * Slice plans — HOW-23, the proposal `plan-feature` puts in front of the operator.
 *
 * A `SlicePlan` is a decomposition of one large, multi-repo/multi-module feature into vertical
 * slices, each of which becomes ONE Linear ticket and ONE `implement-ticket` run with its own
 * worktree, branch and PR. It is the multi-graph replacement for implement-slice's ghost set:
 * the decision the operator actually wants to make before anything is built is "are these the
 * right slices", not "are these the right identity keys".
 *
 * This module is the check that runs BEFORE the operator ever sees a draft — the engine's
 * `validateProposal` hook turns `{ ok: false, errors }` into an attempt-failed reason that is
 * rendered into the proposer's next attempt (core/template.ts suffix v3), so every refusal is
 * phrased as what is wrong AND what to do instead. Same contract and the same spirit as
 * `map/ghosts.ts validateGhostSet`: pure, node-free, and importing nothing from `engine/`.
 *
 * Two rules exist for reasons outside "the JSON is well-formed", and are load-bearing:
 *
 *   - THE ID GRAMMAR. A slice id becomes part of a child run id (`<parent>--<slice.id>`), which
 *     is a directory name under `$HOWDAH_HOME/runs/` and a `howdah/<run-id>` git branch. Free
 *     text is not a safe path segment, so the grammar is the same kind of rule as
 *     core/run-name.ts's: the id is identity, the title is the label.
 *   - THE CAP. Approving a plan launches every slice at once, so the cap is the operator's
 *     protection against a fan-out that exhausts a harness allowance before they can read it.
 *     A feature bigger than the cap is not refused as "too big" — it is asked for as a smaller
 *     first tranche, which is the decomposition working rather than failing.
 *
 * `depends_on` IS A GATE THE CHILD KEEPS (HOW-57, docs/designs/stacked-fullstack-slices.md).
 * Every slice is still launched at once, and the parent still never supervises (CLAUDE.md, the
 * multi-graph fan-out invariant): a slice WITH dependencies is launched as `implement-stacked`,
 * whose first step waits (`runs:await`) until each dependency reaches its `until`:
 *
 *   - `published` — the dependency has an open (or merged) PR. This slice STACKS on it: its
 *     worktree branches from that PR's head and its PR targets that branch. At most ONE per
 *     slice, and only in the same workspace — a stack cannot cross repositories.
 *   - `merged`    — the dependency's PR merged. The old string form (`"be-1"`) means this.
 *   - `package`   — merged AND the dependency workspace's `packageCheck` (config.json) passes,
 *     e.g. the backend's OpenAPI package is published for the frontend to consume.
 */

import { DEP_UNTIL, type DepUntil } from "../core/stack";

export interface Slice {
  /** kebab id, unique in the plan; becomes part of the child run id */
  id: string;
  /** the ticket's title */
  title: string;
  /** the registered workspace this slice is built in; absent → the parent run's own */
  workspace?: string;
  /** the user-visible outcome this slice delivers (the child run's `goal`) */
  goal: string;
  /** the ticket body: scope, acceptance criteria, modules/files to touch */
  work: string;
  /** how a human confirms it works */
  verify: string;
  /** slices of this plan this one waits for, and how far each must get (HOW-57) */
  depends_on: SliceDep[];
}

export { DEP_UNTIL, type DepUntil };

export interface SliceDep {
  /** the id of a slice in this plan */
  slice: string;
  until: DepUntil;
}

/** The ONE dependency this slice stacks on — its `published` one — or undefined. */
export function stackBase(slice: Pick<Slice, "depends_on">): SliceDep | undefined {
  return slice.depends_on.find((d) => d.until === "published");
}

/** "be-1 (until merged)" — how a dependency reads in a ticket body and a launch note. */
export function describeDep(dep: SliceDep): string {
  return `${dep.slice} (until ${dep.until})`;
}

export interface SlicePlan {
  /** the whole feature in one line */
  feature: string;
  slices: Slice[];
  out_of_scope: string[];
  risks: string[];
}

/**
 * A ticket the `tickets.create` step raised, joined to its slice by `slice_id`. The tracker is
 * reached through the agent's own tooling (as `complete_ticket` already closes tickets), so
 * this is what comes BACK from it — never a client of any tracker's API.
 */
export interface SliceTicket {
  slice_id: string;
  identifier: string;
  url: string;
  title?: string;
}

/**
 * What `runs:launch` publishes: what started, and what was already running and was NOT
 * restarted. `skipped` is a fact, not an error — a re-attempt of the launch step is the normal
 * way an interrupted fan-out finishes, and it has to be able to say so.
 *
 * It lives here rather than with the executor because the graph declares the key and no graph
 * imports an executor.
 */
export interface LaunchResult {
  launched: Array<{ slice_id: string; ticket: string; run_id: string; workspace: string }>;
  skipped: Array<{ slice_id: string; run_id: string; reason: string }>;
}

export type SlicePlanValidation = { ok: true; plan: SlicePlan } | { ok: false; errors: string[] };

export interface SlicePlanOptions {
  /** the repo workspaces registered in config.json — a slice may only name one of these */
  knownWorkspaces: string[];
  /**
   * the workspace the planning run itself is in — what a slice with no `workspace` builds in.
   * Used only to compare a stack base's workspace with its dependent's; unknown (absent),
   * an omitted workspace is only known to equal another omitted one.
   */
  parentWorkspace?: string | null;
}

/**
 * At most this many slices in one plan. The number is a judgement, not a law: it is the point
 * past which a fan-out stops being reviewable in one sitting and starts being a bill.
 */
export const MAX_SLICES = 8;

/** Enough errors to fix a bad draft in one round; more only floods the proposer's context. */
export const MAX_ERRORS = 40;

/** A slice id has to survive being a directory name and a git branch segment. */
export const SLICE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isBlank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

/** A tolerant read of an optional string array (`out_of_scope`, `risks`): absent reads as []. */
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Check a proposed slice plan. Every error names the slice it is about — the proposer sees a
 * flat list and has to be able to tell which of eight drafts to fix.
 */
export function validateSlicePlan(plan: unknown, opts: SlicePlanOptions): SlicePlanValidation {
  const errors: string[] = [];

  if (!isRecord(plan)) return { ok: false, errors: [`the plan must be a JSON object with a "slices" array, not ${describe(plan)}`] };
  if (!Array.isArray(plan.slices)) return { ok: false, errors: [`"slices" must be an array of slices, not ${describe(plan.slices)}`] };
  if (plan.slices.length === 0)
    return { ok: false, errors: ['"slices" is empty — a plan must propose at least one vertical slice to build'] };
  if (plan.slices.length > MAX_SLICES)
    return {
      ok: false,
      errors: [
        `${plan.slices.length} slices is more than the ${MAX_SLICES} one round can launch and a human can review — ` +
          `split the feature into a smaller first tranche and plan the rest once this one has landed`,
      ],
    };

  const seen = new Set<string>();
  const slices: Slice[] = [];
  plan.slices.forEach((raw, i) => {
    const at = `slice ${i + 1}`;
    if (!isRecord(raw)) return void errors.push(`${at} is ${describe(raw)}, not a slice object`);

    const id = raw.id;
    let named: string | null = null;
    if (typeof id !== "string" || !SLICE_ID.test(id))
      errors.push(
        `${at}: id ${JSON.stringify(id ?? null)} is not a slug — it becomes part of the child run id and its git branch, ` +
          `so it must be lower-case letters, digits and hyphens, starting with a letter or digit, at most 41 characters`,
      );
    else if (seen.has(id)) errors.push(`${at}: duplicate id "${id}" — every slice needs its own, it is the child run's identity`);
    else {
      seen.add(id);
      named = id;
    }

    const where = named ? `slice "${named}"` : at;
    for (const field of ["title", "goal", "work", "verify"] as const)
      if (isBlank(raw[field])) errors.push(`${where}: "${field}" is ${describe(raw[field])} — it must be non-empty text (${FIELD_IS[field]})`);

    const workspace = raw.workspace;
    if (workspace !== undefined && workspace !== null) {
      if (typeof workspace !== "string" || workspace.trim() === "")
        errors.push(`${where}: "workspace" is ${describe(workspace)} — omit it to build in this run's own workspace, or name a registered one`);
      else if (!opts.knownWorkspaces.includes(workspace))
        errors.push(
          `${where}: workspace "${workspace}" is not registered, so no run could be launched in it — ` +
            (opts.knownWorkspaces.length
              ? `registered repo workspaces are: ${opts.knownWorkspaces.join(", ")}`
              : `no repo workspaces are registered (add one with \`howdah workspace add\`)`) +
            `, or omit "workspace" to build in this run's own`,
        );
    }

    const deps = readDeps(raw.depends_on, where, errors);
    if (named !== null)
      slices.push({
        id: named,
        title: text(raw.title),
        goal: text(raw.goal),
        work: text(raw.work),
        verify: text(raw.verify),
        depends_on: deps,
        ...(typeof workspace === "string" && workspace.trim() !== "" ? { workspace } : {}),
      });
  });

  // dependencies: only once every id in the plan is known, so a forward reference is fine
  const byId = new Map(slices.map((s) => [s.id, s]));
  const own = "this run's own workspace";
  const workspaceOf = (s: Slice): string | null => s.workspace ?? opts.parentWorkspace ?? null;
  for (const s of slices) {
    for (const dep of s.depends_on) {
      if (dep.slice === s.id) errors.push(`slice "${s.id}": depends_on names itself`);
      else if (!seen.has(dep.slice))
        errors.push(
          `slice "${s.id}": depends_on "${dep.slice}", which is not a slice in this plan — ` +
            `depends_on names the slices of THIS plan (have: ${[...seen].join(", ")})`,
        );
    }
    const published = s.depends_on.filter((d) => d.until === "published");
    if (published.length > 1)
      errors.push(
        `slice "${s.id}": ${published.map((d) => `"${d.slice}"`).join(" and ")} are both "until": "published" — ` +
          `at most one published dependency, which is the stack base this slice's branch is built on; make the others "merged" or "package"`,
      );
    const base = published[0];
    const other = base ? byId.get(base.slice) : undefined;
    if (base && other && other.id !== s.id) {
      const mine = workspaceOf(s);
      const theirs = workspaceOf(other);
      const same = mine !== null && theirs !== null ? mine === theirs : s.workspace === other.workspace;
      if (!same)
        errors.push(
          `slice "${s.id}" (${s.workspace ?? own}) stacks on "${other.id}" (${other.workspace ?? own}) with "until": "published" — ` +
            `a stack base must be in the same workspace; use "merged" or "package" across repos`,
        );
    }
  }
  for (const cycle of dependencyCycles(slices))
    errors.push(`the slices depend on each other in a cycle (${cycle.join(" → ")}) — no slice in it could ever ship first, so break it`);

  if (errors.length) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return {
    ok: true,
    plan: {
      feature: typeof plan.feature === "string" ? plan.feature.trim() : "",
      slices,
      out_of_scope: stringList(plan.out_of_scope),
      risks: stringList(plan.risks),
    },
  };
}

const FIELD_IS = {
  title: "the ticket's title",
  goal: "the user-visible outcome this slice delivers",
  work: "the ticket body: scope, acceptance criteria, modules and files to touch",
  verify: "how a human confirms it works",
} as const;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * A slice's `depends_on`, normalised to `{ slice, until }`. A bare string is the pre-HOW-57
 * form and means `merged` — an old plan keeps working, and now actually waits. Absent or null
 * is no dependencies. Refusals are pushed onto `errors`, each naming the slice.
 */
function readDeps(v: unknown, where: string, errors: string[]): SliceDep[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(
      `${where}: "depends_on" is ${describe(v)} — it must be an array of { "slice": <id>, "until": "published" | "merged" | "package" } ` +
        `(use [] for none)`,
    );
    return [];
  }
  const deps: SliceDep[] = [];
  v.forEach((entry, i) => {
    const at = `${where}: depends_on[${i}]`;
    let dep: SliceDep | null = null;
    if (typeof entry === "string") dep = { slice: entry, until: "merged" };
    else if (isRecord(entry) && typeof entry.slice === "string") {
      const until = entry.until === undefined || entry.until === null ? "merged" : entry.until;
      if (typeof until !== "string" || !(DEP_UNTIL as readonly string[]).includes(until))
        return void errors.push(
          `${at}: "until" is ${typeof until === "string" ? `"${until}"` : describe(until)} — it must be "published" (stack on its open PR, same repo), ` +
            `"merged" (wait for its PR to merge) or "package" (merged, and its package published)`,
        );
      dep = { slice: entry.slice, until: until as DepUntil };
    } else
      return void errors.push(
        `${at} is ${describe(entry)} — each dependency is { "slice": <id of a slice in this plan>, "until": "published" | "merged" | "package" }`,
      );
    if (deps.some((d) => d.slice === dep!.slice))
      return void errors.push(`${at}: "${dep.slice}" is listed twice — name each dependency once, with the furthest "until" it needs`);
    deps.push(dep);
  });
  return deps;
}

/** What a value IS, for a refusal that tells the proposer what it sent rather than what it lacked. */
function describe(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === "string") return v.trim() === "" ? "blank" : "a string";
  return `a ${typeof v}`;
}

/**
 * Every dependency cycle, each named by the slices in it (first id repeated at the end so the
 * message reads as a loop). Iterative DFS over the ids that actually exist — an unknown
 * dependency is already its own error and must not also be reported as a broken cycle.
 */
export function dependencyCycles(slices: readonly Slice[]): string[][] {
  const ids = new Set(slices.map((s) => s.id));
  const edges = new Map(slices.map((s) => [s.id, s.depends_on.map((d) => d.slice).filter((d) => ids.has(d) && d !== s.id)]));
  const state = new Map<string, "open" | "done">();
  const cycles: string[][] = [];
  const found = new Set<string>();

  const walk = (start: string) => {
    const path: string[] = [];
    // [node, index of the next dependency to visit] — an explicit stack, so a deep plan cannot
    // blow the call stack on input the proposer chose
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, "open");
    path.push(start);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const [node, i] = frame;
      const deps = edges.get(node) ?? [];
      if (i >= deps.length) {
        state.set(node, "done");
        path.pop();
        stack.pop();
        continue;
      }
      frame[1] = i + 1;
      const next = deps[i]!;
      if (state.get(next) === "done") continue;
      if (state.get(next) === "open") {
        const cycle = [...path.slice(path.indexOf(next)), next];
        const key = canonicalCycle(cycle);
        if (!found.has(key)) {
          found.add(key);
          cycles.push(cycle);
        }
        continue;
      }
      state.set(next, "open");
      path.push(next);
      stack.push([next, 0]);
    }
  };

  for (const s of slices) if (!state.has(s.id)) walk(s.id);
  return cycles;
}

/** One name per cycle regardless of where the walk entered it: rotate to the smallest id. */
function canonicalCycle(cycle: string[]): string {
  const ring = cycle.slice(0, -1);
  let best = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i]! < ring[best]!) best = i;
  return [...ring.slice(best), ...ring.slice(0, best)].join(">");
}
