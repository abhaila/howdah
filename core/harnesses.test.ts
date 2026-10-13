/**
 * The harness table (HOW-17).
 *
 * What is pinned here is the table's JOB: that every per-harness fact has exactly one home,
 * that the facts a new harness must declare cannot be inherited by omission (a missing skill
 * hint would silently hand cursor claude's, and the log would then describe a prompt that was
 * never sent), and that the fallback chain hands off in order without ever looping back onto
 * a harness the run has already spent.
 */
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_DEFAULT_HARNESS,
  DEFAULT_FALLBACK_CHAIN,
  defaultHarness,
  effortFor,
  fallbackChain,
  harnessNames,
  harnessSpec,
  harnessSpecForCommand,
  isHarness,
  resolveFallbackChain,
} from "./harnesses";
import { modelFitsHarness, resolveAgentConfigLayers } from "./graph";
import { skillsForHarness } from "./template";

describe("the table", () => {
  test("every harness declares every fact — none is left to a default", () => {
    for (const name of harnessNames()) {
      const spec = harnessSpec(name);
      expect(spec.name).toBe(name);
      expect(spec.binary.length).toBeGreaterThan(0);
      expect(spec.loginVerb.length).toBeGreaterThan(0);
      expect(typeof spec.skillHint).toBe("boolean");
      expect(typeof spec.acceptsForeignModels).toBe("boolean");
      expect(["core", "optional", "internal"]).toContain(spec.status);
    }
  });

  test("cursor is here, and it is the third harness the whole system now knows", () => {
    expect(harnessNames()).toEqual(["claude", "codex", "cursor", "opencode"]);
    expect(harnessSpec("cursor").binary).toBe("cursor-agent");
    expect(harnessSpec("cursor").loginVerb).toBe("login");
    expect(harnessSpec("cursor").authProbe).toEqual(["cursor-agent", "status"]);
    // cursor-agent has no Claude Code skills: a hint would name tools it cannot run
    expect(harnessSpec("cursor").skillHint).toBe(false);
    // and it must NOT inherit claude's forced "auto"
    expect(harnessSpec("cursor").forcedPermissionMode).toBeUndefined();
    expect(harnessSpec("claude").forcedPermissionMode).toBe("auto");
  });

  test("a name is matched to a spec by name or by binary — a fake binary path matches nothing", () => {
    expect(harnessSpecForCommand("codex")?.loginVerb).toBe("login");
    expect(harnessSpecForCommand("cursor-agent")?.name).toBe("cursor");
    expect(harnessSpecForCommand("/tmp/fake-claude.ts")).toBeUndefined();
    expect(isHarness("cursor")).toBe(true);
    expect(isHarness("nonesuch")).toBe(false);
    expect(isHarness(undefined)).toBe(false);
  });

  test("the skill hint answers off the table, so the logged `skills` match what was sent", () => {
    expect(skillsForHarness("claude", ["review"])).toEqual(["review"]);
    expect(skillsForHarness("opencode", ["review"])).toEqual(["review"]); // runs through claude
    expect(skillsForHarness("codex", ["review"])).toEqual([]);
    expect(skillsForHarness("cursor", ["review"])).toEqual([]); // the regression this table prevents
  });
});

describe("the default harness", () => {
  test("HOWDAH_HARNESS beats config.json, which beats the built-in claude", () => {
    expect(defaultHarness(undefined, undefined)).toBe(BUILT_IN_DEFAULT_HARNESS);
    expect(defaultHarness("cursor", undefined)).toBe("cursor");
    expect(defaultHarness("cursor", "codex")).toBe("codex");
  });

  test("a typo at either level is ignored, not fatal — a bad config must not brick every graph", () => {
    expect(defaultHarness("cursorr", undefined)).toBe("claude");
    expect(defaultHarness("cursor", "nonesuch")).toBe("cursor");
  });

  test("it is where an unset node harness resolves from, under the graph's own default", () => {
    expect(resolveAgentConfigLayers([{}], { configuredDefaultHarness: "cursor" }).harness).toBe("cursor");
    // a declared harness still wins: the default is the bottom of the stack, not the top
    expect(resolveAgentConfigLayers([{ harness: "codex" }], { configuredDefaultHarness: "cursor" }).harness).toBe("codex");
    // and cursor does not inherit claude's forced permission mode
    expect(resolveAgentConfigLayers([{ permissionMode: "acceptEdits" }], { configuredDefaultHarness: "cursor" }).permissionMode).toBe("acceptEdits");
    expect(resolveAgentConfigLayers([{ harness: "claude", permissionMode: "acceptEdits" }]).permissionMode).toBe("auto");
  });
});

describe("the fallback chain", () => {
  const none = () => false;

  test("the default order is claude → codex → cursor", () => {
    expect(resolveFallbackChain()).toEqual([...DEFAULT_FALLBACK_CHAIN]);
    expect(fallbackChain({ from: "claude", exhausted: none })).toBe("codex");
  });

  test("it skips a harness whose own allowance is gone — the ticket's case", () => {
    // claude is out AND codex is out: cursor is what is left, and the run keeps going
    expect(fallbackChain({ from: "claude", tried: ["claude"], exhausted: (h) => h === "codex" })).toBe("cursor");
  });

  test("it never hands back to a harness already tried this run", () => {
    expect(fallbackChain({ from: "codex", tried: ["claude", "codex"], exhausted: none })).toBe("cursor");
    // everything spent: no hop, rather than a loop
    expect(fallbackChain({ from: "cursor", tried: ["claude", "codex", "cursor"], exhausted: none })).toBeUndefined();
  });

  test("a codex-first node falls back to claude, because the chain is an ORDER not a successor map", () => {
    expect(fallbackChain({ from: "codex", exhausted: none })).toBe("claude");
  });

  test("config.json can reorder it; unknown names are dropped rather than trusted", () => {
    expect(fallbackChain({ from: "claude", configured: ["cursor", "codex"], exhausted: none })).toBe("cursor");
    expect(resolveFallbackChain(["cursor", "nonesuch", "cursor", "claude"])).toEqual(["cursor", "claude"]);
    // a configured chain of nothing but typos falls back to the built-in order
    expect(resolveFallbackChain(["nope"])).toEqual([...DEFAULT_FALLBACK_CHAIN]);
  });
});

describe("model families", () => {
  test("a model that plainly belongs elsewhere is refused (a leaked name is an API 400)", () => {
    expect(modelFitsHarness("claude", "gpt-5")).toBe(false);
    expect(modelFitsHarness("codex", "claude-opus-5")).toBe(false);
  });

  test("cursor serves other providers' models, so a foreign name there is not a mistake", () => {
    expect(modelFitsHarness("cursor", "sonnet-4.5")).toBe(true);
    expect(modelFitsHarness("cursor", "gpt-5")).toBe(true);
    expect(modelFitsHarness("cursor", "composer-1")).toBe(true);
    expect(modelFitsHarness("cursor", "auto")).toBe(true);
  });

  test("cursor's OWN names are refused on claude and codex", () => {
    expect(modelFitsHarness("claude", "composer-1")).toBe(false);
    expect(modelFitsHarness("codex", "cheetah")).toBe(false);
  });

  test("a name no harness claims still goes through — that is how a new model works on day one", () => {
    expect(modelFitsHarness("claude", "some-unreleased-thing")).toBe(true);
    expect(modelFitsHarness("codex", "some-unreleased-thing")).toBe(true);
  });
});

/**
 * A harness name that is not in the table is REACHABLE, not hypothetical: tuning.json is
 * hand-editable and `loadTuning` blind-casts it, and the tuning PUT route accepts any
 * non-empty string until it is checked. Before the table existed these three functions all
 * degraded (`?? "claude"`, a ternary on `=== "claude"`); a table lookup that dereferences
 * `undefined` would have turned that silent degrade into a throw — a 500 from
 * `GET /api/graphs/:name` and an `executor-threw` park on every run of the graph.
 */
describe("a harness the table does not know", () => {
  const bogus = "cursor-agent" as never; // the binary, not the harness name — an easy typo

  test("resolves to the configured default instead of throwing", () => {
    expect(resolveAgentConfigLayers([{ harness: bogus }]).harness).toBe("claude");
    expect(resolveAgentConfigLayers([{ harness: bogus }], { configuredDefaultHarness: "codex" }).harness).toBe("codex");
    // and it resolves the rest of the config too, rather than dying on permissionMode
    expect(resolveAgentConfigLayers([{ harness: bogus, permissionMode: "acceptEdits" }]).permissionMode).toBe("auto");
  });

  test("leaves a model alone — this function refuses on evidence, and there is none", () => {
    expect(modelFitsHarness(bogus, "gpt-5")).toBe(true);
    expect(modelFitsHarness(bogus, "claude-opus-5")).toBe(true);
  });

  test("gets no skill hint: naming Claude Code skills to an unidentified CLI is the accident", () => {
    expect(skillsForHarness(bogus, ["review"])).toEqual([]);
    // an UNRESOLVED harness is a different thing from an unknown one and keeps the skills
    expect(skillsForHarness(undefined, ["review"])).toEqual(["review"]);
  });
});

/**
 * HOW-33: effort resolved through every layer but never reached claude — the default harness.
 * What is pinned here: a set effort is SENT (verbatim or through an explicit map) or reported
 * INERT with a reason. Never both, never neither.
 */
describe("effort per harness", () => {
  test("every harness declares its effort levels, or null for none — never left to a default", () => {
    for (const name of harnessNames()) expect(harnessSpec(name).effortLevels === null || Array.isArray(harnessSpec(name).effortLevels)).toBe(true);
    expect(harnessSpec("claude").effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(harnessSpec("cursor").effortLevels).toBeNull();
  });

  test("a level the harness accepts passes through verbatim", () => {
    expect(effortFor("claude", "high")).toEqual({ effort: "high" });
    expect(effortFor("codex", "low")).toEqual({ effort: "low" });
    expect(effortFor("claude", undefined)).toEqual({});
  });

  test("a level the harness does not take is MAPPED explicitly where a map says so", () => {
    expect(effortFor("codex", "max")).toEqual({ effort: "xhigh" });
  });

  test("a harness with no effort control, or a value outside the vocabulary, is inert and says why", () => {
    expect(effortFor("cursor", "high")).toEqual({ inert: "effort high: not supported by cursor" });
    const bogus = effortFor("claude", "ludicrous");
    expect(bogus.effort).toBeUndefined();
    expect(bogus.inert).toContain("not accepted by claude");
  });

  test("resolution re-maps effort for the harness that RESOLVED — a claude level does not leak", () => {
    expect(resolveAgentConfigLayers([{ harness: "claude", effort: "max" }])).toMatchObject({ harness: "claude", effort: "max" });
    // the fallback layer sits on top: the same node's `max` becomes codex's `xhigh`
    expect(resolveAgentConfigLayers([{ harness: "codex" }, { harness: "claude", effort: "max" }])).toMatchObject({ harness: "codex", effort: "xhigh" });
    const cursor = resolveAgentConfigLayers([{ harness: "cursor" }, { effort: "high" }]);
    expect(cursor.effort).toBeUndefined();
    expect(cursor.effortInert).toBe("effort high: not supported by cursor");
    expect(resolveAgentConfigLayers([{ effort: "high" }]).effortInert).toBeUndefined();
  });
});
