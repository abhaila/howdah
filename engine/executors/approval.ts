/**
 * Approval executor (system-map 1a, D4/3A, D18) — a human decision on the current proposal
 * round, run on EVERY attempt of an approval node, including each resume:
 *
 *   1. stale probe   (a) the base in context must be the base the round was drawn against
 *                    (manifest_hash recorded on ghost-proposed) — a re-extract since the
 *                    proposal is stale, not "approved" (that would loop on the gate's refusal);
 *                    (b) live worktree fingerprint vs base.fingerprint. Either → write
 *                    outcome "stale" and succeed; the graph routes it back to re-extract. The
 *                    reason says whether the tree moved while the proposer ran ("worktree
 *                    changed during <proposer>") or after it proposed. A stale round that had
 *                    already been sent back with feedback carries those comments forward, so
 *                    the redraw still answers them.
 *   2. decision      engine/slice-decision.ts findDecision(currentProposal.proposal_id).
 *   3. decided       write outcome "approved" (feedback []) or "feedback" (the round's sent
 *                    comments) and succeed.
 *   4. undecided     return `awaiting`: the engine parks `awaiting-approval` WITHOUT logging
 *                    node-finished, so a restart re-attempts this same visit and asks again.
 *
 * Nothing here waits in-process: the run parks and the runner exits; a decision route (or
 * `howdah up`, D17) resumes it. The proposal in context must be the one the round hashed —
 * a mismatch means the log and context disagree, which is an engine bug, so it throws.
 * A fingerprint that cannot be computed (git failed) or a folder that is not a git work tree
 * also throws: the run parks rather than guessing that nothing moved.
 */
import type { Executor } from "../run";
import { proposalHash } from "../../core/proposal";
import { describeFingerprintChange, fingerprint } from "../reconcile";
import { effectiveCwd } from "./worktree-record";
import {
  currentProposal,
  decisionKind,
  feedbackItems,
  findDecision,
  readBase,
  type ApprovalDecision,
  type FeedbackItem,
} from "../slice-decision";

export const approvalExecutor: Executor = async ({ nodeId, def, reads, cwd, log }) => {
  if (def.kind !== "approval") throw new Error("approvalExecutor on non-approval node");
  const events = log.read();
  const round = currentProposal(events, nodeId);
  if (!round) throw new Error(`no proposal round for "${nodeId}": "${def.proposal}" was written without a ghost-proposed event`);
  const hash = proposalHash(reads[def.proposal]);
  if (hash !== round.proposal_hash)
    throw new Error(`"${def.proposal}" in context hashes to ${hash}, but the current round #${round.proposal_id} is ${round.proposal_hash}`);
  const base = readBase(reads[def.base], def.base);
  const decision = findDecision(events, round.proposal_id);

  const decided = (outcome: ApprovalDecision["outcome"], feedback: FeedbackItem[], reason?: string) => ({
    status: "succeeded" as const,
    writes: {
      [def.decision]: {
        outcome,
        proposal_id: round.proposal_id,
        proposal_hash: round.proposal_hash,
        manifest_hash: round.manifest_hash,
        ...(reason ? { reason } : {}),
      } satisfies ApprovalDecision,
      [def.feedback]: feedback,
    },
  });

  const stale = (reason: string) => {
    const carried = decision?.type === "slice-feedback-sent" ? feedbackItems(events, decision) : [];
    return { ...decided("stale", carried, reason), reason };
  };

  // 1a. the base was re-extracted after the proposal was drawn
  if (base.manifest_hash !== round.manifest_hash)
    return stale(`the base was re-extracted since ${round.node} proposed (manifest ${round.manifest_hash} → ${base.manifest_hash})`);

  // 1b. the worktree moved under the design (D18 — changed, not merely dirty)
  const workDir = effectiveCwd(log.path, cwd);
  const live = await fingerprint(workDir);
  if (live === null) throw new Error(`approval needs a git work tree to bind the design to, and ${workDir ?? "(no folder)"} is not one`);
  const moved = describeFingerprintChange(base.fingerprint, live);
  if (moved) {
    const duringProposer = describeFingerprintChange(base.fingerprint, round.fingerprint) !== null;
    return stale(duringProposer ? `worktree changed during ${round.node}: ${moved}` : `worktree changed since ${round.node} proposed: ${moved}`);
  }

  // 2–3. the round's first decision, if any
  if (decision) return decided(decisionKind(decision), feedbackItems(events, decision));

  // 4. nobody has decided: park without finishing
  return {
    status: "awaiting",
    writes: {},
    reason: `awaiting a decision on proposal #${round.proposal_id} from ${round.node}`,
  };
};
