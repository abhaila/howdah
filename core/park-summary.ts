/**
 * What a parked run is waiting for, in the operator's words (HOW-68).
 *
 * A park carries the engine's `reason`: exact, complete, and written for the log. The
 * acceptance park's is five sentences with a CLI command in the middle, and the viewer printed
 * it twice — in a banner and in the card — over the transcript it was about. DESIGN.md
 * ("Asking the operator something") says the card is written for a person: one sentence that
 * says what kind of thing this is and what would move it, with the engine's message one click
 * away and UNCHANGED. This file is that one sentence.
 *
 * It is derived from the park's `code` (or, for a mid-turn ask, its payload's `kind`), never
 * from parsing `reason` — the reason is prose, and prose is not an interface. So a code this
 * file does not know reads as a plain "needs you" and the full message carries the meaning,
 * exactly as before. Node-free and dependency-free: the browser draws the card, the runs list
 * and the notification from it, and the server names a notification with it.
 */
import type { ParkCode } from "../log/events";

export interface ParkSummary {
  /** a few words for a list row and a notification title: "Question", "Log in" */
  label: string;
  /** one sentence for the card's heading */
  title: string;
  /** what the operator can do about it, or null when the card's own controls say so */
  hint: string | null;
}

export interface ParkLike {
  code?: ParkCode | string | null;
  node?: string | null;
  /** the mid-turn ask payload, when there is one (core/ask.ts) */
  ask?: unknown;
}

const BY_CODE: Record<ParkCode, (node: string) => ParkSummary> = {
  "attempt-failed": (n) => ({ label: "Step failed", title: `${n} failed.`, hint: "Reply with what to do differently and it will try again, or jump to another step." }),
  "harness-unauthenticated": () => ({ label: "Log in", title: "The agent's CLI is signed out on this machine.", hint: "Log in from a terminal, then retry the step." }),
  "context-exhausted": (n) => ({ label: "Out of context", title: `${n} filled its context window and could not continue.`, hint: "Reply to continue from where it stopped, or narrow the task." }),
  "stuck": (n) => ({ label: "Stuck", title: `${n} kept repeating a call that fails.`, hint: "Reply with a way around it, or fix the cause and retry." }),
  "turn-timeout": (n) => ({ label: "Timed out", title: `${n} ran past its time limit and was stopped.`, hint: "Reply to try again, or raise the limit for this step." }),
  "tools-unsupported": (n) => ({ label: "Cannot restrict tools", title: `${n} restricts its tools and this harness cannot enforce that.`, hint: "Run the step on a harness that can, or lift the restriction." }),
  "executor-threw": (n) => ({ label: "Step errored", title: `${n} could not run.`, hint: "Fix the cause below, then retry the step." }),
  "max-visits": (n) => ({ label: "Loop limit", title: `${n} reached its visit limit.`, hint: "Jump onward, or reset the budget if another round is worth it." }),
  "no-edge": (n) => ({ label: "Nowhere to go", title: `No route out of ${n} matched its result.`, hint: "Jump to the step that should run next." }),
  "max-steps": () => ({ label: "Step limit", title: "The run reached its overall step limit.", hint: "Resume to allow more steps, or abort." }),
  "ambiguous-effect": () => ({ label: "Did this happen?", title: "A side effect may or may not have happened.", hint: null }),
  "awaiting-approval": () => ({ label: "Approve?", title: "A proposal is waiting for your decision.", hint: null }),
  "approval-missing": (n) => ({ label: "Needs approval", title: `${n} cannot start until its proposal is approved.`, hint: "Decide the proposal, then resume." }),
  "stale-base": () => ({ label: "Code changed", title: "The code changed after the proposal was approved.", hint: "Redesign against the current code, or approve again." }),
  "paused-by-operator": (n) => ({ label: "Paused", title: `You stopped ${n}.`, hint: "Reply or resume to continue from where it stopped." }),
  "acceptance-unmet": () => ({ label: "Publish?", title: "Some acceptance criteria are not proven.", hint: "Retry the step to publish with them disclosed, or go back and prove them." }),
  "no-progress": (n) => ({ label: "No progress", title: `${n} changed nothing since its last visit.`, hint: "Reply with what to change, steer it, or jump onward." }),
  "repair-stalled": () => ({ label: "Repair stalled", title: "The pull request still needs the same repair and nothing new has arrived.", hint: "Act on the pull request, then retry the probe." }),
};

const isCode = (c: unknown): c is ParkCode => typeof c === "string" && Object.prototype.hasOwnProperty.call(BY_CODE, c);

function askKind(ask: unknown): string | null {
  if (!ask || typeof ask !== "object") return null;
  const k = (ask as { kind?: unknown }).kind;
  return typeof k === "string" ? k : null;
}

function firstQuestion(ask: unknown): string | null {
  const qs = (ask as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return null;
  const q = (qs[0] as { question?: unknown } | undefined)?.question;
  return typeof q === "string" && q.trim() !== "" ? q.trim() : null;
}

/** The one sentence. Never throws: an unknown park degrades to a plain "needs you". */
export function parkSummary(park: ParkLike): ParkSummary {
  const node = park.node && park.node.trim() !== "" ? park.node : "The step";
  if (isCode(park.code)) return BY_CODE[park.code](node);
  const kind = askKind(park.ask);
  if (kind === "user-question") {
    const q = firstQuestion(park.ask);
    return { label: "Question", title: q ?? "The agent has a question.", hint: null };
  }
  if (kind === "mcp-elicitation") return { label: "Connect", title: "A tool the agent uses needs you to connect it.", hint: "Open the link, finish there, then reply." };
  if (kind !== null) return { label: "Permission", title: "The agent is asking permission to do something.", hint: null };
  return { label: "Needs you", title: `${node} is waiting on you.`, hint: null };
}
