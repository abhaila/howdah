/**
 * The prompt template contract — ONE implementation of "what `{{ context.x }}` means",
 * shared by everything that touches a rendered prompt (T21).
 *
 * Three callers depend on identical behaviour:
 *   engine/run.ts        renders the pinned template and hashes the result (rendered_hash)
 *   prompts/store.ts     extracts the reads a revision introduces (OV-3 accept guard)
 *   prompts/library.ts   RECONSTRUCTS a past render from the pinned file + context_read
 *                        and proves it by re-hashing to the recorded rendered_hash
 *
 * The third caller is why this file exists: the log stores the hash, not the text, so the
 * reconstruction is only trustworthy while it renders byte-identically to the engine. Two
 * copies of this regex would make hash verification a coin toss the first time one drifted.
 *
 * system-map 0.1: the same holds for everything APPENDED to the template. The skill hint
 * and outputs contract used to be bolted on inside the executors, after hashing, so
 * rendered_hash never covered the bytes the agent actually read. Every suffix is now built
 * here, assembled by assemblePrompt() in one fixed order, and applied by the engine BEFORE
 * hashing; executors send the result unchanged. Suffix wording is keyed by SUFFIX_VERSION
 * (logged on prompt-rendered), so rewording a suffix bumps the version instead of silently
 * turning every earlier render UNVERIFIED.
 *
 * system-map 0.2: an operator's reply to a failed agent attempt is rendered into the
 * retried prompt. Its wording is a versioned builder like the others — v2 is v1 plus
 * replyInstruction, and v1 stays byte-for-byte what it was.
 *
 * system-map 1c: v3 = v2 + refusalInstruction — when the graph's validateProposal refused a
 * proposer's output, the retried attempt is told WHY (the validator's errors), so it can fix
 * them instead of drawing the same thing again. Its source is the refusal logged on that
 * attempt's node-finished (engine/replay.ts refusalNote), so reconstruction rebuilds it.
 *
 * HOW-14: v4 = v3 + reentryInstruction — when this node's previous visit died because its
 * context window filled, the retry is told it is RE-ENTERING a step that may be partly done,
 * and to get its bearings from the working directory before continuing. Its source is the
 * log (engine/run.ts reentryAfterVisit), logged as `reentry_after_visit`, so reconstruction
 * rebuilds it exactly.
 *
 * HOW-36: v5 = v4 whose re-entry briefing also carries a STRUCTURED HANDOFF — what the
 * exhausted visit had done that git cannot show (files read, files edited, commands run and
 * whether they failed, the agent's last stated intent, the outputs still owed), derived by rule
 * from that visit's own log events (engine/handoff.ts). Bounded (HANDOFF_CHARS), with stubs
 * that say how to get elided items back; no recall tool (HOW-32: the paper's clearest negative
 * result). Reconstruction re-derives it from the same events, so the render stays VERIFIED.
 *
 * HOW-47: v6 = v5 + steerInstruction — an operator steer sent to a running turn that ended
 * before it could be delivered is carried into the run's next agent render. Its source is the
 * `operator-steered` events themselves, named by seq on `prompt-rendered.steers_carried`, so
 * reconstruction reads the same texts.
 *
 * HOW-48: v7 = v6 + stopResumeInstruction — the step's previous visit was soft-stopped by the
 * operator; the retry is told where the agent said it was. Its source is that visit's
 * `soft-stop-honored.last_message`, named by seq on `prompt-rendered.resumed_after_stop`.
 *
 * Includes (system-map 1c review): `{{> prompt.id }}` pulls another prompt file's body in AT
 * PIN TIME — expandIncludes() runs when a run pins its prompts, and the pinned file holds the
 * expanded text. Rendering, rendered_hash and reconstruction therefore never see an include:
 * the single-renderer invariant holds unchanged. The prompt store's undeclared-read guard and
 * the codegen check expand through the same function.
 */
import { createHash } from "node:crypto";
import { harnessSpec, isHarness } from "./harnesses";
import { INCLUDE_REF, TEMPLATE_FILTERS, ifBlockPattern, isEngineNamespace, templateRefPattern } from "./template-refs";
import type { Harness } from "./graph";

/**
 * HOW-22: the reference grammar itself lives in core/template-refs.ts, which is node-free so
 * the viewer can bundle it (the graph builder needs templateReads live, in the browser).
 * Re-exported here because this file is still the one place a caller asks about templates —
 * the split moved the regex, it did not add a second one.
 */
export { TEMPLATE_REF, TEMPLATE_FILTERS, IF_BLOCK, INCLUDE_REF, includeRefs, templateRefPattern, ifBlockPattern, isEngineNamespace, templateReads, templateFilterProblems } from "./template-refs";

// ---- render rules (HOW-37) ---------------------------------------------------------

/**
 * The substitution rules new renders use, logged as `render_version` on prompt-rendered.
 * Absent on an event = v1. Like SUFFIX_VERSION, changing what a value renders as changes
 * rendered_hash, so the rules are versioned and a past render is rebuilt by ITS rules:
 *   v1  strings raw, everything else JSON; any `| filter` parsed and ignored
 *   v2  `| dump` is JSON always (strings included); a value whose rendered text is longer than
 *       the cap is clipped head and tail around a stub that says how big it was, that what
 *       surrounds the stub is no longer valid JSON (when it was JSON), and where the whole
 *       value is — so the agent can go and get it instead of guessing; and (HOW-44) a
 *       `{{#if context.key}}…{{/if}}` block renders its body only when the value is a
 *       non-empty string or `true` (v1 never had a block, so no v1 prompt carries one)
 */
export const RENDER_VERSION = 2;

/**
 * HOW-37: the default cap, in UTF-16 code units of a value's RENDERED text. Chosen from real
 * logs, not guessed: across 494 context reads in 15 runs under ~/.howdah/runs (2026-10-12) the
 * p50 was 1.3k, p95 29.9k, p99 46.7k and the max 48.5k — and the biggest were legitimate
 * (`implementation_plan`, `slice.drift`, the run's own `work` scope). 16k (map/neighbourhood's
 * cap) would have elided real plans, so the default sits above everything observed, with
 * headroom: it bounds the runaway case (a findings value growing across repair loops) without
 * touching a normal value. Per graph / node / tuning via AgentConfig.contextCap.
 */
export const DEFAULT_CONTEXT_CAP = 64_000;

export interface RenderRules {
  /** 1 (absent on old events) or 2 */
  version: number;
  /** v2: the most characters one value's rendered text may take before it is elided */
  cap?: number;
  /** v2: keys never elided (the engine passes the run's inputs: the operator's own words) */
  exempt?: ReadonlySet<string>;
  /** v2: where the full value of `key` is, for the stub — "the output of review@3 in …" */
  sourceOf?: (key: string) => string;
  /**
   * v2, reconstruction: elide EXACTLY these keys (the ones the engine logged as elided). The
   * engine leaves it unset and decides by the cap.
   */
  elideOnly?: ReadonlySet<string>;
}

export class TemplateError extends Error {}

/** the text a value renders as, before any cap */
function valueText(value: unknown, filter: string | undefined, version: number): string {
  if (version >= 2 && filter === "dump") return JSON.stringify(value) ?? "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * HOW-37: `text` clipped to about `cap` characters, head and tail kept, the stub between. Cut
 * at code-point boundaries — a surrogate pair is never split, so the result is always valid
 * UTF-16 (and therefore valid UTF-8 when encoded).
 */
export function elide(key: string, text: string, cap: number, opts: { json: boolean; source?: string }): string {
  const lines = text.split("\n").length;
  let headEnd = Math.ceil(cap / 2);
  let tailStart = text.length - Math.floor(cap / 2);
  // never end the head on a high surrogate, never start the tail on a low one
  if (headEnd > 0 && isHigh(text.charCodeAt(headEnd - 1))) headEnd--;
  if (tailStart < text.length && isLow(text.charCodeAt(tailStart))) tailStart++;
  const where = opts.source ?? "in this run's log";
  const stub =
    `\n[context.${key} elided: ${text.length} chars, ${lines} lines; the middle ${tailStart - headEnd} chars are omitted` +
    (opts.json ? `, so the text around this note is NOT valid JSON` : "") +
    `. The full value is ${where} — re-read or re-run its source to get it again.]\n`;
  return text.slice(0, headEnd) + stub + text.slice(tailStart);
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Substitute every ref via `resolve`, by the rules of `rules.version` (default v1 — what every
 * pre-HOW-37 render used). `resolve` may throw (the engine's ContextStore does, on an unreadable
 * key) and the throw propagates untouched. Returns the text, exactly the context read (FULL
 * values — the cap is a rendering rule, never a storage one), and under v2 the keys it elided
 * with the source each stub named.
 */
export function renderTemplate(
  body: string,
  resolve: (key: string) => unknown,
  rules: RenderRules = { version: 1 },
): { text: string; read: Record<string, unknown>; elided: Record<string, string> } {
  const read: Record<string, unknown> = {};
  const elided: Record<string, string> = {};
  // HOW-44 (v2): blocks first, so a reference inside a block that renders nothing is never read
  if (rules.version >= 2)
    body = body.replace(ifBlockPattern(), (whole: string, ns: string, key: string, inner: string) => {
      if (isEngineNamespace(ns, key)) return whole;
      const value = resolve(key);
      read[key] = value;
      return (typeof value === "string" && value !== "") || value === true ? inner : "";
    });
  const text = body.replace(templateRefPattern(), (whole: string, ns: string, key: string, rawFilter: string | undefined) => {
    if (isEngineNamespace(ns, key)) return whole;
    const value = resolve(key);
    read[key] = value;
    const filter = rawFilter?.trim() || undefined;
    if (rules.version >= 2 && filter !== undefined && !(TEMPLATE_FILTERS as readonly string[]).includes(filter))
      throw new TemplateError(`unknown template filter "${filter}" in ${whole}`);
    const rendered = valueText(value, filter, rules.version);
    if (rules.version < 2 || rules.cap === undefined) return rendered;
    const shouldElide = rules.elideOnly ? rules.elideOnly.has(key) : rendered.length > rules.cap && !rules.exempt?.has(key);
    if (!shouldElide) return rendered;
    const source = rules.sourceOf?.(key) ?? "in this run's log";
    elided[key] = source;
    return elide(`${key}`, rendered, rules.cap, { json: typeof value !== "string" || filter === "dump", source });
  });
  return { text, read, elided };
}

/** The `rendered_hash` join key: first 16 hex of sha256 over the FINAL text as sent — template + every suffix (system-map 0.1). */
export function renderedHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The suffix an operator jump appends to the target node's next render. Shared because
 * reconstruction has to reproduce it byte-for-byte to verify a jumped-into turn's hash.
 */
export function operatorInstructionSuffix(message: string): string {
  return `\n\n## Operator instruction\nThe operator moved the run to this step with this instruction — it takes precedence:\n${message}`;
}

// ---- suffixes (system-map 0.1) ---------------------------------------------------

/** The suffix wording new renders use. Bump it — and add a builder set — to reword. */
export const SUFFIX_VERSION = 10;

/**
 * HOW-36: what a context-exhausted visit had done, as data — derived by engine/handoff.ts from
 * the log, worded by the v5 re-entry builder. Lists are whole here; the builder trims them to
 * the budget so trimming is part of the versioned wording.
 */
export interface Handoff {
  /** the exhausted visit */
  visit: number;
  filesRead: readonly string[];
  filesEdited: readonly string[];
  /** every shell command it ran, in order; ok: null when the log does not say */
  commands: ReadonlyArray<{ command: string; ok: boolean | null }>;
  /** the agent's last words before the window filled (the tail of its last text run), or null */
  lastText: string | null;
  /** the node's declared outputs — an exhausted attempt published none of them */
  outputsOwed: readonly string[];
  /** it filled its window before calling any tool at all */
  noToolCalls: boolean;
}

/** HOW-36: the most characters the handoff block may take, whatever the visit did */
export const HANDOFF_CHARS = 4000;

/** The versioned builders: what a render's `suffix_version` pins. */
export interface SuffixBuilders {
  /** names the node's skills; "" when there are none */
  skillHint(skills: readonly string[]): string;
  /** the outputs contract (T16) generated from the node's declared writes */
  outputContract(keys: readonly string[]): string;
  /**
   * system-map 0.2: the operator's reply to the park this attempt retries. Absent from
   * versions that predate it (v1) — such a version cannot have rendered a reply.
   */
  replyInstruction?(message: string): string;
  /**
   * system-map 1c: why the graph refused the previous attempt's proposal. Absent from versions
   * that predate it (v1, v2) — such a version cannot have rendered a refusal.
   */
  refusalInstruction?(reason: string): string;
  /**
   * HOW-14: the re-entry briefing after a visit that ran out of context window. Absent from
   * versions that predate it (v1–v3) — such a version cannot have rendered one.
   */
  reentryInstruction?(previousVisit: number, handoff?: Handoff): string;
  /**
   * HOW-47: operator steers that were sent to a running turn but never reached it (it ended
   * before another tool call). Absent from versions that predate it (v1–v5).
   */
  steerInstruction?(messages: readonly string[]): string;
  /**
   * HOW-48: the step's previous visit was stopped by the operator at a tool boundary — the
   * agent's own last message says where it was. Absent from versions that predate it (v1–v6).
   */
  stopResumeInstruction?(lastMessage: string): string;
  /**
   * HOW-57 (G8): this run's branch is stacked on another run's — plan, build and review only
   * `<sha>..HEAD`. Absent from versions that predate it (v1–v7).
   */
  stackedInstruction?(base: StackedOn): string;
  /**
   * A review of repairs: judge only `<sha>..HEAD`, the range the repairs it reviews have
   * changed since this step last judged (engine/repair-scope.ts). Absent from v1–v8.
   */
  repairScopeInstruction?(scope: RepairScope): string;
}

/** where the repairs a review judges began: the step, its visit, and the commit it started from */
export interface RepairScope {
  node: string;
  visit: number;
  sha: string;
  branch?: string;
}

/** HOW-57: the branch and commit a stacked run's work sits on (`deps.base` / `deps.base_tip`). */
export interface StackedOn {
  branch: string;
  sha: string;
}

/**
 * v1 is byte-for-byte what claude.ts / codex.ts appended before 0.1, so the text agents
 * read did not change when the proof moved to cover it. NEVER edit a published version.
 */
const V1: SuffixBuilders = {
  skillHint: (skills) =>
    skills.length ? `\n\nRelevant installed skills for this task: ${skills.map((s) => `/${s}`).join(", ")} — invoke them where they apply.` : "",
  outputContract: (keys) => {
    if (keys.length === 0)
      return "\n\n## Output\nWhen your work is complete, end your reply with a one-line summary of what you did.";
    return (
      `\n\n## Output contract (required)\n` +
      `When your work is complete, the LAST line of your reply must be a single JSON object of the form\n` +
      `{"outputs": {${keys.map((k) => `"${k}": <value>`).join(", ")}}}\n` +
      `containing exactly these keys: ${keys.join(", ")}. No markdown fence, no trailing text.`
    );
  },
};

/** v2 (system-map 0.2) = v1 + the operator reply suffix. NEVER edit a published version. */
const V2: SuffixBuilders = {
  ...V1,
  replyInstruction: (message) =>
    `\n\n## Operator reply\nThe previous attempt at this step failed and the run parked. The operator replied — take it into account on this attempt:\n${message}`,
};

/** v3 (system-map 1c) = v2 + the proposal-refusal suffix. NEVER edit a published version. */
const V3: SuffixBuilders = {
  ...V2,
  refusalInstruction: (reason) =>
    `\n\n## Your previous proposal was refused\nThe previous attempt at this step produced a proposal the graph's validator refused. Fix every problem below and return the corrected proposal:\n${reason}`,
};

/** v4 (HOW-14) = v3 + the context re-entry briefing. NEVER edit a published version. */
const V4: SuffixBuilders = {
  ...V3,
  reentryInstruction: (previousVisit) =>
    `\n\n## Re-entering this step\n` +
    `Visit ${previousVisit} of this step ran out of context window space before it finished. ` +
    `Its work may already be partly done in the working directory, and you do not have its conversation. ` +
    `Get your bearings before changing anything:\n` +
    `1. Run \`git status\`, \`git diff --stat\` and \`git log --oneline -20\` to see what is already done.\n` +
    `2. Re-read the task above.\n` +
    `3. Continue from where the work stands rather than starting over, and commit as you go so progress survives if this happens again.`,
};

/** a line, clipped to `max` characters with an ellipsis */
const clipLine = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * HOW-36: the handoff block, bounded by HANDOFF_CHARS. It is built at a generous size and the
 * lists are halved until it fits; every list that lost items says how many and how to get them
 * back. Deterministic — the same handoff always words the same way, which reconstruction needs.
 */
export function handoffBlock(h: Handoff): string {
  if (h.noToolCalls) {
    const said = h.lastText ? `\nIts last words were:\n> ${clipLine(h.lastText, 1500).replace(/\n/g, "\n> ")}` : "";
    return `\n\n## What the previous visit had done\nVisit ${h.visit} exhausted its context before calling any tool, so there is nothing from it to pick up beyond what the task itself says.${said}`;
  }
  const build = (limit: number, lineMax: number, textMax: number): string => {
    const list = (items: readonly string[], more: (n: number) => string) => {
      if (items.length === 0) return "- (none)";
      const shown = items.slice(0, limit).map((i) => `- ${clipLine(i, lineMax)}`);
      if (items.length > limit) shown.push(`- ${more(items.length - limit)}`);
      return shown.join("\n");
    };
    const recent = h.commands.slice(-limit);
    const earlier = h.commands.length - recent.length;
    const commands = h.commands.length === 0
      ? "- (none)"
      : [
          ...(earlier > 0 ? [`- +${earlier} earlier command${earlier === 1 ? "" : "s"}; re-run one to see its output again`] : []),
          ...recent.map((c) => `- \`${clipLine(c.command.replace(/\s+/g, " "), lineMax)}\` — ${c.ok === null ? "status not logged" : c.ok ? "ok" : "FAILED"}`),
        ].join("\n");
    const intent = h.lastText ? `> ${clipLine(h.lastText, textMax).replace(/\n/g, "\n> ")}` : "(it said nothing after its last tool call)";
    return (
      `\n\n## What the previous visit had done\n` +
      `Derived from visit ${h.visit}'s own tool calls (inputs were logged clipped, so a long command or path may be cut short). ` +
      `It is a map of where to look, not a substitute for looking: re-read a file or re-run a command to see it as it is now.\n` +
      `\n### Files examined\n${list(h.filesRead, (n) => `+${n} more files read; re-read a file to see it again`)}\n` +
      `\n### Files modified\n${list(h.filesEdited, (n) => `+${n} more files modified; \`git status\` lists them all`)}\n` +
      `\n### Commands run (most recent last)\n${commands}\n` +
      `\n### Last stated intent\n${intent}\n` +
      `\n### Outputs still owed\n${h.outputsOwed.length ? h.outputsOwed.map((k) => `- ${k}`).join("\n") : "- (none: this step publishes nothing)"}`
    );
  };
  for (const [limit, lineMax, textMax] of [[20, 160, 1500], [10, 120, 1000], [5, 100, 600], [3, 80, 300], [1, 60, 160]] as const) {
    const text = build(limit, lineMax, textMax);
    if (text.length <= HANDOFF_CHARS) return text;
  }
  const last = build(1, 60, 160);
  return `${last.slice(0, HANDOFF_CHARS - 60)}\n[handoff cut at ${HANDOFF_CHARS} characters]`;
}

/**
 * v5 (HOW-36) = v4 + the structured handoff, placed after the "ran out" sentence and before the
 * git steps, which stay — git is still the truth about the working tree. NEVER edit a
 * published version.
 */
const V5: SuffixBuilders = {
  ...V4,
  reentryInstruction: (previousVisit, handoff) => {
    const v4 = V4.reentryInstruction!(previousVisit);
    if (!handoff) return v4;
    const steps = v4.indexOf("Get your bearings");
    return v4.slice(0, steps).trimEnd() + handoffBlock(handoff) + "\n\n" + v4.slice(steps);
  },
};

/** v6 (HOW-47) = v5 + the carried operator-steer suffix. NEVER edit a published version. */
const V6: SuffixBuilders = {
  ...V5,
  steerInstruction: (messages) =>
    `\n\n## Operator steering\n` +
    `While an earlier step was running, the operator sent ${messages.length === 1 ? "this instruction" : "these instructions"}. ` +
    `${messages.length === 1 ? "It" : "They"} did not reach that step before it finished, so take ${messages.length === 1 ? "it" : "them"} into account here:\n` +
    messages.map((m) => `- ${m.trim().replace(/\n/g, "\n  ")}`).join("\n"),
};

/** v7 (HOW-48) = v6 + the resume-after-operator-stop briefing. NEVER edit a published version. */
const V7: SuffixBuilders = {
  ...V6,
  stopResumeInstruction: (lastMessage) =>
    `\n\n## Resuming after an operator stop\n` +
    `The operator stopped the previous visit of this step at a tool boundary, and it ended its turn there. ` +
    `Its last message said where the work stood:\n` +
    lastMessage.trim().split("\n").map((l) => `> ${l}`).join("\n") +
    `\nPick up from there: check \`git status\` and \`git log --oneline -10\` against that account, then continue rather than starting over.`,
};

/**
 * v8 (HOW-57, G8) = v7 + the STACKED briefing for a run whose branch sits on another run's PR.
 * Without it a planner re-plans the base's work and a reviewer reviews it, because the base's
 * commits are in the worktree too. NEVER edit a published version.
 */
const V8: SuffixBuilders = {
  ...V7,
  stackedInstruction: ({ branch, sha }) =>
    `\n\n## Stacked change\n` +
    `This change is stacked on ${branch}@${sha.slice(0, 12)} — another slice's branch, with its own PR. ` +
    `Your change is \`${sha.slice(0, 12)}..HEAD\`: plan, build and judge only that range, and do not modify or review the base's commits. ` +
    `Use \`git diff ${sha.slice(0, 12)}..HEAD\` and \`git log ${sha.slice(0, 12)}..HEAD\` to see it.`,
};

/**
 * v9 = v8 + the REPAIR SCOPE briefing for a step that reviews other steps' repairs
 * (`reviewsWorkOf`). Without it the reviewer judged the whole branch against its target and
 * found a new rule to reject on every visit. NEVER edit a published version.
 */
const V9: SuffixBuilders = {
  ...V8,
  repairScopeInstruction: ({ node, visit, sha, branch }) => {
    const short = sha.slice(0, 12);
    return (
      `\n\n## Repair scope\n` +
      `This is a review of a repair, not of the whole branch. The repair began at ${node}@${visit} from ${short}${branch ? ` on ${branch}` : ""}; ` +
      `everything on the branch up to that commit was reviewed and published already — it is context, not the subject. ` +
      `Judge only what changed since: \`git diff ${short}\` (committed and uncommitted) and \`git log ${short}..HEAD\`. ` +
      `Where that diff merely replays commits that already sit on the target branch (a rebase or restack), those are not the repair's work. ` +
      `A defect you notice outside this range is a note for the summary, not a blocking finding.`
    );
  },
};

/**
 * v10 = v9 + a NEVER-MERGE sentence in the STACKED briefing. A stacked PR's base is another PR's
 * branch, which is unprotected, so `gh pr merge --auto` merges it at once: two runs collapsed a
 * stacked PR into its base that way (#14969/#14971, then #15104 into #15102). The publish prompt
 * says so since delivery.publish v4, but prompts are pinned at run start and suffixes are not, so
 * this is what reaches runs already in flight. NEVER edit a published version.
 */
const V10: SuffixBuilders = {
  ...V9,
  stackedInstruction: (base) =>
    V9.stackedInstruction!(base) +
    ` Never merge a pull request yourself and never enable auto-merge: do not run \`gh pr merge\` in any form ` +
    `(\`--auto\`, \`--squash\`, \`--merge\` or \`--rebase\`). This PR's base is another PR's branch, which is unprotected, ` +
    `so any merge request completes at once and folds this change into that PR. Merging a stacked PR is a human decision.`,
};

const SUFFIX_BUILDERS: Readonly<Record<number, SuffixBuilders>> = { 1: V1, 2: V2, 3: V3, 4: V4, 5: V5, 6: V6, 7: V7, 8: V8, 9: V9, 10: V10 };
/** the builders new renders use; bump together with SUFFIX_VERSION */
const CURRENT: SuffixBuilders = V10;

/** The builders a logged `suffix_version` pins, or undefined for a version this code never had. */
export function suffixBuilders(version: number): SuffixBuilders | undefined {
  return Object.hasOwn(SUFFIX_BUILDERS, version) ? SUFFIX_BUILDERS[version] : undefined;
}

/** The current outputs contract — kept under its T16 name for callers and tests. */
export function buildOutputInstruction(keys: readonly string[]): string {
  return CURRENT.outputContract(keys);
}

/**
 * The skills that actually reach the prompt for a harness. Codex never got a skill hint and
 * still does not; claude and opencode (which runs through the claude executor) do; cursor
 * does not, because cursor-agent has no Claude Code skills and a hint would name tools it
 * cannot run. The result is what gets LOGGED as `skills`, so this must answer for the
 * prompt that was actually sent — a harness handed a hint it never got would break
 * reconstruction. HOW-17: that answer is a declared field on harnessSpec, never a default,
 * so a new harness cannot inherit claude's by omission — and a name the table does not know
 * (a hand-edited tuning.json) gets no hint rather than a throw, for the same reason: naming
 * Claude Code skills to an unidentified CLI is exactly the accident this field prevents.
 */
export function skillsForHarness(harness: Harness | undefined, skills: readonly string[] | undefined): string[] {
  if (harness === undefined) return [...(skills ?? [])];
  if (!isHarness(harness)) return [];
  if (!harnessSpec(harness).skillHint) return [];
  return [...(skills ?? [])];
}

export interface PromptParts {
  /** the rendered template body (renderTemplate's text) */
  body: string;
  /** operator jump instruction consumed by this render (built via operatorInstructionSuffix) */
  jumpMessage?: string;
  /**
   * system-map 0.2: the operator's reply to the park this attempt retries — the raw
   * message; the version's replyInstruction builder words it.
   */
  replyMessage?: string;
  /** system-map 1c: the validator's refusal of the previous attempt's proposal — raw text */
  refusalMessage?: string;
  /** HOW-14: the visit of this node whose context window filled — renders the re-entry briefing */
  reentryAfterVisit?: number;
  /** HOW-36 (v5): what that visit had done — engine/handoff.ts, re-derived by reconstruction */
  handoff?: Handoff;
  /** HOW-47: steers that never reached the turn they were sent to — raw texts, oldest first */
  steerMessages?: readonly string[];
  /** HOW-48: the agent's last message from a visit the operator soft-stopped */
  stopResumeMessage?: string;
  /** HOW-57 (v8): what this run's branch is stacked on — renders the STACKED briefing */
  stackedOn?: StackedOn;
  /** v9: where the repairs this step reviews began — renders the REPAIR SCOPE briefing */
  repairScope?: RepairScope;
  /** skills named in the hint — already filtered by skillsForHarness */
  skills: readonly string[];
  /** the node's declared write keys, in declaration order */
  outputKeys: readonly string[];
  suffixVersion: number;
}

/**
 * The ONE assembly of a prompt as sent. Fixed order:
 *   template body → stacked briefing (HOW-57) → repair scope (v9) → operator jump → operator reply (0.2) → proposal refusal (1c)
 *   → context re-entry (HOW-14) → resume after operator stop (HOW-48) → carried operator steers
 *   (HOW-47) → skill hint → outputs contract.
 * Throws on a suffix version with no builders — the engine only ever passes SUFFIX_VERSION,
 * and reconstruction checks suffixBuilders() first — and on a reply, refusal or re-entry
 * under a version with no builder for it, which no engine ever produced.
 */
export function assemblePrompt(parts: PromptParts): string {
  const builders = suffixBuilders(parts.suffixVersion);
  if (!builders) throw new Error(`no builders for suffix version ${parts.suffixVersion}`);
  let stacked = "";
  if (parts.stackedOn !== undefined) {
    if (!builders.stackedInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no stacked builder`);
    stacked = builders.stackedInstruction(parts.stackedOn);
  }
  let scope = "";
  if (parts.repairScope !== undefined) {
    if (!builders.repairScopeInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no repair-scope builder`);
    scope = builders.repairScopeInstruction(parts.repairScope);
  }
  let reply = "";
  if (parts.replyMessage !== undefined) {
    if (!builders.replyInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no reply builder`);
    reply = builders.replyInstruction(parts.replyMessage);
  }
  let refusal = "";
  if (parts.refusalMessage !== undefined) {
    if (!builders.refusalInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no refusal builder`);
    refusal = builders.refusalInstruction(parts.refusalMessage);
  }
  let reentry = "";
  if (parts.reentryAfterVisit !== undefined) {
    if (!builders.reentryInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no re-entry builder`);
    reentry = builders.reentryInstruction(parts.reentryAfterVisit, parts.handoff);
  }
  let steer = "";
  if (parts.steerMessages !== undefined && parts.steerMessages.length > 0) {
    if (!builders.steerInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no steer builder`);
    steer = builders.steerInstruction(parts.steerMessages);
  }
  let stopResume = "";
  if (parts.stopResumeMessage !== undefined) {
    if (!builders.stopResumeInstruction) throw new Error(`suffix version ${parts.suffixVersion} has no stop-resume builder`);
    stopResume = builders.stopResumeInstruction(parts.stopResumeMessage);
  }
  return (
    parts.body +
    stacked +
    scope +
    (parts.jumpMessage !== undefined ? operatorInstructionSuffix(parts.jumpMessage) : "") +
    reply +
    refusal +
    reentry +
    stopResume +
    steer +
    builders.skillHint(parts.skills) +
    builders.outputContract(parts.outputKeys)
  );
}

/** Split `---\nfront-matter\n---\nbody`; returns the whole text as body when absent. */
export function splitFrontMatter(raw: string): { frontmatter: string | null; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return { frontmatter: null, body: raw };
  return { frontmatter: m[1], body: m[2] };
}

/** A scalar front-matter field, or null. */
export function frontMatterField(frontmatter: string | null, name: string): string | null {
  if (!frontmatter) return null;
  const m = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return m && m[1] !== undefined ? m[1].trim() : null;
}

// ---- includes (system-map 1c review) ----------------------------------------------------

/** includes may nest this deep (a partial including a partial); deeper is refused */
export const MAX_INCLUDE_DEPTH = 3;

export class IncludeError extends Error {}

/**
 * Expand every `{{> id }}` with `load(id)` — the included prompt's BODY (front-matter already
 * stripped) — recursively, trailing whitespace of each included body trimmed. Refuses cycles,
 * nesting deeper than MAX_INCLUDE_DEPTH and ids `load` cannot provide (IncludeError). Returns
 * the text and every id included (transitively), in first-use order. A body with no include is
 * returned unchanged, byte for byte.
 */
export function expandIncludes(body: string, load: (id: string) => string, stack: readonly string[] = []): { text: string; included: string[] } {
  const included: string[] = [];
  const text = body.replace(new RegExp(INCLUDE_REF, "g"), (_whole: string, id: string) => {
    if (stack.includes(id)) throw new IncludeError(`include cycle: ${[...stack, id].join(" → ")}`);
    if (stack.length >= MAX_INCLUDE_DEPTH) throw new IncludeError(`includes nest deeper than ${MAX_INCLUDE_DEPTH}: ${[...stack, id].join(" → ")}`);
    let inner: string;
    try {
      inner = load(id);
    } catch (err) {
      throw new IncludeError(`cannot include "${id}"${stack.length ? ` (from ${stack.at(-1)})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const expanded = expandIncludes(inner, load, [...stack, id]);
    for (const i of [id, ...expanded.included]) if (!included.includes(i)) included.push(i);
    return expanded.text.replace(/\s+$/, "");
  });
  return { text, included };
}

/** A prompt id that names a partial (last dot-segment starts with `_`): included, never run. */
export function isPartialId(id: string): boolean {
  return (id.split(".").at(-1) ?? "").startsWith("_");
}
