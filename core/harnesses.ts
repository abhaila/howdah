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
import type { PermissionMode } from "./graph";

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
  status: HarnessStatus;
}

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
