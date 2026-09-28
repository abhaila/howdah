/**
 * The outputs contract between an agent turn and the typed context (T16).
 *
 * Prompts stay prose; a contract is appended so the agent's LAST line is a
 * machine-readable JSON object carrying exactly the node's declared writes. Orbital does
 * the same job with `outputs="name:type"` DOT attributes; here the graph declaration is
 * the source and the instruction is generated from it.
 *
 * system-map 0.1: the contract's WORDING now lives in core/template.ts (versioned, applied
 * by the engine before hashing, so rendered_hash covers it). This file keeps the parsing
 * side; the builder is re-exported for existing callers.
 */
export { buildOutputInstruction } from "../../core/template";
import { locateOutputs } from "../../core/outputs";

/**
 * Asked as a follow-up turn when the final message arrived without the contract. Observed
 * on long tool-heavy turns (codex, delivery.review_repairs: 3 of 6 attempts ended in prose
 * after 40+ tool calls). The thread still holds all the work, so this costs one short turn
 * instead of re-running the node.
 */
export function buildRepairInstruction(keys: string[]): string {
  return (
    `Your previous message did not end with the required outputs object, so this step cannot complete.\n` +
    `Do not redo any work and do not use any tools — the analysis you just finished is what I need recorded.\n` +
    `Reply with ONLY this JSON object and nothing else:\n` +
    `{"outputs": {${keys.map((k) => `"${k}": <value>`).join(", ")}}}\n` +
    `containing exactly these keys: ${keys.join(", ")}.`
  );
}

export interface ParsedOutputs {
  ok: boolean;
  writes: Record<string, unknown>;
  problem?: string;
}

/**
 * Find the LAST {"outputs": ...} object in the text; tolerate fences and surrounding prose.
 * The scan itself is `core/outputs.ts` locateOutputs, shared with the viewer (HOW-29).
 */
export function parseOutputs(text: string, expectedKeys: string[]): ParsedOutputs {
  if (expectedKeys.length === 0) return { ok: true, writes: {} };
  const span = locateOutputs(text);
  if (!span)
    return { ok: false, writes: {}, problem: `no {"outputs": ...} object found in the final message` };
  const { start, end } = span;
  if (end === null) return { ok: false, writes: {}, problem: "unterminated outputs object" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end));
  } catch {
    return { ok: false, writes: {}, problem: "outputs object is not valid JSON" };
  }
  const outputs = (parsed as { outputs?: Record<string, unknown> }).outputs;
  if (!outputs || typeof outputs !== "object") return { ok: false, writes: {}, problem: "outputs key missing" };

  const missing = expectedKeys.filter((k) => !(k in outputs));
  if (missing.length) return { ok: false, writes: {}, problem: `outputs missing keys: ${missing.join(", ")}` };
  const writes: Record<string, unknown> = {};
  for (const k of expectedKeys) writes[k] = outputs[k];
  return { ok: true, writes };
}
