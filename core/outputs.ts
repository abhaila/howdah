/**
 * Where the `{"outputs": {...}}` object sits in an agent's final message (T16, HOW-29).
 *
 * Two readers need the same answer. The engine parses the object to publish the step's
 * writes (`engine/executors/outputs.ts` parseOutputs), and the viewer has to find the very
 * same span to take it OUT of the prose it draws: HOW-29 was an implementation plan printed as
 * one JSON line with every newline escaped, directly under the agent's own summary of it. If
 * the two used different scanners, the viewer could hide a span the engine did not read — so
 * the scan lives here, once, and is node-free because the browser bundle imports it.
 *
 * The LAST match wins (an agent may quote the contract earlier in its message), and braces are
 * balanced with string awareness, so a `}` inside a value does not end the object early.
 */

export interface OutputsSpan {
  /** index of the opening `{` */
  start: number;
  /** index one past the closing `}`, or null while the object is still unterminated */
  end: number | null;
}

export function locateOutputs(text: string): OutputsSpan | null {
  const last = [...text.matchAll(/\{"outputs"\s*:\s*\{/g)].at(-1);
  if (!last || last.index === undefined) return null;
  const start = last.index;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: null };
}

/**
 * The message split around its outputs object, for display. `outputs` is null when there is
 * no object, when it is still streaming (`pending`), or when it is not valid JSON — in which
 * case the text is left whole, because hiding something we could not read would hide the
 * very thing an operator needs to see to know why the step failed its contract.
 */
export interface SplitOutputs {
  before: string;
  outputs: Record<string, unknown> | null;
  after: string;
  /** an `{"outputs"` has started but not closed yet — the agent is still writing it */
  pending: boolean;
}

export function splitOutputs(text: string): SplitOutputs {
  const span = locateOutputs(text);
  if (!span) return { before: text, outputs: null, after: "", pending: false };
  if (span.end === null) return { before: stripFence(text.slice(0, span.start)), outputs: null, after: "", pending: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(span.start, span.end));
  } catch {
    return { before: text, outputs: null, after: "", pending: false };
  }
  const outputs = (parsed as { outputs?: unknown }).outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs))
    return { before: text, outputs: null, after: "", pending: false };
  const after = text.slice(span.end).replace(/^\s*```[ \t]*(?:\n|$)/, "");
  return { before: stripFence(text.slice(0, span.start)), outputs: outputs as Record<string, unknown>, after, pending: false };
}

/** an agent that fenced its contract (```json …) leaves the opening fence behind */
function stripFence(s: string): string {
  return s.replace(/\n?[ \t]*```[a-z]*[ \t]*\n?\s*$/i, "\n");
}
