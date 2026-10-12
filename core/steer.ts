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
