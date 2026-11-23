/**
 * HOW-54: "did this visit make progress?", folded from the log — node-free so HOW-43 (the
 * auto-continue after a context-exhausted visit) can ask the same question the same way.
 *
 * A visit's progress is its worktree's CONTENT identity (`node-finished.tree`, a git tree id
 * from engine/reconcile.ts worktreeTree) and its COMMITTED content (`node-finished.head_tree`)
 * compared with the same node's previous recorded ones. Either moving is progress: committing
 * work already on disk moves only `head_tree`. A log written before `head_tree` existed
 * compares `undefined` with `undefined`, so it decides as it did then.
 */
import type { LoggedEvent } from "../log/events";

export interface VisitTrees {
  visit: number;
  tree: string;
  head_tree?: string;
}

/** the latest earlier visit of `node` that recorded a tree, or null */
export function previousTree(events: readonly LoggedEvent[], node: string, visit: number): VisitTrees | null {
  const e = events.findLast((x) => x.type === "node-finished" && x.node === node && x.visit < visit && x.tree !== undefined);
  return e && e.type === "node-finished" && e.tree !== undefined
    ? { visit: e.visit, tree: e.tree, ...(e.head_tree !== undefined ? { head_tree: e.head_tree } : {}) }
    : null;
}

/** the same worktree content AND the same committed content as `previous` */
export function sameTrees(previous: VisitTrees | null, tree: string, headTree: string | undefined): boolean {
  return previous !== null && previous.tree === tree && previous.head_tree === headTree;
}

/** did `node@visit` finish with exactly the worktree (and commits) its previous visit left? */
export function madeNoProgress(events: readonly LoggedEvent[], node: string, visit: number): boolean {
  const mine = events.findLast((x) => x.type === "node-finished" && x.node === node && x.visit === visit);
  if (!mine || mine.type !== "node-finished" || mine.tree === undefined) return false;
  return sameTrees(previousTree(events, node, visit), mine.tree, mine.head_tree);
}
