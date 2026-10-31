/**
 * `git:restack` — HOW-57's deterministic restack (decision A, which superseded an agent step:
 * an agent cannot append the event that moves the recorded tip, so the bookkeeping has to live
 * in an executor).
 *
 * A stacked run's branch was cut from its base's tip. When the base changes underneath it:
 *
 *   base MERGED                         → replay onto origin/<default>  (decision B: always)
 *   base MOVED and this PR NOT approved → replay onto the base's new tip
 *   base MOVED and this PR approved     → do nothing: never re-push an approved PR because its
 *                                         base moved (CI churn, dismissed approvals); it is
 *                                         replayed when the base merges instead
 *
 * "Replay" is `git rebase --onto <target> <recorded tip>` — the recorded tip is the latest
 * `base-restacked`'s `to`, else the worktree's recorded base (engine/executors/await.ts
 * recordedBaseTip) — so after a SQUASH merge only this run's own commits survive, which a plain
 * rebase onto main would not manage. Then `git push --force-with-lease` of THIS run's branch
 * only — the PR's head branch, which need not be the worktree's `howdah/<run>` — (leased against
 * the remote head the rebase started from), a retarget of this run's PR
 * when GitHub did not already move it, and a `base-restacked` event.
 *
 * Exactly-once, by observed state as much as by record:
 *   - the push is the side effect, wrapped in `effects.claim/done` keyed by the target sha and
 *     the remote head it leases against — a re-visit after success finds the recorded tip
 *     already equal to the target and does nothing; a lease refused by a racing push is
 *     recorded as not pushed, and the next probe tries again under a new key;
 *   - a branch that ALREADY contains the target (an agent resolved a conflict by hand with the
 *     command it was given) is recorded without rebasing again;
 *   - origin's copy of this branch holding commits the worktree lacks refuses BEFORE anything is
 *     rewritten — force-pushing over a teammate's commit is never the answer.
 * A conflict aborts the rebase cleanly and publishes `restack.conflict`: the EXACT `--onto`
 * command, for the repair agent (never "rebase onto the target", which is wrong after a squash).
 */
import { dirname } from "node:path";
import type { AttemptResult, Executor, ExecArgs } from "../run";
import type { LoggedEvent } from "../../log/events";
import { declaredWrites } from "./map";
import { readWorktreeRecord } from "./worktree-record";
import { remoteDefaultBranch, revParse, sh } from "./git";
import { ghPrView, publishedPrs, recordedBaseTip, type PrView } from "./await";
import { RESTACK_BUILTIN, RESTACK_PRODUCES, RESTACK_READS } from "../../core/stack";

export { RESTACK_BUILTIN } from "../../core/stack";

export function isRestackBuiltin(run: string): boolean {
  return run.trim().split(/\s+/)[0] === RESTACK_BUILTIN;
}

/** `gh pr edit <ref> --base <branch>`; returns the error text, or null on success */
export type PrRetarget = (cwd: string, ref: string, base: string) => string | null;

export const ghPrRetarget: PrRetarget = (cwd, ref, base) => {
  const r = sh(["gh", "pr", "edit", ref, "--base", base], cwd);
  return r.code === 0 ? null : (r.stderr.trim() || `gh exited ${r.code}`).slice(0, 200);
};

export interface RestackBuiltinOpts {
  prView?: PrView;
  retarget?: PrRetarget;
  /** config.json `defaultBranch` for a repo path — what a merged base is replaced by */
  defaultBranchFor?: (repoPath: string) => string | undefined;
}

type Failed = AttemptResult & { status: "failed" };
const failed = (reason: string): Failed => ({ status: "failed", writes: {}, reason });

const isAncestor = (cwd: string, ancestor: string, of: string): boolean => sh(["git", "merge-base", "--is-ancestor", ancestor, of], cwd).code === 0;

export function restackBuiltinExecutor(opts: RestackBuiltinOpts = {}): Executor {
  return async (args) => {
    const { def, nodeId, visit, log, reads, effects } = args;
    if (def.kind !== "command") throw new Error("git:restack on a non-command node");
    const refused = precheck(def);
    if (refused) return refused;

    let index = 0;
    const note = (content: string) => log.append({ type: "chunk", node: nodeId, visit, turn: 1, index: index++, kind: "text", content: `${content}\n` });
    const runDir = dirname(log.path);
    const record = readWorktreeRecord(runDir);
    if (!record) return failed(`${RESTACK_BUILTIN} needs this run's worktree, and there is none`);
    const wt = record.path;
    const base = typeof reads["deps.base"] === "string" ? (reads["deps.base"] as string) : "";
    const merged = reads["deps.base_merged"] === true;
    const approved = reads["pr.approved"] === true;
    const result = (conflict: string, stackedOn: string, tip: string): AttemptResult => ({
      status: "succeeded",
      writes: declaredWrites(RESTACK_BUILTIN, def, { "restack.conflict": conflict, "deps.base": stackedOn, "deps.base_tip": tip }),
    });

    const fromSha = recordedBaseTip(log.read(), runDir);
    if (!base) {
      note("not stacked on anything (the base already merged and was replayed away) — nothing to restack");
      return result("", "", "");
    }
    if (!merged && approved) {
      // decision B: an approved PR is not re-pushed because its base moved — it is replayed
      // when the base merges, which is the restack that changes what lands
      note(`the stack base ${base} moved, but this PR is approved — not re-pushed (it is restacked when the base merges)`);
      return result("", base, fromSha ?? "");
    }
    if (!fromSha) return failed(`${RESTACK_BUILTIN}: this run has no recorded base tip to replay from (no base-restacked, and the worktree recorded no base)`);

    const fetch = sh(["git", "fetch", "--quiet", "--prune", "origin"], wt, 60_000);
    if (fetch.code !== 0) throw new Error(`git fetch origin failed, so the base cannot be read: ${fetch.stderr.trim().slice(0, 200)}`);

    // where the branch goes: the default branch once the base merged, else the base's new tip
    let targetBranch = base;
    if (merged) {
      const fallback = remoteDefaultBranch(wt, opts.defaultBranchFor?.(record.repo));
      if (!fallback) throw new Error(`the stack base ${base} merged, but origin has no default branch this clone can see to replay onto`);
      targetBranch = fallback.branch;
    }
    const toSha = revParse(wt, `refs/remotes/origin/${targetBranch}`);
    if (!toSha) throw new Error(`origin/${targetBranch} not found after a fetch — cannot restack onto it`);
    const stackedOn = merged ? "" : base;
    if (toSha === fromSha) {
      note(`already stacked on ${targetBranch} @ ${toSha.slice(0, 12)} — nothing to do`);
      return result("", stackedOn, merged ? "" : toSha);
    }

    // the PR's head, not the worktree's: a publish step may name the branch after the ticket, and
    // then `howdah/<run>` on origin is a stale copy — guarding or pushing it parks every
    // hand-resolved conflict and never moves the PR
    const own = publishedPrs(reads.publication_summary).primary;
    const ownPr = own ? (opts.prView ?? ghPrView)(record.repo, own) : null;
    const branch = ownPr?.headRefName ?? record.branch;
    const status = sh(["git", "status", "--porcelain"], wt);
    if (status.stdout.trim()) throw new Error(`the worktree has uncommitted changes, so it cannot be replayed onto ${targetBranch} — commit or discard them, then resume`);
    const head = revParse(wt, "HEAD");
    if (!head) throw new Error("the worktree has no HEAD");
    const remoteHead = revParse(wt, `refs/remotes/origin/${branch}`);
    if (remoteHead && !isAncestor(wt, remoteHead, head))
      throw new Error(
        `origin/${branch} has commits this worktree lacks (${remoteHead.slice(0, 12)}) — someone else pushed to it. ` +
          `Bring them into the worktree, then resume; a restack never force-pushes over them`,
      );

    // a conflict an agent resolved by hand put HEAD on that restack's target, but only a
    // base-restacked moves the recorded tip — replaying from the stale tip would replay the base's
    // own commits again, and after a squash merge they conflict with themselves
    const resolvedOnto = handResolvedTarget(log.read(), wt, head);
    const from = resolvedOnto ?? fromSha;
    if (resolvedOnto && resolvedOnto !== fromSha) note(`a conflict was resolved onto ${resolvedOnto.slice(0, 12)} by hand — replaying from there, not ${fromSha.slice(0, 12)}`);

    // the rebase — unless the branch already holds the target (a conflict resolved by hand)
    const command = `git rebase --onto ${toSha} ${from}`;
    if (isAncestor(wt, toSha, head)) note(`${branch} already contains ${targetBranch} @ ${toSha.slice(0, 12)} — recording it, not rebasing again`);
    else {
      note(`$ ${command}    # replay ${from.slice(0, 12)}..HEAD onto ${merged ? `origin/${targetBranch} (the base merged)` : `${targetBranch}'s new tip`}`);
      const r = sh(["git", "rebase", "--onto", toSha, from], wt);
      if (r.code !== 0) {
        const files = sh(["git", "diff", "--name-only", "--diff-filter=U"], wt).stdout.trim().split("\n").filter(Boolean);
        sh(["git", "rebase", "--abort"], wt);
        note(`the replay conflicts${files.length ? ` in ${files.join(", ")}` : ""} — aborted; the worktree is back at ${head.slice(0, 12)}`);
        return result(command, base, from);
      }
    }
    const newHead = revParse(wt, "HEAD")!;

    const effect = `restack:${toSha}:${remoteHead ?? "unpushed"}`;
    if (effects.claim(effect)) {
      note(`this restack was already pushed (${effect})`);
      return result("", stackedOn, merged ? "" : toSha);
    }
    const lease = `--force-with-lease=${branch}:${remoteHead ?? ""}`;
    const push = sh(["git", "push", "--quiet", lease, "origin", `HEAD:refs/heads/${branch}`], wt, 120_000);
    if (push.code !== 0) {
      // a push raced this one: put the worktree back, say so, and let the next probe retry
      sh(["git", "reset", "--quiet", "--hard", head], wt);
      const why = push.stderr.trim().slice(0, 200) || `git push exited ${push.code}`;
      effects.done(effect, { pushed: false, reason: why });
      note(`push refused (${why}) — the worktree is back at ${head.slice(0, 12)}; the restack is retried at the next probe`);
      return result("", base, from);
    }

    // retarget this run's PR when GitHub did not (it does when a merged base branch is deleted)
    let retargeted: string | undefined;
    try {
      const pr = ownPr ?? (opts.prView ?? ghPrView)(record.repo, branch);
      if (pr && pr.baseRefName !== targetBranch) {
        const error = (opts.retarget ?? ghPrRetarget)(record.repo, pr.url, targetBranch);
        if (error) note(`could not retarget ${pr.url} onto ${targetBranch}: ${error}`);
        else retargeted = pr.url;
      }
    } catch (err) {
      note(`could not read this run's PR to retarget it: ${err instanceof Error ? err.message : String(err)}`);
    }

    // proof first, then the bookkeeping: a death between the two re-attempts, finds the branch
    // already containing the target, and records it under a new lease (the remote moved)
    effects.done(effect, { pushed: true, from, to: toSha, head: newHead });
    log.append({
      type: "base-restacked", node: nodeId, visit,
      from: { branch: base, sha: from }, to: { branch: targetBranch, sha: toSha }, head: newHead,
      ...(retargeted ? { pr: retargeted } : {}),
    });
    note(`restacked ${branch} onto ${targetBranch} @ ${toSha.slice(0, 12)} and pushed ${newHead.slice(0, 12)}`);
    return result("", stackedOn, merged ? "" : toSha);
  };
}

/**
 * The target of the latest conflicted restack, when HEAD already contains it: an agent ran the
 * handed-over `--onto` command by hand. Null once a later base-restacked recorded the tip.
 */
function handResolvedTarget(events: readonly LoggedEvent[], wt: string, head: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "base-restacked") return null;
    if (e.type !== "node-finished" || e.status !== "succeeded") continue;
    const conflict = e.writes["restack.conflict"];
    if (typeof conflict !== "string" || !conflict) continue;
    const onto = /--onto (\S+)/.exec(conflict)?.[1];
    return onto !== undefined && isAncestor(wt, onto, head) ? onto : null;
  }
  return null;
}

/** The node's declaration, checked before git is touched. */
function precheck(def: Extract<ExecArgs["def"], { kind: "command" }>): Failed | null {
  const declared = (def.reads ?? []) as readonly string[];
  for (const key of RESTACK_READS)
    if (!declared.includes(key))
      return failed(`${RESTACK_BUILTIN} reads "${key}", which this node does not declare (it declares: ${declared.join(", ") || "nothing"})`);
  const producible = RESTACK_PRODUCES as readonly string[];
  const wrong = Object.keys(def.writes ?? {}).filter((k) => !producible.includes(k));
  if (wrong.length) return failed(`${RESTACK_BUILTIN} publishes only ${producible.join(", ")} — it cannot produce ${wrong.join(", ")}`);
  return null;
}
