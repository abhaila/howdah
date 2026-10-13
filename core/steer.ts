/**
 * HOW-47: what the operator's mid-turn steer says to the agent, and the limits on it.
 *
 * Node-free: the composer reads MAX_STEER_CHARS, the executor writes `steerTurnText`, and the
 * fake harness echoes it. ONE wording, because the executor recognises a delivery by comparing
 * the harness's echo with exactly the text it wrote.
 *
 * The header says who is speaking. In the spike the message arrived as its own user message
 * right after a tool result, and an agent has every reason to distrust instructions that seem
 * to come out of a tool's output — so it is named as the operator supervising the run, and
 * told to adopt it and carry on rather than restart the step.
 *
 * A steer is OUTSIDE `rendered_hash` (it arrives mid-turn, like the outputs-repair turn), so it
 * is recorded in the log instead: `operator-steered` when it is sent, `steer-delivered` when
 * the harness echoes it. One that never reached the turn is carried into the next render,
 * where it IS hashed (core/template.ts v6 steerInstruction).
 */

/** a steer is a sentence or a paragraph, not a document */
export const MAX_STEER_CHARS = 4000;

export function steerTurnText(text: string): string {
  return (
    `[OPERATOR STEERING — from the human operator supervising this run, not from a tool]\n` +
    `${text.trim()}\n` +
    `Adopt this now and carry on with the current step from where you are; do not restart it.`
  );
}

/** a steer is refused rather than trimmed: an operator's words are never silently cut */
export function steerTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "a steer needs some text";
  if (text.length > MAX_STEER_CHARS) return `a steer is at most ${MAX_STEER_CHARS} characters (this one is ${text.length})`;
  return null;
}

/**
 * HOW-48: the soft stop's wording — what cwc's kill switch told the agent on every refused
 * tool call, said once over the steer channel. The agent is asked to END ITS TURN, so the turn
 * that follows is classified `paused-by-operator`, never a contract violation for obeying.
 */
export const STOP_MESSAGE =
  "The operator asked you to stop at this point. Leave the work in a consistent state, say where you are, and end your turn.";

export function stopTurnText(): string {
  return `[OPERATOR STOP — from the human operator supervising this run, not from a tool]\n${STOP_MESSAGE}`;
}

/**
 * HOW-48: tool calls an agent may still make after reading the stop before it is stopped hard.
 * A soft stop cannot refuse an auto-approved tool, so an agent that ignores it is killed rather
 * than left running against the operator's instruction.
 */
export const STOP_GRACE_TOOL_CALLS = 2;

/**
 * HOW-48: how long a soft stop may go without taking effect before the run header offers to
 * escalate to "Stop now" — the agent may be inside one long tool call. config.json
 * `softStopEscalateMs` overrides it.
 */
export const SOFT_STOP_ESCALATE_MS = 2 * 60_000;

/**
 * HOW-53: what a READ-ONLY step (claude plan mode) is told when it asks to do something plan mode
 * did not already allow — an Edit, a Write outside the plan file, a mutating command, or
 * ExitPlanMode. Spiked against claude 2.1.296 (adapter/fixtures/claude-plan-mode-*.jsonl): plan
 * mode does NOT refuse an Edit itself, it asks the permission-prompt tool — Howdah — so this
 * refusal IS the read-only guarantee. It is never put to the operator, whose "allow" would let a
 * reviewer change the code it is judging.
 */
export const READ_ONLY_REFUSAL =
  "This step is read-only: it judges the work and must not change anything, and it stays in plan mode. " +
  "Do not retry. Record what should change as a finding, and end your turn with your verdict and the outputs object.";
