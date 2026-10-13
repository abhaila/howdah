/**
 * The harness table (HOW-17) — one record per agent CLI Howdah can run.
 *
 * Before this file, "which harness" was a two-way ternary repeated in six places:
 * `harness === "codex" ? ... : ...` decided the model family (core/graph.ts), the skill hint
 * (core/template.ts), the login verb (engine/executors/harness-failure.ts), the login command
 * (web/server.ts), doctor's per-harness checks (cli/main.ts) and the viewer's harness picker
 * (web/app/screens/graphs.tsx). A third harness cannot be added to six ternaries without one
 * of them being missed, and the one that gets missed is silent: cursor would have inherited
 * claude's skill hint and claude's login verb, and the log would have said `skills: [...]`
 * for a prompt that never carried them.
 *
 * So every per-harness FACT lives here and nowhere else. Adding a fourth harness is a new
 * entry plus an adapter and an executor — never an edit to a UI literal.
 *
 * Node-free and dependency-free on purpose: the browser bundle imports it (the viewer's
 * harness Select), exactly like core/clock-time.ts. Anything this file imported would ship
 * to the browser with it, so `PermissionMode` comes in as a type only.
 */
import type { Effort, PermissionMode } from "./graph";

/**
 * Every harness, in preference order. This IS the order the viewer offers, doctor checks,
 * and the fallback chain hands off along.
 */
export const HARNESS_NAMES = ["claude", "codex", "cursor", "opencode"] as const;

export type HarnessName = (typeof HARNESS_NAMES)[number];

/**
 * How much of an install a harness is:
 *   core      doctor fails without it — the harnesses a working Howdah assumes
 *   optional  offered, checked and honestly reported, but its absence is not a broken install
 *   internal  routed through another harness's executor; never offered as a choice, never
 *             probed on its own (opencode runs through the claude executor and binary today)
 */
export type HarnessStatus = "core" | "optional" | "internal";

export interface HarnessSpec {
  name: HarnessName;
  /** the CLI on PATH */
  binary: string;
  /** the subcommand a human logs in with — the command is `<binary> <loginVerb>` */
  loginVerb: string;
  /**
   * argv that answers "am I logged in" locally and without spending a token, or undefined
   * when the harness has no such subcommand. Being on PATH is not being logged in.
   */
  authProbe?: readonly string[];
  /**
   * the model names that belong to this harness. A model name leaked across harnesses is an
   * API 400, so this decides what `modelFitsHarness` lets through. No `g` flag — these are
   * tested repeatedly and a sticky lastIndex would make the answer depend on call order.
   */
  modelFamily: RegExp;
  /**
   * true for a multi-provider router that genuinely runs other harnesses' models (cursor
   * serves sonnet and gpt alike), so a foreign-looking model name is not a mistake there.
   */
  acceptsForeignModels: boolean;
  /** does a prompt for this harness carry the skill hint? (core/template.ts skillsForHarness) */
  skillHint: boolean;
  /**
   * a permission mode this harness ALWAYS runs in, whatever any layer asked for. Claude is
   * the only one: full Claude Code autonomy without bypass mode (9f59264). A harness with no
   * entry here takes the resolved mode — cursor must not silently inherit claude's `auto`.
   */
  forcedPermissionMode?: PermissionMode;
  /**
   * HOW-33: the effort levels this harness's CLI accepts, as Howdah spells them, or null when
   * it has no effort control at all. A resolved effort the harness cannot take is reported
   * as inert (effortFor) rather than dropped: a knob the viewer shows and the run ignores
   * would make an A/B comparison over it measure noise.
   */
  effortLevels: readonly Effort[] | null;
  /**
   * an explicit translation for a Howdah level this harness does not accept verbatim — the
   * only way a level crosses harnesses, so a claude-only `max` never leaks onto codex as a
   * value its API refuses
   */
  effortMap?: Partial<Record<Effort, Effort>>;
  /**
   * HOW-41: the flags that restrict the agent's tools, or null when the harness has none. A
   * node with a tools setting on a null harness is refused before it starts — never run
   * unrestricted. (codex has sandbox modes, not a tool list; cursor-agent documents none.)
   */
  toolFlags: { allow: string; deny: string } | null;
  /**
   * HOW-41: the tool names this harness ships, for ADVICE in the builder (a name outside the
   * list is probably a typo, but CLIs add tools, so it never blocks). Empty: nothing to check.
   */
  knownTools: readonly string[];
  /**
   * HOW-39: can the harness run a command after each file edit, inside the agent's turn, and
   * hand its output back to the model? claude can (a PostToolUse hook through `--settings`).
   * The others cannot yet, and a prompt line pretending otherwise would be worse than nothing.
   */
  editHooks: boolean;
  status: HarnessStatus;
}

/** claude 2.1.296's built-in tools (`claude --help` / the tool list its init event reports) */
const CLAUDE_TOOLS = [
  "Bash", "BashOutput", "Edit", "ExitPlanMode", "Glob", "Grep", "KillShell", "LS", "MultiEdit", "NotebookEdit",
  "NotebookRead", "Read", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write", "AskUserQuestion", "Skill", "SlashCommand",
] as const;

const SPECS: Record<HarnessName, HarnessSpec> = {
  claude: {
    name: "claude",
    binary: "claude",
    loginVerb: "auth login",
    authProbe: ["claude", "auth", "status"],
    modelFamily: /claude|opus|sonnet|haiku|fable/i,
    acceptsForeignModels: false,
    skillHint: true,
    forcedPermissionMode: "auto",
    // `claude --help` (2.1.296): --effort <level> (low, medium, high, xhigh, max)
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    toolFlags: { allow: "--allowedTools", deny: "--disallowedTools" },
    knownTools: CLAUDE_TOOLS,
    editHooks: true,
    status: "core",
  },
  codex: {
    name: "codex",
    binary: "codex",
    loginVerb: "login",
    authProbe: ["codex", "login", "status"],
    modelFamily: /gpt|codex|terra|luna|^o\d/i,
    acceptsForeignModels: false,
    skillHint: false,
    // turn/start `effort`: the app-server schema (0.154.0) types it as a model-advertised
    // string; the gpt-5 family advertises low..xhigh. There is no `max`, so it is mapped down.
    effortLevels: ["low", "medium", "high", "xhigh"],
    effortMap: { max: "xhigh" },
    toolFlags: null,
    knownTools: [],
    editHooks: false,
    status: "core",
  },
  cursor: {
    name: "cursor",
    binary: "cursor-agent",
    loginVerb: "login",
    authProbe: ["cursor-agent", "status"],
    // cursor's OWN model names; it also serves claude's and openai's, which is what
    // acceptsForeignModels says. A name matching nothing anywhere is still allowed through,
    // the same way it always was — only a name that clearly belongs elsewhere is refused.
    modelFamily: /^(auto|composer|cheetah)\b|cursor/i,
    acceptsForeignModels: true,
    // cursor-agent has no Claude Code skills, so a skill hint would name tools it cannot run
    skillHint: false,
    // cursor-agent documents no effort flag: an effort set for a cursor node is inert
    effortLevels: null,
    toolFlags: null,
    knownTools: [],
    editHooks: false,
    status: "optional",
  },
  opencode: {
    // runs through the claude executor and the claude binary (engine/executors/index.ts), so
    // it is not a CLI of its own to probe, install or offer as a choice
    name: "opencode",
    binary: "claude",
    loginVerb: "auth login",
    modelFamily: /$^/, // matches nothing: it routes whatever it is given
    acceptsForeignModels: true,
    skillHint: true,
    // the claude binary, so claude's levels
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    toolFlags: { allow: "--allowedTools", deny: "--disallowedTools" },
    knownTools: CLAUDE_TOOLS,
    editHooks: true,
    status: "internal",
  },
};

/** The ordered list of harness names — the single source for the viewer and for doctor. */
export function harnessNames(): HarnessName[] {
  return [...HARNESS_NAMES];
}

/** The one record per harness. */
export function harnessSpec(harness: HarnessName): HarnessSpec {
  return SPECS[harness];
}

/** Is this string a harness Howdah knows? The guard every string boundary goes through. */
export function isHarness(name: string | undefined): name is HarnessName {
  return name !== undefined && (HARNESS_NAMES as readonly string[]).includes(name);
}

/**
 * The spec for a name that may be a harness name OR the binary it spawns — and, in tests, a
 * path to a fake binary, which matches nothing and correctly gets no spec.
 */
export function harnessSpecForCommand(command: string): HarnessSpec | undefined {
  if (isHarness(command)) return SPECS[command];
  return harnessNames().map(harnessSpec).find((s) => s.binary === command && s.status !== "internal");
}

/**
 * HOW-33: what a resolved effort becomes on this harness — `effort` when the CLI will receive
 * it (verbatim, or through the harness's explicit `effortMap`), `inert` with the reason when
 * it will not. Never both, and never neither for a set value: an effort is either sent or
 * said to be ignored. `effort` is typed as a string because tuning.json is hand-edited and
 * blind-cast, so a value outside the vocabulary must be refused in words, not trusted.
 */
export function effortFor(harness: HarnessName, effort: string | undefined): { effort?: Effort; inert?: string } {
  if (effort === undefined || effort === "") return {};
  const spec = SPECS[harness];
  if (!spec) return { inert: `effort ${effort}: not supported by ${harness}` };
  if (spec.effortLevels === null) return { inert: `effort ${effort}: not supported by ${harness}` };
  const levels: readonly string[] = spec.effortLevels;
  if (levels.includes(effort)) return { effort: effort as Effort };
  const mapped = spec.effortMap?.[effort as Effort];
  if (mapped !== undefined) return { effort: mapped };
  return { inert: `effort ${effort}: not accepted by ${harness} (it takes ${spec.effortLevels.join(", ")})` };
}

/**
 * HOW-41: a tool name as the harness's known list sees it — `Bash(git *)` is the Bash tool
 * with a pattern, so only the part before `(` is a name.
 */
export function toolBaseName(tool: string): string {
  const i = tool.indexOf("(");
  return (i < 0 ? tool : tool.slice(0, i)).trim();
}

/** the built-in default, used when neither the environment nor config.json names one */
export const BUILT_IN_DEFAULT_HARNESS: HarnessName = "claude";

/** the chain a harness whose allowance is gone hands off along, when config.json sets none */
export const DEFAULT_FALLBACK_CHAIN: readonly HarnessName[] = ["claude", "codex", "cursor"];

function envHarness(): string | undefined {
  // guarded so the browser bundle can import this file: there is no `process` there
  return typeof process !== "undefined" ? process.env?.HOWDAH_HARNESS : undefined;
}

/**
 * The run-level default harness: HOWDAH_HARNESS, then config.json `defaultHarness`, then the
 * built-in claude. Pure — the CALLER reads disk and passes `configured` in, so core/ stays
 * free of fs. An unrecognised name at either level is ignored rather than thrown on: a typo
 * in config.json must not make every graph unrunnable.
 */
export function defaultHarness(configured?: string, env: string | undefined = envHarness()): HarnessName {
  if (isHarness(env)) return env;
  if (isHarness(configured)) return configured;
  return BUILT_IN_DEFAULT_HARNESS;
}

/** config.json's `fallbackChain`, cleaned: known harnesses only, order preserved, no repeats. */
export function resolveFallbackChain(configured?: readonly string[]): HarnessName[] {
  const cleaned = (configured ?? []).filter(isHarness);
  const chain = cleaned.length ? cleaned : DEFAULT_FALLBACK_CHAIN;
  return [...new Set(chain)];
}

export interface FallbackQuery {
  /** the harness the attempt ran on — the chain never hands back to it */
  from: HarnessName;
  /** harnesses already spent or tried this run; the chain never loops back to one of them */
  tried?: readonly HarnessName[];
  /** is this harness's own allowance gone? */
  exhausted?: (harness: HarnessName) => boolean;
  /** config.json `fallbackChain`, when the operator set one */
  configured?: readonly string[];
}

/**
 * The next harness an exhausted one hands off to, or undefined when the chain is spent.
 *
 * The chain is an ORDER, not a successor map: the first harness in it that has not been
 * tried this run and is not itself out of allowance wins. That is what makes "claude is out,
 * and so is codex" land on cursor instead of giving up, and what stops a run from bouncing
 * back onto a harness it already failed on.
 */
export function fallbackChain(query: FallbackQuery): HarnessName | undefined {
  const spent = new Set<HarnessName>([query.from, ...(query.tried ?? [])]);
  const isExhausted = query.exhausted ?? (() => false);
  return resolveFallbackChain(query.configured).find((h) => !spent.has(h) && !isExhausted(h));
}
