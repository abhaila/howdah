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
 *
 * Fingerprint (system-map 1a, D18): `fingerprint(cwd)` is the worktree's identity — HEAD,
 * a hash of the tracked changes (status records incl. staged blob ids + the unstaged
 * diff), and a hash of the untracked, non-ignored files' names AND CONTENTS. An approved design is bound to the fingerprint it was drawn against; STALE means
 * the fingerprint CHANGED, never merely that the tree is dirty (a dirty tree the proposer
 * saw is the tree it designed for). The three parts are kept apart so a refusal can say
 * which one moved.
 *
 * Fingerprint limitations (what it cannot see, by design of git's own view):
 *   - files marked `assume-unchanged` or `skip-worktree` are invisible to status and diff,
 *     so edits to them do not move the fingerprint;
 *   - a nested, untracked git repository is one directory entry in status: it is hashed as
 *     "a directory is here", not by its contents;
 *   - ignored files never count (they are not part of what the design is drawn against);
 *   - submodules count only as far as status/diff report them (their commit and dirtiness).
 */
import { spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeReads, type NodeDef } from "../core/graph";
import type { Fingerprint } from "../log/events";

export type { Fingerprint } from "../log/events";

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

export class FingerprintError extends Error {}

/**
 * The worktree's identity (D18), or null when `cwd` is absent or not a git work tree.
 *
 * Three git spawns (rev-parse, `status --porcelain=v2 --branch -z --untracked-files=all`,
 * `diff --binary`), every byte STREAMED into the hash — nothing is buffered to a size limit.
 * (A buffered spawnSync truncates at maxBuffer and reports no exit status, so a large diff
 * once hashed its truncated prefix and a later edit past the cut compared EQUAL: a stale
 * base passed both the approval probe and the gate.) The status v2 records carry HEAD, each
 * tracked change and the staged blob id; the diff carries the unstaged content; the
 * untracked paths come from the same status and their contents are streamed from disk.
 *
 * Any failure — a spawn error, a non-zero exit, a signal, an unreadable untracked file —
 * THROWS FingerprintError. There is no "unknown" value that could ever compare equal:
 * callers park rather than guess (the approval executor and the proposer attempt fail with
 * the reason; the requires gate parks stale-base).
 */
export async function fingerprint(cwd: string | undefined): Promise<Fingerprint | null> {
  if (!cwd) return null;
  const probe = await git(["rev-parse", "--is-inside-work-tree"], cwd, "text").catch(() => null);
  if (probe === null || probe.trim() !== "true") return null;

  const status = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--no-renames"], cwd, "text");
  let head: string | null = null;
  const trackedRecords: string[] = [];
  const untrackedPaths: string[] = [];
  const records = status.split("\0");
  for (const rec of records) {
    if (rec.startsWith("# branch.oid ")) {
      const oid = rec.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid;
    } else if (rec.startsWith("# ") || rec === "") {
      // other headers (branch name, upstream ahead/behind) are not the tree: a fetch must not look like a change
    } else if (rec.startsWith("? ")) untrackedPaths.push(rec.slice(2));
    else trackedRecords.push(rec);
  }

  const tracked = createHash("sha256");
  tracked.update(`status\0${trackedRecords.join("\0")}\0diff\0`);
  await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"], cwd, tracked);

  const untracked = createHash("sha256");
  for (const rel of untrackedPaths.sort()) {
    untracked.update(`${rel}\0`);
    await hashFile(join(cwd, rel), untracked);
    untracked.update("\0");
  }

  return { head, tracked: tracked.digest("hex").slice(0, 16), untracked: untracked.digest("hex").slice(0, 16) };
}

/** Run git, streaming stdout into `sink` (a hash) or collecting it ("text"); throws on any failure. */
async function git(args: string[], cwd: string, sink: "text"): Promise<string>;
async function git(args: string[], cwd: string, sink: Hash): Promise<void>;
async function git(args: string[], cwd: string, sink: "text" | Hash): Promise<string | void> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    // GIT_OPTIONAL_LOCKS=0: status must not rewrite the index under a concurrently working agent
    proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  } catch (err) {
    throw new FingerprintError(`git ${args[0]} could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  const stderr = new Response(proc.stderr).text();
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of proc.stdout) {
    if (sink === "text") text += decoder.decode(chunk, { stream: true });
    else sink.update(chunk);
  }
  const code = await proc.exited;
  if (code !== 0 || proc.signalCode)
    throw new FingerprintError(
      `git ${args[0]} failed in ${cwd} (${proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`}): ${(await stderr).trim().slice(0, 300)}`,
    );
  if (sink === "text") return text + decoder.decode();
}

/** stream one untracked path into the hash: symlinks by target, files by mode + content */
async function hashFile(path: string, hash: Hash): Promise<void> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (err) {
    // vanished between `git status` and now: that IS a change, record it as one
    if (errorCode(err) === "ENOENT") return void hash.update("gone");
    throw new FingerprintError(`cannot stat untracked ${path}: ${errorCode(err) ?? String(err)}`);
  }
  if (st.isSymbolicLink()) return void hash.update(`link:${readlinkSync(path)}`);
  if (!st.isFile()) return void hash.update(`other:${st.mode}`);
  hash.update(`file:${st.mode & 0o111 ? "x" : "-"}:`);
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (err) {
    throw new FingerprintError(`cannot read untracked ${path}: ${errorCode(err) ?? String(err)}`);
  }
}

const errorCode = (err: unknown) => (typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined);

/**
 * What moved between two fingerprints, for a `stale` outcome or a `stale-base` park — null
 * when they are identical. Names which of HEAD / tracked changes / untracked files changed.
 */
export function describeFingerprintChange(before: Fingerprint | null, after: Fingerprint | null): string | null {
  if (before === null && after === null) return null;
  if (before === null || after === null)
    return before === null ? "the folder became a git work tree" : "the folder is no longer a git work tree";
  const parts: string[] = [];
  if (before.head !== after.head) parts.push(`HEAD moved (${short(before.head)} → ${short(after.head)})`);
  if (before.tracked !== after.tracked) parts.push("tracked changes differ");
  if (before.untracked !== after.untracked) parts.push("untracked files differ");
  return parts.length ? parts.join("; ") : null;
}

const short = (sha: string | null) => (sha === null ? "no commit" : sha.slice(0, 7));

/** Is this value shaped like a Fingerprint (or null)? For values read back from context. */
export function isFingerprint(value: unknown): value is Fingerprint | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.head === null || typeof v.head === "string") && typeof v.tracked === "string" && typeof v.untracked === "string";
}

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
  const reads = nodeReads(def);
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

// ---- the worktree's CONTENT identity (HOW-54) ---------------------------------------

/**
 * HOW-54: the git tree id of what is in the worktree right now — tracked edits and untracked,
 * non-ignored files included — or null when `cwd` is not a git work tree (or git fails).
 *
 * It compares the TREE, not HEAD, on purpose: a repair that only commits work already on disk,
 * makes an empty commit or rewords a message changes no file, and must not count as progress.
 * `fingerprint()` cannot answer that — it keys on HEAD, so a commit moves it.
 *
 * Built with a THROWAWAY index (GIT_INDEX_FILE in a temp dir): `git add -A` + `git write-tree`
 * against it never touches the worktree's own index or takes its `index.lock`. The blobs it
 * writes are ordinary loose objects; they are content-addressed, so a second call re-uses them,
 * and `git gc` collects the ones nothing references.
 */
export function worktreeTree(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const dir = mkdtempSync(join(tmpdir(), "howdah-tree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  const git = (...args: string[]) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
  try {
    if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return null;
    if (git("rev-parse", "--verify", "-q", "HEAD").status === 0) git("read-tree", "HEAD"); // a head start for add
    if (git("add", "-A").status !== 0) return null;
    const tree = git("write-tree");
    return tree.status === 0 && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
