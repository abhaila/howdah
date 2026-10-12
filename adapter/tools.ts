/**
 * Per-harness tool facts (HOW-38, HOW-35) — what a harness's `tool_call` ARGUMENTS are, so
 * the engine can ask "is this the same call again?" without knowing any harness's shape.
 *
 * A tool_call's `input` is not the same kind of thing on every harness:
 *   claude   the tool_use block's `input` — exactly the arguments
 *   codex    the whole `item` (commandExecution / fileChange), which ALSO carries the item id,
 *            its status and, once it ran, its output — so two identical commands would never
 *            hash alike if the item were hashed whole
 *   cursor   the `tool_call` wrapper ({ shellToolCall: { args, result? } }), documented, not
 *            captured (see adapter/cursor.ts)
 *
 * Streak logic (engine/executors/stuck.ts) and the trajectory profile (log/trajectory.ts) are
 * harness-agnostic: they only ever see what `toolArguments` returns.
 *
 * Node-free: `argumentsHash` is a small FNV-1a over the canonical JSON, because the browser
 * bundle imports adapter/ through web/derive.ts and the hash only has to tell two argument
 * sets apart within one visit — it is identity, not security.
 */

/** the call's arguments, with every field that describes the RUN rather than the REQUEST removed */
export function toolArguments(harness: string, name: string, input: unknown): unknown {
  if (harness === "codex" && input && typeof input === "object") {
    const item = input as Record<string, unknown>;
    if (name === "commandExecution") return { command: item.command, cwd: item.cwd };
    if (name === "fileChange") return { changes: item.changes };
    return input;
  }
  if (harness === "cursor" && input && typeof input === "object") {
    const call = input as Record<string, unknown>;
    const key = Object.keys(call)[0];
    const inner = key !== undefined ? (call[key] as Record<string, unknown> | undefined) : undefined;
    if (inner && typeof inner === "object" && "args" in inner) return { [key!]: inner.args };
    return input;
  }
  return input;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are the same arguments */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v)) ?? "undefined";
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/**
 * HOW-38: a short identity for a call's FULL arguments, taken before the log clips them to
 * 400 characters — two calls that differ only after character 400 must not look identical.
 */
export function argumentsHash(harness: string, name: string, input: unknown): string {
  const text = `${name}\u0000${canonicalJson(toolArguments(harness, name, input))}`;
  // FNV-1a, 64-bit, as two 32-bit halves (no BigInt needed, stable across runtimes)
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
