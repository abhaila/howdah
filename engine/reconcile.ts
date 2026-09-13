/**
 * Reconciler (shaping A6, eng review D9, OV-5): recorded state is reconciled against
 * observable reality, never trusted over it (R4).
 *
 * Three rules:
 *   A6.1 — git probes run before EVERY node (local, free); forge probes run only before
 *          nodes whose declared reads include forge facts — identical freshness at the
 *          point of use, a fraction of the API calls.
 *   A6.2 — no cached branch name is ever read. The probe is the only source. (Orbital's
 *          branch-drift bug — R4 in the requirements — died of exactly this.)
 *   A6.3 — INTENDED vs OBSERVED: the run records the branch/PR it *owns*; the probe
 *          reports what *is*. Disagreement is surfaced as a fact for the operator, never
 *          auto-resolved. "No PR" and "forge unreachable" are distinct observations.
 */
import { spawnSync } from "node:child_process";
import type { NodeDef } from "../core/graph";

// ---- git (always probed, local) -----------------------------------------------

export interface GitObservation {
  repo: boolean;
  branch: string | null; // null = detached HEAD or not a repo
  head: string | null;
  uncommitted: number;
  /** commits ahead of upstream; null = no upstream configured */
  unpushed: number | null;
}

export type CommandRunner = (cmd: string[], cwd: string) => { code: number; stdout: string };

const defaultRunner: CommandRunner = (cmd, cwd) => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};

export function probeGit(cwd: string, run: CommandRunner = defaultRunner): GitObservation {
  const inRepo = run(["git", "rev-parse", "--is-inside-work-tree"], cwd);
  if (inRepo.code !== 0 || inRepo.stdout.trim() !== "true")
    return { repo: false, branch: null, head: null, uncommitted: 0, unpushed: null };

  const branchR = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchR.code === 0 ? branchR.stdout.trim() : null;
  const headR = run(["git", "rev-parse", "HEAD"], cwd);
  const status = run(["git", "status", "--porcelain"], cwd);
  const unpushedR = run(["git", "rev-list", "@{upstream}..HEAD", "--count"], cwd);

  return {
    repo: true,
    branch: branch === "HEAD" ? null : branch,
    head: headR.code === 0 ? headR.stdout.trim() : null,
    uncommitted: status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim().length > 0).length : 0,
    unpushed: unpushedR.code === 0 ? Number(unpushedR.stdout.trim()) : null,
  };
}

// ---- forge (probed only before declared readers) --------------------------------

/** the three-way observation — "unreachable" must NEVER collapse into "no-pr" */
export type ForgeObservation =
  | { kind: "pr"; state: string; url: string }
  | { kind: "no-pr" }
  | { kind: "unreachable"; error: string };

export type ForgeProbe = (branch: string, cwd: string) => Promise<ForgeObservation>;

/** default probe over the gh CLI; a non-zero exit is UNREACHABLE unless gh says no PR */
export const ghForgeProbe: ForgeProbe = async (branch, cwd) => {
  const r = spawnSync("gh", ["pr", "view", branch, "--json", "state,url"], { cwd, encoding: "utf8" });
  if (r.status === 0) {
    try {
      const j = JSON.parse(r.stdout);
      return { kind: "pr", state: String(j.state), url: String(j.url) };
    } catch {
      return { kind: "unreachable", error: "gh returned unparseable output" };
    }
  }
  const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
  // gh's explicit "no PR found" is the only path to no-pr; anything else is unreachable
  if (/no pull requests? found/i.test(err)) return { kind: "no-pr" };
  return { kind: "unreachable", error: err.trim().slice(0, 200) || "gh failed" };
};

/** context keys that make a node a forge reader (D9) */
export const FORGE_FACTS = ["pr.state", "pr.url", "pr.reviews", "pr.checks"] as const;

export function readsForgeFacts(def: NodeDef<any>): boolean {
  const reads: string[] = "reads" in def && def.reads ? def.reads : [];
  return reads.some((k) => (FORGE_FACTS as readonly string[]).includes(k));
}

// ---- intended vs observed (OV-5) -------------------------------------------------

export interface Intended {
  branch?: string;
  prUrl?: string;
}

export interface Reconciliation {
  git: GitObservation;
  forge: ForgeObservation | null; // null = not probed (node reads no forge facts)
  /** surfaced, never auto-resolved */
  disagreements: string[];
  /** probe timestamp, for the UI's "probed Ns ago" */
  at: string;
}

export class Reconciler {
  /** what the run OWNS — written once when the run claims its identity */
  private intended: Intended = {};

  constructor(
    private readonly cwd: string,
    private readonly deps: { git?: CommandRunner; forge?: ForgeProbe; clock?: () => Date } = {},
  ) {}

  claim(intended: Intended): void {
    this.intended = { ...this.intended, ...intended };
  }

  get claimed(): Readonly<Intended> {
    return this.intended;
  }

  /** run before a node: git always, forge only if the node declares forge reads */
  async reconcile(def: NodeDef<any>): Promise<Reconciliation> {
    const git = probeGit(this.cwd, this.deps.git);
    const disagreements: string[] = [];

    if (this.intended.branch !== undefined && git.branch !== this.intended.branch)
      disagreements.push(
        `intended branch "${this.intended.branch}" but observed ${git.branch === null ? "no branch (detached or missing)" : `"${git.branch}"`}`,
      );

    let forge: ForgeObservation | null = null;
    if (readsForgeFacts(def)) {
      const branch = git.branch ?? this.intended.branch;
      forge = branch
        ? await (this.deps.forge ?? ghForgeProbe)(branch, this.cwd)
        : { kind: "unreachable", error: "no branch to probe" };
      if (forge.kind === "pr" && this.intended.prUrl !== undefined && forge.url !== this.intended.prUrl)
        disagreements.push(`intended PR ${this.intended.prUrl} but observed ${forge.url}`);
      if (forge.kind === "no-pr" && this.intended.prUrl !== undefined)
        disagreements.push(`intended PR ${this.intended.prUrl} but the forge reports no PR for "${branch}"`);
      // unreachable produces NO disagreement: absence of evidence, not evidence of absence
    }

    return { git, forge, disagreements, at: (this.deps.clock?.() ?? new Date()).toISOString() };
  }
}
