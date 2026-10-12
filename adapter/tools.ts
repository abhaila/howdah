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

// ---- HOW-35: what kind of work a call was --------------------------------------------------
//
// The trajectory profile (log/trajectory.ts) needs every call put in one of four buckets, from
// what the LOG kept: the tool name and the call's input JSON clipped to 400 characters. So the
// classifier is honest about the clip: a decision that text past the cut could overturn is
// `unclassified`, never a guess. Tables are per harness because the names are.

export type ToolClass = "inspect" | "edit" | "verify" | "other" | "unclassified";

export interface CallClassification {
  cls: ToolClass;
  /** the file a read or an edit names, when the logged input shows it */
  path?: string;
  /** the shell command, for a shell call (possibly clipped) */
  command?: string;
}

interface HarnessToolTable {
  inspect: readonly string[];
  edit: readonly string[];
  /** tools whose input carries a shell command, and the field it is in */
  shell: Readonly<Record<string, string>>;
}

/**
 * The per-harness names. claude's are its built-in tools; codex's are app-server item types
 * (adapter/codex.ts maps item.type to the tool name); cursor's are the DOCUMENTED wrapper keys
 * of a `tool_call` record (adapter/cursor.ts toolName) — unverified live, like the rest of it.
 */
export const TOOL_TABLES: Readonly<Record<string, HarnessToolTable>> = {
  claude: {
    inspect: ["Read", "Grep", "Glob", "LS", "NotebookRead"],
    edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
    shell: { Bash: "command" },
  },
  codex: {
    inspect: [],
    edit: ["fileChange"],
    shell: { commandExecution: "command" },
  },
  cursor: {
    inspect: ["readToolCall", "grepToolCall", "globToolCall", "lsToolCall"],
    edit: ["editToolCall", "writeToolCall", "deleteToolCall"],
    shell: { shellToolCall: "command" },
  },
};
// opencode runs through the claude executor and binary
const tableFor = (harness: string): HarnessToolTable => TOOL_TABLES[harness === "opencode" ? "claude" : harness] ?? TOOL_TABLES.claude!;

/** the CLIP the log applies to a tool_call's input JSON (engine/executors/*.ts) */
export const LOGGED_INPUT_CHARS = 400;

/**
 * A JSON string field out of possibly-clipped JSON: `{ value, truncated }`, where `truncated`
 * means the string ran past the cut (the value is a prefix). Undefined when the field is absent.
 */
function stringField(clipped: string, field: string): { value: string; truncated: boolean } | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(clipped);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  let out = "";
  while (i < clipped.length) {
    const c = clipped[i]!;
    if (c === "\\") {
      const next = clipped[i + 1];
      if (next === undefined) return { value: out, truncated: true };
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 2;
      continue;
    }
    if (c === '"') return { value: out, truncated: false };
    out += c;
    i++;
  }
  return { value: out, truncated: true };
}

/** a field from the logged input: parsed when the JSON is whole, scanned when it was clipped */
function field(content: string, name: string): { value: string; truncated: boolean } | undefined {
  try {
    const found = findKey(JSON.parse(content), name);
    if (typeof found === "string") return { value: found, truncated: false };
    if (Array.isArray(found) && found.every((x) => typeof x === "string")) {
      // argv form: `["bash", "-lc", "<cmd>"]` runs <cmd>
      const argv = found as string[];
      if (argv.length === 3 && /^(\/bin\/)?(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return { value: argv[2]!, truncated: false };
      return { value: argv.join(" "), truncated: false };
    }
    return undefined;
  } catch {
    return stringField(content, name);
  }
}

/** the first value under `name`, searching nested objects (cursor wraps its args) */
function findKey(v: unknown, name: string, depth = 0): unknown {
  if (!v || typeof v !== "object" || depth > 4) return undefined;
  if (!Array.isArray(v) && name in (v as object)) return (v as Record<string, unknown>)[name];
  for (const child of Object.values(v as object)) {
    const found = findKey(child, name, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const PATH_FIELDS = ["file_path", "notebook_path", "path"];

/**
 * Classify one logged call. `content` is the tool_call chunk's content (input JSON, clipped);
 * `verifyCommand` is the workspace's, when known, so running exactly it counts as verify.
 */
export function classifyCall(harness: string, name: string, content: string, opts: { verifyCommand?: string } = {}): CallClassification {
  const table = tableFor(harness);
  const path = PATH_FIELDS.map((f) => field(content, f)).find((x) => x !== undefined && !x.truncated)?.value;
  if (table.inspect.includes(name)) return { cls: "inspect", ...(path ? { path } : {}) };
  if (table.edit.includes(name)) return { cls: "edit", ...(path ? { path } : {}) };
  const shellField = table.shell[name];
  if (shellField !== undefined) {
    const cmd = field(content, shellField);
    if (!cmd) return { cls: "unclassified" };
    const shell = classifyShell(cmd.value, { truncated: cmd.truncated, ...(opts.verifyCommand ? { verifyCommand: opts.verifyCommand } : {}) });
    return { ...shell, command: cmd.value };
  }
  return { cls: "other" };
}

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n)\s*/;
const VERIFY_RUNNERS: readonly RegExp[] = [
  /^(bun|npm|pnpm|yarn)\s+(run\s+)?test\b/, /^bun\s+run\s+check\b/, /^(bunx|npx|pnpm\s+exec)\s+(tsc|vitest|jest)\b/,
  /^tsc\b.*--noEmit/, /^(vitest|jest|pytest)\b/, /^python3?\s+-m\s+pytest\b/, /^go\s+test\b/, /^cargo\s+(test|check)\b/,
  /^(\.\/)?gradlew\s+.*\b(test|check)\b/, /^gradle\s+.*\b(test|check)\b/, /^mvn\s+.*\btest\b/, /^make\s+(test|check)\b/,
];
const INSPECT_HEADS = new Set([
  "cat", "head", "tail", "less", "more", "rg", "grep", "egrep", "ls", "find", "fd", "tree", "wc", "file", "stat",
  "pwd", "nl", "du", "which", "jq", "diff", "cut", "sort", "uniq", "awk", "sed",
]);
const INSPECT_GIT = /^git\s+(-C\s+\S+\s+)?(diff|log|status|show|blame|grep|branch|rev-parse|ls-files|ls-tree|describe|remote)\b/;

/** a redirection into a FILE — `2>&1`, `>&2` and `> /dev/null` write nowhere */
function redirectTarget(segment: string): string | undefined {
  for (const m of segment.matchAll(/(?:^|[^0-9&<>])(\d?)>>?\s*([^\s&|;<>]+)/g)) {
    const target = m[2]!;
    if (target.startsWith("&") || target === "/dev/null" || target === "/dev/stderr" || target === "/dev/stdout") continue;
    return target.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

function editTarget(segment: string): { edit: boolean; path?: string } {
  const redirect = redirectTarget(segment);
  if (redirect) return { edit: true, path: redirect };
  const tee = /^tee\s+(?:-a\s+)?(\S+)/.exec(segment) ?? /\|\s*tee\s+(?:-a\s+)?(\S+)/.exec(segment);
  if (tee) return { edit: true, path: tee[1] };
  if (/^sed\s+(-\w*\s+)*-i/.test(segment) || /^perl\s+-\w*i/.test(segment)) {
    const last = segment.trim().split(/\s+/).at(-1);
    return { edit: true, ...(last && !last.startsWith("-") ? { path: last } : {}) };
  }
  if (/^(patch|apply_patch)\b/.test(segment) || /^git\s+apply\b/.test(segment)) return { edit: true };
  return { edit: false };
}

/**
 * HOW-35: one shell command's class. Edit beats verify beats inspect: `bun test > out.txt`
 * wrote a file. `truncated` (the command ran past the log's clip): an edit or verify that is
 * already visible stands, because more text cannot unsay it — but an inspect or other could
 * be overturned by a redirect past the cut, so it is `unclassified`.
 */
export function classifyShell(command: string, opts: { verifyCommand?: string; truncated?: boolean } = {}): CallClassification {
  // codex wraps commands as `bash -lc '<cmd>'`: classify what the wrapper runs
  const wrapped = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*?)(\1)?$/.exec(command.trim());
  if (wrapped) return classifyShell(wrapped[2]!, { ...opts, truncated: opts.truncated || wrapped[3] === undefined });
  const segments = command.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  // a bare `cd dir` steers, it does not inspect: drop it so `cd x && bun test` reads as verify
  const work = segments.filter((s) => !/^cd\s/.test(s));
  for (const s of work) {
    const edit = editTarget(s);
    if (edit.edit) return { cls: "edit", ...(edit.path ? { path: edit.path } : {}) };
  }
  const verify = opts.verifyCommand?.trim();
  if ((verify && command.includes(verify)) || work.some((s) => VERIFY_RUNNERS.some((r) => r.test(s)))) return { cls: "verify" };
  if (opts.truncated) return { cls: "unclassified" };
  if (work.length && work.every((s) => {
    const piped = s.split("|").map((p) => p.trim());
    return piped.every((p) => INSPECT_HEADS.has(p.split(/\s+/)[0] ?? "") || INSPECT_GIT.test(p));
  })) return { cls: "inspect" };
  return { cls: "other" };
}
