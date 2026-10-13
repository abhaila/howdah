/**
 * Stacked slices (HOW-57, docs/designs/stacked-fullstack-slices.md) — the node-free half of the
 * contract between `runs:launch`, `implement-stacked`, its two built-ins and the builder.
 *
 * A dependent slice is launched with a `deps` input: one entry per dependency, naming the run
 * that builds it (`<parent>--<slice>`, deterministic — engine/executors/launch.ts childRunId)
 * and how far it must get. It travels as a JSON STRING because a run input is argv text
 * (core/launch-args.ts `-i deps=<json>`), and it is parsed here, once, for every reader.
 *
 * The two built-ins' keys are DATA here, as core/verify.ts does for `verify:run`, because three
 * places must agree and core/ cannot import an executor: the executors' prechecks, the
 * COMMAND_BUILTINS table the graph builder gates a step on, and implement-stacked's spec.
 */
/** How far a dependency must get before the dependent slice starts (decision 2A + G10). */
export type DepUntil = "published" | "merged" | "package";
export const DEP_UNTIL: readonly DepUntil[] = ["published", "merged", "package"];

/** One dependency of a stacked run, as `runs:launch` hands it over. */
export interface DepRef {
  slice: string;
  until: DepUntil;
  /** the run that builds it: `<parent>--<slice>` */
  run_id: string;
  /** the registered workspace it is built in */
  workspace: string;
}

const UNTILS: readonly string[] = DEP_UNTIL;

/**
 * Read a `deps` value — the JSON string a run input carries, or the array itself. Returns the
 * reason it is unreadable rather than throwing, so a built-in can fail the attempt with it.
 */
export function parseDeps(v: unknown): { ok: true; deps: DepRef[] } | { ok: false; reason: string } {
  let raw: unknown = v;
  if (typeof v === "string") {
    try {
      raw = JSON.parse(v);
    } catch {
      return { ok: false, reason: `"deps" is not JSON: ${v.length > 120 ? `${v.slice(0, 117)}…` : v}` };
    }
  }
  if (!Array.isArray(raw)) return { ok: false, reason: `"deps" must be a JSON array of { slice, until, run_id, workspace }` };
  const deps: DepRef[] = [];
  for (const [i, d] of raw.entries()) {
    if (typeof d !== "object" || d === null) return { ok: false, reason: `deps[${i}] is not an object` };
    const r = d as Record<string, unknown>;
    for (const k of ["slice", "run_id", "workspace"] as const)
      if (typeof r[k] !== "string" || (r[k] as string).trim() === "") return { ok: false, reason: `deps[${i}].${k} must be a non-empty string` };
    if (typeof r.until !== "string" || !UNTILS.includes(r.until)) return { ok: false, reason: `deps[${i}].until must be published, merged or package` };
    deps.push({ slice: r.slice as string, until: r.until as DepUntil, run_id: r.run_id as string, workspace: r.workspace as string });
  }
  return { ok: true, deps };
}

/** The dependency this run stacks on — its one `published` dependency — or undefined. */
export function stackBaseDep(deps: readonly DepRef[]): DepRef | undefined {
  return deps.find((d) => d.until === "published");
}

// ---- runs:await ---------------------------------------------------------------------------

export const AWAIT_BUILTIN = "runs:await";
export const DEPS_KEY = "deps";
/** await mode: are the dependencies there yet, and what the run stacks on */
export const AWAIT_PRODUCES = ["deps.ready", "deps.waiting", "deps.base", "deps.base_tip", "deps.prs"] as const;
/** probe mode (in the delivery loop): did the stack base move or merge under this PR */
export const AWAIT_PROBE_PRODUCES = ["deps.base_moved", "deps.base_merged"] as const;
export const AWAIT_READS = [DEPS_KEY] as const;

// ---- git:restack --------------------------------------------------------------------------

export const RESTACK_BUILTIN = "git:restack";
export const RESTACK_READS = ["deps.base", "deps.base_merged", "pr.approved"] as const;
/**
 * `restack.conflict` is "" on success and the exact `git rebase --onto` command on a conflict;
 * `deps.base` / `deps.base_tip` are what the branch is stacked on NOW ("" once the base merged
 * and the branch was replayed onto the default branch — the run is no longer stacked).
 */
export const RESTACK_PRODUCES = ["restack.conflict", "deps.base", "deps.base_tip"] as const;
