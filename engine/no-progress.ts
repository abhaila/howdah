/**
 * HOW-54: "did this visit make progress?", folded from the log — node-free so HOW-43 (the
 * auto-continue after a context-exhausted visit) can ask the same question the same way.
 *
 * A visit's progress is its worktree's CONTENT identity (`node-finished.tree`, a git tree id
 * from engine/reconcile.ts worktreeTree) compared with the same node's previous recorded one.
 */
import type { LoggedEvent } from "../log/events";

/** the latest earlier visit of `node` that recorded a tree, or null */
export function previousTree(events: readonly LoggedEvent[], node: string, visit: number): { visit: number; tree: string } | null {
  const e = events.findLast((x) => x.type === "node-finished" && x.node === node && x.visit < visit && x.tree !== undefined);
  return e && e.type === "node-finished" && e.tree !== undefined ? { visit: e.visit, tree: e.tree } : null;
}

/** did `node@visit` finish with exactly the worktree its previous visit left? */
export function madeNoProgress(events: readonly LoggedEvent[], node: string, visit: number): boolean {
  const mine = events.findLast((x) => x.type === "node-finished" && x.node === node && x.visit === visit);
  if (!mine || mine.type !== "node-finished" || mine.tree === undefined) return false;
  return previousTree(events, node, visit)?.tree === mine.tree;
}
