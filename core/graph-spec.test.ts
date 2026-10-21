/**
 * The spec model (HOW-22). Two things are being pinned here.
 *
 * The COMPILER: a spec becomes the same Graph a hand-written defineGraph would — same
 * condition labels, same fallback semantics, same scopes — because a built graph that read
 * differently in the DAG and the event log would be a second dialect to learn.
 *
 * The TRANSLATOR: specProblems() is the only thing standing between an operator and
 * `validate()`'s vocabulary, so every message it produces has to name the STEP that owns the
 * problem and say what to do about it. A problem that reaches the screen as
 * `node "x" reads "y" but no writer covers every path` is the ticket's failure mode.
 */
import { describe, expect, test } from "bun:test";
import { templateReads } from "./template-refs";
import {
  COMMAND_BUILTINS, SPEC_VERSION, WORKTREE_FACTS, WORKTREE_CREATE_FACTS,
  buildGraph, checkGraphDraft, draftHashOf, draftRuleProblems, resolveDraftBodies, builtinReads, coerceOperand, compilePredicate, emittableWrites, missingBuiltinReads, parseGraphSpec, predicateLabel, renameDraft,
  isBlocking, keepPath, recoercePredicate, specAdvice, specProblems, unmatchableOperand,
  type GraphSpec, type NodeSpec, type Predicate,
} from "./graph-spec";
import { shapeOf } from "../graphs/spec-shape";
import { CATALOG, EDGE_CASES, borrowedPrompt, cleanDraft, materialiseFake, renamed } from "./fixtures/graph-draft";

/** the smallest legal graph: one agent, one terminal */
function minimal(over: Partial<GraphSpec> = {}): GraphSpec {
  return {
    version: 1,
    name: "my-review",
    description: "a built graph",
    fields: [
      { key: "goal", kind: "text", scope: "sticky" },
      { key: "summary", kind: "text", scope: "sticky" },
    ],
    inputs: ["goal"],
    entry: "draft",
    nodes: [
      { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "done" }],
    ...over,
  };
}

describe("buildGraph — a spec is a real Graph", () => {
  test("it validates, and the spec comes back out for an exact round trip", () => {
    const spec = minimal();
    const g = buildGraph(spec);
    expect(g.validate()).toEqual({ structural: [], paths: [] });
    expect(g.def.spec).toEqual(spec);
    expect(g.def.entry).toBe("draft");
    expect(g.def.inputs).toEqual(["goal"]);
  });

  test("scope comes from the FIELD, so two writers can never disagree", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "cleared" },
      ],
      nodes: [
        { id: "draft", kind: "agent", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "redraft", kind: "agent", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "redraft" }, { from: "redraft", to: "done" }],
    });
    const g = buildGraph(spec);
    expect(g.declarations()["summary"]).toEqual({ scope: "cleared", writer: ["draft", "redraft"] });
  });

  test("weight is row order: the first conditional row leaving a step wins", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
        { key: "review_verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
      ],
      nodes: [
        { id: "draft", kind: "agent", prompt: "my-review.draft", reads: ["goal"], writes: ["summary", "review_verdict"] },
        { id: "revise", kind: "agent", prompt: "my-review.draft", reads: ["goal"], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [
        { from: "draft", to: "revise", when: { op: "equals", key: "review_verdict", value: "reject" } },
        { from: "draft", to: "done", when: { op: "equals", key: "review_verdict", value: "pass" } },
        { from: "revise", to: "done" },
      ],
    });
    const edges = buildGraph(spec).def.edges;
    expect(edges[0]!.weight).toBe(2);
    expect(edges[1]!.weight).toBe(1);
    // the unconditional edge keeps no weight at all: it IS the weight-0 fallback
    expect(edges[2]!.weight).toBeUndefined();
    expect(edges[2]!.condition).toBeUndefined();
  });
});

describe("predicates read like the hand-written graphs do", () => {
  const cases: Array<[Predicate, string, Array<[unknown, boolean]>]> = [
    [{ op: "equals", key: "review_verdict", value: "reject" }, "review_verdict == 'reject'", [["reject", true], ["pass", false]]],
    [{ op: "not-equals", key: "review_verdict", value: "pass" }, "review_verdict != 'pass'", [["reject", true], ["pass", false]]],
    [{ op: "one-of", key: "pr.state", values: ["MERGED", "CLOSED"] }, "pr.state in ['MERGED', 'CLOSED']", [["CLOSED", true], ["OPEN", false]]],
    [{ op: "is-true", key: "worktree.clean" }, "worktree.clean == true", [[true, true], [false, false], ["yes", false]]],
    [{ op: "is-false", key: "worktree.clean" }, "worktree.clean == false", [[false, true], [true, false]]],
    [{ op: "is-empty", key: "notes" }, "notes is empty", [["", true], [[], true], [{}, true], [0, false], ["x", false]]],
    [{ op: "is-not-empty", key: "notes" }, "notes is set", [["x", true], ["", false], [undefined, false]]],
    [{ op: "equals", key: "slice.approval", path: "outcome", value: "approved" }, "slice.approval.outcome == 'approved'",
      [[{ outcome: "approved" }, true], [{ outcome: "feedback" }, false], ["approved", false], [null, false]]],
  ];
  for (const [p, label, checks] of cases) {
    test(label, () => {
      expect(predicateLabel(p)).toBe(label);
      const c = compilePredicate(p);
      expect(c.reads).toEqual([p.key]);
      for (const [value, want] of checks) expect(c.test({ [p.key]: value } as any)).toBe(want);
    });
  }
});

describe("specProblems speaks to the operator, not to the validator", () => {
  test("a clean draft has nothing to say", () => {
    expect(specProblems(minimal())).toEqual([]);
  });

  test("a missing writer names the STEP and what to do, not the node/key/witness form", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal", "summary"], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node).toBe("draft");
    expect(problems[0]!.message).toContain("**Draft the doc** is given `summary`");
    expect(problems[0]!.message).toContain("ask for it at launch");
    expect(problems[0]!.message).not.toContain("no writer covers every path");
  });

  test("a dead end is attributed to the step that dead-ends", () => {
    const spec = minimal({ edges: [] });
    const problems = specProblems(spec);
    expect(problems.map((p) => p.node)).toContain("draft");
    expect(problems.find((p) => p.node === "draft")!.message).toContain("nowhere to go next");
  });

  test("two Otherwise rows on one step is one message about that step", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "other", kind: "terminal", outcome: "failed" },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "done" }, { from: "draft", to: "other" }],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node).toBe("draft");
    expect(problems[0]!.message).toContain('more than one "Otherwise"');
  });

  test("a branch reading a key nothing writes is attributed to the step it leaves", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
        { key: "verdict", kind: "choice", scope: "cleared", choices: ["pass"] },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
        { id: "stop", kind: "terminal", outcome: "failed" },
      ],
      edges: [
        { from: "draft", to: "done", when: { op: "equals", key: "verdict", value: "pass" } },
        { from: "draft", to: "stop" },
      ],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node).toBe("draft");
    expect(problems[0]!.message).toContain("The branch leaving **Draft the doc** is given `verdict`");
  });

  test("a key no field declares is caught before validate() ever runs", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft", prompt: "my-review.draft", reads: ["goal"], writes: ["mystery"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
    });
    expect(specProblems(spec)[0]!.message).toContain("`mystery`, which is not a field");
  });

  test("a dangling edge target does not throw its way out of the builder", () => {
    const spec = minimal({ edges: [{ from: "draft", to: "ghost" }] });
    const problems = specProblems(spec);
    expect(problems[0]!.message).toContain('("ghost")');
    expect(problems[0]!.node).toBe("draft");
  });

  test("a wait step with an unparseable duration says what one looks like", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "hold", kind: "wait", title: "Cool off", duration: "a while" },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "hold" }, { from: "hold", to: "done" }],
    });
    expect(specProblems(spec)[0]!.message).toContain('duration like "30 s"');
  });

  test("a prompt with no file yet is a problem when the known set is supplied", () => {
    expect(specProblems(minimal(), { knownPrompts: [] })[0]!.message).toContain("has no file yet");
    expect(specProblems(minimal(), { knownPrompts: ["my-review.draft"] })).toEqual([]);
  });
});

/**
 * HOW-22 review, finding 1 and the reachability clause the review pane already promises. A
 * graph the builder calls "Ready to save" has to be a graph that can DO something: a runnable
 * starting step, and no step the run can never arrive at. Both were outside the verdict — a
 * Finish-step entry and a stranded step each reported zero problems.
 */
describe("a graph called ready-to-save must be one that can actually run", () => {
  const flag = (over: Partial<GraphSpec> = {}) => minimal(over);

  test("a Finish step as the starting step is refused in the operator's words, in Basics", () => {
    const spec = flag({
      entry: "done",
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", title: "All done", outcome: "success" },
      ],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.where).toBe("basics");
    expect(problems[0]!.message).toContain("is a Finish step");
    // by TITLE — the ids are run identity and are not what an operator named
    expect(problems[0]!.message).toContain("**All done**");
    expect(problems[0]!.message).not.toContain("entry node");
    // and the real gate agrees, which is what covers a hand-edited module
    expect(buildGraph(spec).validate().structural).toEqual(['entry node "done" is a terminal']);
  });

  test("a terminal entry reports ONE problem, not one per consequence", () => {
    // without the ordering, EVERY step is unreachable from a Finish entry and the one thing to
    // fix — a single picker in Basics — is buried under N sentences about other steps
    const spec = flag({
      entry: "done",
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "extra", kind: "command", title: "Check", run: "true", reads: [], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "extra" }, { from: "extra", to: "done" }],
    });
    expect(specProblems(spec).map((p) => p.where)).toEqual(["basics"]);
  });

  test("an entry naming no step at all still says so", () => {
    const problems = specProblems(flag({ entry: "nobody" }));
    expect(problems[0]!.where).toBe("basics");
    expect(problems[0]!.message).toContain("not in the graph");
  });

  test("a step nothing goes to is dead work, and is reported in Branching", () => {
    const spec = flag({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "stranded", kind: "command", title: "Nobody calls me", run: "true", reads: [], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "done" }, { from: "stranded", to: "done" }],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "stranded", where: "branching" });
    expect(problems[0]!.message).toContain("**Nobody calls me** is never reached");
  });

  test("reachability never buries a cause: no edges at all reads as a dead end", () => {
    // both are true of `edges: []` — the entry dead-ends and the Finish is unreachable — and
    // the dead end is the one to fix, so it is the one reported
    const problems = specProblems(flag({ edges: [] }));
    expect(problems.every((p) => !p.message.includes("never reached"))).toBe(true);
    expect(problems.some((p) => p.message.includes("nowhere to go next"))).toBe(true);
  });
});

/**
 * HOW-22 review, finding 3: a row the form seeded that no runtime value can satisfy. The rule
 * lives on the SPEC rather than in the form because a spec also arrives by PUT and by
 * re-opening a hand-edited module — and it was the form's creation path forgetting the rule
 * (which already existed for the kind-change path) that produced the defect.
 */
describe("a condition row that can never fire is refused, not saved", () => {
  const kinds: GraphSpec["fields"] = [
    { key: "flag", kind: "boolean", scope: "sticky" },
    { key: "count", kind: "number", scope: "sticky" },
    { key: "verdict", kind: "choice", scope: "sticky", choices: ["pass", "reject"] },
    { key: "note", kind: "text", scope: "sticky" },
    { key: "blob", kind: "json", scope: "sticky" },
  ];
  /** one agent that writes every field, so only the BRANCH can be at fault */
  const branching = (when: Predicate): GraphSpec => minimal({
    fields: [{ key: "goal", kind: "text", scope: "sticky" }, ...kinds],
    nodes: [
      { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: kinds.map((f) => f.key) },
      { id: "again", kind: "command", title: "Try again", run: "true", reads: [], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "again", when }, { from: "draft", to: "done" }, { from: "again", to: "done" }],
  });
  const only = (when: Predicate) => {
    const problems = specProblems(branching(when));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "draft", where: "branching" });
    return problems[0]!.message;
  };
  /** what is REFUSED, which is the subject of this describe. A row that saves clean may still
   *  be ADVISED against (HOW-26 — `note == 'anything'` on a text field is the example below),
   *  and advice is not a refusal: graphs/builder.ts writes the file over it. */
  const refused = (when: Predicate) => specProblems(branching(when)).filter(isBlocking);

  test("an operand left empty compares against nothing, whatever the field's kind", () => {
    for (const f of kinds) {
      const msg = only({ op: "equals", key: f.key, value: "" });
      expect(msg, f.kind).toContain(`compares \`${f.key}\` with nothing`);
      expect(msg, f.kind).toContain("**Draft the doc**");
    }
  });

  test("text against a yes/no field can never match, and says why", () => {
    expect(only({ op: "equals", key: "flag", value: "reject" })).toContain("is a yes/no field");
    expect(only({ op: "not-equals", key: "flag", value: "true" })).toContain("is a yes/no field");
  });

  test("a number field compared with text is the classic silent never-match", () => {
    expect(only({ op: "equals", key: "count", value: "3" })).toContain("is a number field");
  });

  test("`is one of` with nothing to match is refused, and one bad value is enough", () => {
    expect(only({ op: "one-of", key: "verdict", values: [] })).toContain("has no values to match");
    expect(only({ op: "one-of", key: "count", values: [1, "2"] })).toContain("is a number field");
  });

  test("what is deliberately NOT refused, because it can legitimately match at run time", () => {
    // a path reaches INTO a value, so the field's kind describes the container, not the operand
    expect(refused({ op: "equals", key: "blob", path: "outcome", value: "reject" })).toEqual([]);
    // ...but only on a field that CAN hold one. This asserted clean until HOW-22 review finding
    // 3: a path on a yes/no field is invisible (the inner-name box renders for json only) and
    // fatal (the row can never fire), so the empty operand beside it went unreported too.
    expect(only({ op: "equals", key: "flag", path: "inner", value: "" })).toContain("is not a structured (JSON) field");
    // HOW-60 (H3): a choice outside its declared choices used to be listed here. It is refused
    // now — see the describe below — and only `one-of` keeps the old leniency
    expect(refused({ op: "one-of", key: "verdict", values: ["pass", "unlisted"] })).toEqual([]);
    // free text compared with a whole word IS advised against — it is the row that never fired
    // in HOW-26 — but it is still not refused, because a command can legitimately write it
    expect(refused({ op: "equals", key: "note", value: "anything" })).toEqual([]);
    expect(refused({ op: "one-of", key: "count", values: [1, 2] })).toEqual([]);
    // every nullary op on every kind: they compare against nothing, so there is nothing to type
    for (const op of ["is-true", "is-false", "is-empty", "is-not-empty"] as const)
      for (const f of kinds)
        expect(refused({ op, key: f.key }), `${op}/${f.kind}`).toEqual([]);
  });

  test("unmatchableOperand is the rule, and coerceOperand is the same rule forwards", () => {
    const flag = kinds[0]!;
    const count = kinds[1]!;
    // what the form now seeds is what the rule accepts — that ⟺ is the correction
    expect(unmatchableOperand({ op: "equals", key: "flag", value: coerceOperand("", flag.kind) }, flag)).toBeNull();
    expect(unmatchableOperand({ op: "equals", key: "count", value: coerceOperand("", count.kind) }, count)).toBeNull();
    // and an unknown field is not this rule's business — "not a field" is reported first
    expect(unmatchableOperand({ op: "equals", key: "nope", value: "x" }, undefined)).toBeNull();
  });
});

describe("emittableWrites is the executors' own answer, not the form's", () => {
  const worktree = (action: "create" | "remove"): NodeSpec => ({ id: "w", kind: "worktree", action, writes: [] });

  test("making a worktree publishes only the verify command; cleaning one up publishes exactly two facts", () => {
    // engine/executors/worktree.ts publishes worktree.verify_command on both create paths (the
    // fresh one and the idempotent re-visit) when declared (HOW-44), and fills only the
    // declared subset of WORKTREE_FACTS on remove. graphs/builder.test.ts checks this table
    // still matches that file.
    expect(emittableWrites(worktree("create"))).toEqual(WORKTREE_CREATE_FACTS);
    expect(emittableWrites(worktree("remove"))).toEqual(WORKTREE_FACTS);
  });

  test("a built-in command publishes its own list; a shell script is unconstrained", () => {
    for (const b of COMMAND_BUILTINS)
      expect(emittableWrites({ id: "c", kind: "command", run: b.run, reads: [], writes: [] }), b.run).toEqual(b.produces);
    // arguments do not change which built-in it is
    expect(emittableWrites({ id: "c", kind: "command", run: "map:drift --since abc123", reads: [], writes: [] })).toEqual(["slice.drift"]);
    // and a script's facts are decided by its last line of output, at run time
    expect(emittableWrites({ id: "c", kind: "command", run: "./ci.sh", reads: [], writes: [] })).toBeUndefined();
  });

  test("an agent is unconstrained — the outputs contract asks for whatever it declares", () => {
    expect(emittableWrites({ id: "a", kind: "agent", prompt: "x.a", reads: [], writes: ["anything"] })).toBeUndefined();
  });

  // HOW-23 review, finding 2: the fan-out built-in was dispatched by the command executor but
  // was never in the table, so the browser had no answer for it at all — nothing to offer in
  // the picker, and nothing to refuse with when a step declared what it cannot publish.
  test("the fan-out built-in publishes exactly one fact", () => {
    expect(emittableWrites({ id: "c", kind: "command", run: "runs:launch", reads: [], writes: [] })).toEqual(["launched"]);
  });
});

describe("builtinReads — the other half of a built-in's contract", () => {
  const launch = (reads: string[]): NodeSpec => ({ id: "c", kind: "command", run: "runs:launch", reads, writes: [] });

  test("runs:launch works from the plan and its tickets, by name", () => {
    expect(builtinReads(launch([]))).toEqual(["plan.slices", "tickets"]);
    expect(missingBuiltinReads(launch([]))).toEqual(["plan.slices", "tickets"]);
    expect(missingBuiltinReads(launch(["tickets"]))).toEqual(["plan.slices"]);
  });

  test("an EXTRA read stays legal — engine/executors/launch.ts only checks inclusion", () => {
    expect(missingBuiltinReads(launch(["plan.slices", "tickets", "goal"]))).toEqual([]);
  });

  // HOW-57: runs:await and git:restack read other runs and this run's stack BY NAME, like launch
  test("runs:await and git:restack name their reads too", () => {
    expect(builtinReads({ id: "c", kind: "command", run: "runs:await", reads: [], writes: [] })).toEqual(["deps"]);
    expect(builtinReads({ id: "c", kind: "command", run: "git:restack", reads: [], writes: [] })).toEqual(["deps.base", "deps.base_merged", "pr.approved"]);
  });

  test("every other built-in works from its cwd, so its reads are the operator's own business", () => {
    for (const b of COMMAND_BUILTINS.filter((x) => !["runs:launch", "runs:await", "git:restack"].includes(x.run)))
      expect(builtinReads({ id: "c", kind: "command", run: b.run, reads: [], writes: [] }), b.run).toBeUndefined();
    expect(builtinReads({ id: "c", kind: "command", run: "./ci.sh", reads: [], writes: [] })).toBeUndefined();
    expect(builtinReads({ id: "a", kind: "agent", prompt: "x.a", reads: [], writes: [] })).toBeUndefined();
  });
});

describe("specProblems refuses a declaration the executor could never publish", () => {
  test("a worktree step switched to MAKE is told its produced key is undeliverable", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
        { key: "worktree.clean", kind: "boolean", scope: "per-visit" },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "clean", kind: "worktree", title: "Clean up", action: "create", writes: ["worktree.clean"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "clean" }, { from: "clean", to: "done" }],
    });
    const problem = specProblems(spec).find((p) => p.node === "clean")!;
    expect(problem.where).toBe("steps");
    expect(problem.message).toContain("**Clean up** says it produces `worktree.clean`");
    expect(problem.message).toContain("making a worktree reports nothing");
  });

  test("a built-in command is told which facts it actually reports", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: [] },
        { id: "check", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "check" }, { from: "check", to: "done" }],
    });
    const problem = specProblems(spec).find((p) => p.node === "check")!;
    expect(problem.where).toBe("steps");
    expect(problem.message).toContain("**Check the PR** says it produces `summary`");
    expect(problem.message).toContain("`probe:pr` only reports `pr.state`");
  });

  test("the fan-out built-in is told the same way, and told what it is missing", () => {
    const spec = (reads: string[], writes: string[]): GraphSpec => minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "plan.slices", kind: "json", scope: "sticky" },
        { key: "tickets", kind: "json", scope: "sticky" },
        { key: "launched", kind: "json", scope: "sticky" },
        { key: "pr.state", kind: "choice", scope: "per-visit", choices: ["MERGED"] },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the plan", prompt: "my-review.draft", reads: ["goal"], writes: ["plan.slices", "tickets"] },
        { id: "fan-out", kind: "command", title: "Fan it out", run: "runs:launch", reads, writes },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "fan-out" }, { from: "fan-out", to: "done" }],
    });

    const undeliverable = specProblems(spec(["plan.slices", "tickets"], ["pr.state"])).find((p) => p.message.includes("produces"))!;
    expect(undeliverable.node).toBe("fan-out");
    expect(undeliverable.message).toContain("**Fan it out** says it produces `pr.state`");
    expect(undeliverable.message).toContain("`runs:launch` only reports `launched`");

    // the other half: the step is wired to nothing, which the EXECUTOR refuses at run time
    const unwired = specProblems(spec([], ["launched"])).find((p) => p.message.includes("works from"))!;
    expect(unwired.node).toBe("fan-out");
    expect(unwired.where).toBe("steps");
    expect(unwired.message).toContain("**Fan it out** works from `plan.slices` and `tickets`, but this step does not use them");

    // …and a step that is wired up, plus a key of its own, is not refused at all
    expect(specProblems(spec(["plan.slices", "tickets", "goal"], ["launched"]))).toEqual([]);
  });

  // HOW-12: the tests built-in publishes ONE verdict, and the builder says so before a save
  test("the verify built-in is told it only reports `verify.result`, and a step declaring just that saves", () => {
    const spec = (writes: string[]): GraphSpec => minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
        { key: "verify.result", kind: "json", scope: "per-visit" },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the change", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "tests", kind: "command", title: "Run the tests", run: "verify:run", reads: [], writes },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "tests" }, { from: "tests", to: "done" }],
    });
    expect(emittableWrites({ id: "c", kind: "command", run: "verify:run", reads: [], writes: [] })).toEqual(["verify.result"]);
    const problem = specProblems(spec(["verify.result", "summary"])).find((p) => p.node === "tests")!;
    expect(problem.message).toContain("**Run the tests** says it produces `summary`");
    expect(problem.message).toContain("`verify:run` only reports `verify.result`");
    expect(specProblems(spec(["verify.result"])).filter((p) => p.node === "tests" && isBlocking(p))).toEqual([]);
  });

  test("a shell script's produced facts are NOT second-guessed — only run time knows", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft", prompt: "my-review.draft", reads: ["goal"], writes: [] },
        { id: "run", kind: "command", title: "Run it", run: "./ci.sh", reads: [], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "run" }, { from: "run", to: "done" }],
    });
    expect(specProblems(spec)).toEqual([]);
  });
});

describe("an agent's instructions and its reads are one statement, not two", () => {
  test("a body still asking for a removed field is a STEPS problem naming both", () => {
    // the reducer does not edit an agent's reads, because they ARE the instructions: this is
    // what the operator sees instead of graphs/builder.ts's "writer-free path" refusal
    const spec = minimal({
      fields: [{ key: "summary", kind: "text", scope: "sticky" }],
      inputs: [],
    });
    const problems = specProblems(spec);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node).toBe("draft");
    expect(problems[0]!.where).toBe("steps");
    expect(problems[0]!.message).toContain("**Draft the doc** still asks for `goal` in its instructions");
    expect(problems[0]!.message).toContain("add the field back");
  });

  test("a non-agent step's undeclared key is still the fields pane's — it is a tick-box", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "run", kind: "command", title: "Run it", run: "./ci.sh", reads: ["mystery"], writes: [] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "run" }, { from: "run", to: "done" }],
    });
    const problem = specProblems(spec).find((p) => p.message.includes("mystery"))!;
    expect(problem.where).toBe("fields");
  });
});

describe("a field's kind owns the operands that compare against it", () => {
  test("coerceOperand types the value the way the field says", () => {
    expect(coerceOperand("3", "number")).toBe(3);
    expect(coerceOperand("", "number")).toBe(0);
    // NaN would serialise to `null` and make the spec unparseable, so it never happens
    expect(coerceOperand("reject", "number")).toBe(0);
    expect(coerceOperand("true", "boolean")).toBe(true);
    expect(coerceOperand("reject", "boolean")).toBe(false);
    expect(coerceOperand("reject", "text")).toBe("reject");
    expect(coerceOperand("reject", undefined)).toBe("reject");
  });

  test("recoercePredicate re-types every operand-carrying op and leaves the nullary ones", () => {
    expect(recoercePredicate({ op: "equals", key: "v", value: "reject" }, "boolean")).toEqual({ op: "equals", key: "v", value: false });
    expect(recoercePredicate({ op: "not-equals", key: "v", value: "3" }, "number")).toEqual({ op: "not-equals", key: "v", value: 3 });
    expect(recoercePredicate({ op: "one-of", key: "v", values: ["1", "2"] }, "number")).toEqual({ op: "one-of", key: "v", values: [1, 2] });
    const nullary: Predicate = { op: "is-true", key: "v" };
    expect(recoercePredicate(nullary, "number")).toEqual(nullary);
  });

  test("a path survives only a kind that can carry one, and the operand is re-typed either way", () => {
    // json keeps it: the kind describes the CONTAINER and the value at the path is untyped
    expect(recoercePredicate({ op: "equals", key: "v", path: "outcome", value: "true" }, "json"))
      .toEqual({ op: "equals", key: "v", path: "outcome", value: "true" });
    // anything else drops it. This used to be KEPT, which is how a re-pointed row saved clean
    // and never fired (HOW-22 review, finding 3) — the operand is still re-typed.
    expect(recoercePredicate({ op: "equals", key: "v", path: "outcome", value: "true" }, "boolean"))
      .toEqual({ op: "equals", key: "v", value: true });
    // a nullary op carries no operand and can still carry a stale path
    expect(recoercePredicate({ op: "is-true", key: "v", path: "outcome" }, "text")).toEqual({ op: "is-true", key: "v" });
    expect(keepPath("outcome", "json")).toBe("outcome");
    for (const k of ["text", "number", "boolean", "choice", undefined] as const)
      expect(keepPath("outcome", k)).toBeUndefined();
    expect(keepPath(undefined, "json")).toBeUndefined();
  });
});

describe("reviewsWorkOf: a review of repairs judges only their diff", () => {
  const scoped = (reviews: string[]) => minimal({
    nodes: [
      { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
      { id: "check", kind: "agent", prompt: "my-review.check", reads: ["goal", "summary"], writes: [], readOnly: true, reviewsWorkOf: reviews },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "check" }, { from: "check", to: "done" }],
  });

  test("round-trips through parse and compiles onto the node, in order", () => {
    const spec = scoped(["draft"]);
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.nodes[1]).toMatchObject({ reviewsWorkOf: ["draft"] });
    expect(buildGraph(spec).def.nodes.check).toMatchObject({ reviewsWorkOf: ["draft"] });
    expect(specProblems(spec)).toEqual([]);
    // absent and empty are the same: neither is carried
    const bare = parseGraphSpec(JSON.parse(JSON.stringify(scoped([]))));
    if (bare.ok) expect("reviewsWorkOf" in bare.spec.nodes[1]!).toBe(false);
    expect("reviewsWorkOf" in buildGraph(scoped([])).def.nodes.check!).toBe(false);
  });

  test("naming a step that is not an agent step is refused, in the operator's words, and by the compiled graph too", () => {
    const problems = specProblems(scoped(["done", "ghost"]));
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('reviews the work of "done", which is not an agent step'),
      expect.stringContaining('reviews the work of "ghost", which is not an agent step'),
    ]);
    expect(problems.every((p) => p.node === "check" && p.where === "steps")).toBe(true);
    expect(buildGraph(scoped(["ghost"])).validate().structural).toContain('node "check" reviews the work of "ghost", which is not an agent node');
  });
});

describe("parseGraphSpec refuses what it cannot vouch for", () => {
  test("a good spec survives untouched", () => {
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(minimal())));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec).toEqual(minimal());
  });

  test("unknown keys are dropped rather than carried onto disk", () => {
    const parsed = parseGraphSpec({ ...minimal(), evil: "rm -rf", nodes: [{ id: "done", kind: "terminal", outcome: "success", evil: 1 }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("evil" in parsed.spec).toBe(false);
      expect("evil" in parsed.spec.nodes[0]!).toBe(false);
    }
  });

  test("a wrong version, a bad name and a malformed step are each refused by name", () => {
    expect(parseGraphSpec({ ...minimal(), version: 2 })).toEqual({ ok: false, error: expect.stringContaining("unsupported spec version") } as any);
    expect(parseGraphSpec({ ...minimal(), name: "../escape" })).toEqual({ ok: false, error: expect.stringContaining("kebab-case") } as any);
    const bad = parseGraphSpec({ ...minimal(), nodes: [{ id: "x", kind: "agent", prompt: "../../etc/passwd" }] });
    expect(bad.ok).toBe(false);
  });

  test("an unknown harness in a config is dropped, not written into the file", () => {
    const parsed = parseGraphSpec({ ...minimal(), defaults: { harness: "sudo", model: "claude-opus-5" } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.defaults).toEqual({ model: "claude-opus-5" });
  });
});

/** HOW-57: a worktree create may read the stack base it starts from. */
describe("a worktree step's reads (HOW-57)", () => {
  const withWorktree = (reads?: string[]): GraphSpec => ({
    ...minimal({
      fields: [...minimal().fields, { key: "deps.base", kind: "text", scope: "sticky" }],
      entry: "wt",
    }),
    nodes: [{ id: "wt", kind: "worktree", action: "create", writes: [], ...(reads ? { reads } : {}) }, ...minimal().nodes],
    edges: [{ from: "wt", to: "draft" }, ...minimal().edges],
  });

  test("reads round-trip through parseGraphSpec and compile onto the node", () => {
    const spec = withWorktree(["deps.base"]);
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec).toEqual(spec);
    expect(buildGraph(spec).def.nodes.wt).toEqual({ kind: "worktree", action: "create", reads: ["deps.base"], writes: {} });
  });

  test("absent reads compile to NO reads key — every existing graph is unchanged", () => {
    expect("reads" in buildGraph(withWorktree()).def.nodes.wt!).toBe(false);
    expect("reads" in buildGraph(withWorktree([])).def.nodes.wt!).toBe(false);
  });

  test("a read with no writer is still refused, like any other read", () => {
    expect(buildGraph(withWorktree(["deps.base"])).validate().paths).toEqual([{ node: "wt", key: "deps.base", witness: ["wt"] }]);
  });
});

/** HOW-57 (G5): a wait step's back-off. */
describe("a wait step's back-off (HOW-57)", () => {
  const withWait = (backoff?: string[]): GraphSpec => ({
    ...minimal({ entry: "nap" }),
    nodes: [{ id: "nap", kind: "wait", duration: "5m", ...(backoff ? { backoff } : {}) }, ...minimal().nodes],
    edges: [{ from: "nap", to: "draft" }, ...minimal().edges],
  });

  test("it round-trips through parseGraphSpec and compiles onto the node", () => {
    const spec = withWait(["15m", "30m"]);
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.ok && parsed.spec).toEqual(spec);
    expect(buildGraph(spec).def.nodes.nap).toEqual({ kind: "wait", duration: "5m", backoff: ["15m", "30m"] });
    expect("backoff" in buildGraph(withWait()).def.nodes.nap!).toBe(false);
  });

  test("an entry that is not a duration is a problem on that step", () => {
    const problems = specProblems(withWait(["15m", "later"]));
    expect(problems.map((p) => [p.node, p.message])).toContainEqual(["nap", expect.stringContaining("back-off that is not a list of durations")]);
  });
});

/**
 * HOW-24. A canvas whose steps spring back to an auto-layout on reload is not a canvas, so the
 * arrangement is part of the artifact. It has to be two things at once: carried faithfully by
 * the spec, and invisible to everything below it.
 */
describe("a step's place on the canvas is the spec's, and the engine's business never", () => {
  const placed = (): GraphSpec => ({
    ...minimal(),
    nodes: minimal().nodes.map((n, i) => ({ ...n, position: { x: 40 + i * 10, y: 100 * i } })),
  });

  test("a position survives parseGraphSpec, on every node kind including a Finish step", () => {
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(placed())));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.nodes.map((n) => n.position)).toEqual([{ x: 40, y: 0 }, { x: 50, y: 100 }]);
  });

  test("a position that could not round-trip through JSON is dropped, never carried", () => {
    // NaN and Infinity serialise to `null`, and the spec is embedded in a module with
    // JSON.stringify — the same rule coerceOperand applies to a number operand
    for (const bad of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: "40", y: 0 }, { x: 0 }, null, "40,0"]) {
      const parsed = parseGraphSpec({ ...minimal(), nodes: [{ ...minimal().nodes[1]!, position: bad }] });
      expect(parsed.ok, JSON.stringify(bad)).toBe(true);
      if (parsed.ok) expect(parsed.spec.nodes[0]!.position, JSON.stringify(bad)).toBeUndefined();
    }
  });

  test("a position is NOT compiled into the graph — the engine sees the identical Graph", () => {
    // `def.spec` is the round trip and legitimately differs; everything the ENGINE reads must
    // not, which is the whole claim
    const { spec: _placed, ...withPositions } = buildGraph(placed()).def;
    const { spec: _plain, ...without } = buildGraph(minimal()).def;
    expect(withPositions).toEqual(without);
    for (const n of Object.values(buildGraph(placed()).def.nodes)) expect("position" in n).toBe(false);
  });

  test("...and it is not a problem to report either: layout is not a verdict", () => {
    expect(specProblems(placed())).toEqual([]);
  });
});

/**
 * HOW-22 review, findings 1, 3 and 4 — the three things the ONE verdict could not yet see. All
 * three are proven on the SPEC rather than in the form, because a spec also arrives by PUT and
 * by re-opening a hand-edited module, and a form fix only fixes the form.
 */
describe("the verdict sees a half-built draft, a stale path and a borrowed prompt", () => {
  const only = (spec: GraphSpec, where: string) => {
    const problems = specProblems(spec);
    expect(problems.map((p) => p.message)).toHaveLength(1);
    expect(problems[0]!.where).toBe(where as never);
    return problems[0]!;
  };

  test('a "go to" with no step picked says THAT, not that the step was removed', () => {
    const p = only(minimal({ edges: [{ from: "draft", to: "" }] }), "branching");
    expect(p.node).toBe("draft");
    expect(p.message).toBe('**Draft the doc** has a "go to" with no step picked. Choose where it goes, or remove the row.');
  });

  test("a target that was REMOVED still gets its own, different sentence", () => {
    // the split must not swallow the case it was split out of
    expect(only(minimal({ edges: [{ from: "draft", to: "gone" }] }), "branching").message)
      .toContain('points at a step that no longer exists ("gone")');
  });

  test("a path on a field that cannot hold one is refused, naming the field and the path", () => {
    for (const kind of ["text", "number", "boolean", "choice"] as const) {
      const spec = minimal({
        fields: [{ key: "goal", kind: "text", scope: "sticky" }, { key: "verdict", kind, scope: "sticky", ...(kind === "choice" ? { choices: ["a"] } : {}) }],
        nodes: [
          { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["verdict"] },
          { id: "done", kind: "terminal", outcome: "success" },
        ],
        edges: [{ from: "draft", to: "done", when: { op: "equals", key: "verdict", path: "outcome", value: "reject" } }],
      });
      const p = only(spec, "branching");
      expect(p.message, kind).toContain("reaches inside `verdict` for `outcome`");
      expect(p.message, kind).toContain("is not a structured (JSON) field");
    }
  });

  test("...and a path on a json field is still clean, which is what stops the rule overreaching", () => {
    const spec = minimal({
      fields: [{ key: "goal", kind: "text", scope: "sticky" }, { key: "verdict", kind: "json", scope: "sticky" }],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["verdict"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "done", when: { op: "equals", key: "verdict", path: "outcome", value: "reject" } }],
    });
    expect(specProblems(spec)).toEqual([]);
  });

  test("unmatchableOperand invents nothing about a field it cannot see", () => {
    // the caller already reports an unknown key; a public export must not add a second verdict
    expect(unmatchableOperand({ op: "equals", key: "v", path: "outcome", value: "x" }, undefined)).toBeNull();
  });

  test("a step filed under ANOTHER graph's prompt is refused, naming the step and the id", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "victim.work", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
    });
    const p = only(spec, "steps");
    expect(p.node).toBe("draft");
    expect(p.message).toContain('filed under "victim.work", which belongs to another graph');
    expect(p.message).toContain("`my-review.<step>`");
  });

  test("...but two steps of ONE graph may share a body, which is already how remove-step works", () => {
    const spec = minimal({
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "redraft", kind: "agent", title: "Draft it again", prompt: "my-review.draft", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [{ from: "draft", to: "redraft" }, { from: "redraft", to: "done" }],
    });
    expect(specProblems(spec)).toEqual([]);
  });

  test("an UNNAMED draft reports its name and nothing else — the restraint the id check keeps", () => {
    const spec = minimal({
      name: "",
      nodes: [
        { id: "draft", kind: "agent", title: "Draft the doc", prompt: "victim.work", reads: ["goal"], writes: ["summary"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
    });
    const problems = specProblems(spec);
    expect(problems.filter((p) => p.message.includes("belongs to another graph"))).toEqual([]);
    expect(problems.some((p) => p.where === "basics")).toBe(true);
  });
});

/**
 * HOW-26: the five things the builder shipped that nothing could see.
 *
 * The fixture is the ticket's OWN graph, trimmed to the parts that carry each defect, because
 * the point of the ticket is that this file validated clean and said "Ready to save". Every
 * rule here is `advice`: it describes a graph that loads, validates and runs and is still not
 * the graph that was meant, so it is counted and printed and never refused.
 */
describe("advice: a graph that will run, and still not do what was meant (HOW-26)", () => {
  /** the ticket's graph, in the vocabulary it was actually built in */
  const ticket = (): GraphSpec => ({
    version: 1,
    name: "one-shot-ticket-implementation",
    description: "Implements tickets but doesn't go over board with planning and reviews",
    fields: [
      { key: "goal", kind: "text", scope: "sticky" },
      { key: "summary", kind: "text", scope: "sticky" },
      { key: "work", kind: "text", scope: "sticky" },
    ],
    inputs: ["goal", "work"],
    entry: "work",
    nodes: [
      { id: "work", kind: "agent", title: "Create a worktree", prompt: "one-shot-ticket-implementation.work", reads: ["goal", "work"], writes: ["summary", "work"] },
      { id: "ask-an-agent-8", kind: "agent", title: "Implement the changes required", prompt: "one-shot-ticket-implementation.ask-an-agent-8", reads: [], writes: ["summary"] },
      { id: "ask-an-agent", kind: "agent", title: "review-pr", prompt: "one-shot-ticket-implementation.ask-an-agent", reads: [], writes: ["summary"] },
      { id: "ask-an-agent-3", kind: "agent", title: "Probe the PR", prompt: "one-shot-ticket-implementation.ask-an-agent-3", reads: [], writes: ["summary"] },
      { id: "done", kind: "terminal", outcome: "success", title: "Finish ticket" },
    ],
    edges: [
      { from: "work", to: "ask-an-agent-8" },
      { from: "ask-an-agent-8", to: "ask-an-agent" },
      { from: "ask-an-agent", to: "ask-an-agent-8", when: { op: "equals", key: "goal", value: "reject" } },
      { from: "ask-an-agent", to: "ask-an-agent-3" },
      { from: "ask-an-agent-3", to: "done", when: { op: "equals", key: "summary", value: "All comments addressed and no CI failures" } },
      { from: "ask-an-agent-3", to: "ask-an-agent-3" },
    ],
  });

  const advice = (spec: GraphSpec) => specProblems(spec).filter((p) => !isBlocking(p));

  test("the ticket's own graph validates clean and is advised against five ways", () => {
    const spec = ticket();
    // the premise: this is exactly what "Ready to save" was printed over
    expect(buildGraph(spec).validate()).toEqual({ structural: [], paths: [] });
    expect(specProblems(spec).filter(isBlocking)).toEqual([]);

    const said = advice(spec).map((p) => p.message);
    const one = (text: string) => {
      const hits = said.filter((m) => m.includes(text));
      expect(hits.length, text).toBeGreaterThan(0);
      return hits;
    };
    // 1. three agent steps whose instructions name no field at all
    expect(one("is given nothing").length).toBe(3);
    // 2. the worktree step produces `work`, which the run is launched with
    one("which the run is also launched with");
    // 3. two rows compare free text against words no prompt asks for (`goal`, `summary`)
    expect(one("is free text").length).toBe(2);
    // 4. the probe's Otherwise goes back to itself — the row that actually hung the run
    one('has an "Otherwise" that goes back to itself');
    // 5. implement ⇄ review, with no limit on either
    one("is in a loop with no limit on it");
  });

  test("every piece of advice is attributed to a step and a pane, like every other problem", () => {
    for (const p of advice(ticket())) {
      expect(p.severity).toBe("advice");
      expect(["steps", "branching"]).toContain(p.where);
      expect(ticket().nodes.some((n) => n.id === p.node)).toBe(true);
    }
  });

  test("a loop is bounded by ONE maxVisits anywhere on it — the way the built-ins bound theirs", () => {
    const bounded = ticket();
    bounded.nodes = bounded.nodes.map((n) => (n.id === "ask-an-agent-8" ? { ...n, maxVisits: 4 } : n));
    expect(advice(bounded).filter((p) => p.message.includes("loop with no limit"))).toEqual([]);
  });

  test("a poll is not a spin: a loop containing a Wait step is never advised against", () => {
    const polling = minimal({
      fields: [{ key: "goal", kind: "text", scope: "sticky" }, { key: "pr.state", kind: "choice", scope: "per-visit", choices: ["OPEN", "MERGED"] }],
      nodes: [
        { id: "probe", kind: "command", title: "Check the PR", run: "probe:pr", reads: [], writes: ["pr.state"] },
        { id: "settle", kind: "wait", title: "Wait", duration: "5 m" },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      entry: "probe",
      edges: [
        { from: "probe", to: "done", when: { op: "equals", key: "pr.state", value: "MERGED" } },
        { from: "probe", to: "settle" },
        { from: "settle", to: "probe" },
      ],
    });
    expect(specProblems(polling)).toEqual([]);
  });

  test("a branch on a CHOICE field is the answer, so it is never advised against", () => {
    const spec = minimal({
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "verdict", kind: "choice", scope: "cleared", choices: ["pass", "reject"] },
      ],
      nodes: [
        { id: "draft", kind: "agent", title: "Draft it", prompt: "my-review.draft", reads: ["goal"], writes: ["verdict"] },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [
        { from: "draft", to: "done", when: { op: "equals", key: "verdict", value: "pass" } },
        { from: "draft", to: "done" },
      ],
    });
    expect(specProblems(spec)).toEqual([]);
  });

  test("advice is held back until nothing blocks — a graph that cannot run is not told about its loop", () => {
    const broken = ticket();
    broken.edges = [...broken.edges, { from: "ask-an-agent-8", to: "nowhere" }];
    const problems = specProblems(broken);
    expect(problems.every(isBlocking)).toBe(true);
    // ...and specAdvice() is still a pure reading of the spec, callable on its own
    expect(specAdvice(broken).length).toBeGreaterThan(0);
  });
});

/**
 * HOW-60 (H3): a `choice` field's choices are the agent's vocabulary — the prompt says them in
 * prose and the agent answers in them — so `verdict == 'approved'` against [pass, reject] is a
 * row that can never fire. Refused, worded like every other unmatchable operand.
 */
describe("a choice row must name one of the field's choices (H3)", () => {
  const verdict = (choices?: string[]): GraphSpec["fields"][number] => ({ key: "verdict", kind: "choice", scope: "sticky", ...(choices ? { choices } : {}) });
  const branching = (when: Predicate, field = verdict(["pass", "reject"])): GraphSpec => minimal({
    fields: [{ key: "goal", kind: "text", scope: "sticky" }, field, { key: "blob", kind: "json", scope: "sticky" }],
    nodes: [
      { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["verdict", "blob"] },
      { id: "again", kind: "command", title: "Try again", run: "true", reads: [], writes: [] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "again", when }, { from: "draft", to: "done" }, { from: "again", to: "done" }],
  });
  const blocking = (spec: GraphSpec) => specProblems(spec).filter(isBlocking);

  test("equals a value that is not a choice is ONE blocking problem, on the step, in Branching", () => {
    const problems = blocking(branching({ op: "equals", key: "verdict", value: "approved" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "draft", where: "branching" });
    expect(problems[0]!.message).toContain("**Draft the doc**");
    expect(problems[0]!.message).toContain("not one of its choices (`pass`, `reject`)");
    expect(problems[0]!.message).toContain("add `approved` to the field's choices");
  });

  test("not-equals is refused the same way — it would fire on every value, which is not what was typed", () => {
    const problems = blocking(branching({ op: "not-equals", key: "verdict", value: "approved" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("not one of its choices");
  });

  test("unmatchableOperand is the rule, checked directly", () => {
    expect(unmatchableOperand({ op: "equals", key: "verdict", value: "approved" }, verdict(["pass", "reject"]))).toContain("not one of its choices");
    expect(unmatchableOperand({ op: "equals", key: "verdict", value: "reject" }, verdict(["pass", "reject"]))).toBeNull();
  });

  test("near misses are clean: a listed value, a field with no choices, one-of, a json path", () => {
    expect(blocking(branching({ op: "equals", key: "verdict", value: "reject" }))).toEqual([]);
    expect(blocking(branching({ op: "not-equals", key: "verdict", value: "pass" }))).toEqual([]);
    expect(blocking(branching({ op: "equals", key: "verdict", value: "approved" }, verdict()))).toEqual([]);
    expect(blocking(branching({ op: "equals", key: "verdict", value: "approved" }, verdict([])))).toEqual([]);
    // scope pinned: one-of is not checked against the choices
    expect(blocking(branching({ op: "one-of", key: "verdict", values: ["pass", "approved"] }))).toEqual([]);
    expect(blocking(branching({ op: "equals", key: "blob", path: "outcome", value: "approved" }))).toEqual([]);
  });

  test("an empty operand still reports 'compares with nothing' first", () => {
    const problems = blocking(branching({ op: "equals", key: "verdict", value: "" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("with nothing");
  });
});

/**
 * HOW-60 (H6): the first matching row wins, so a row an earlier row always catches never
 * fires. ADVICE, not a refusal: the graph runs, it just does not do what the row says.
 */
describe("a row shadowed by an earlier, broader row is advised against (H6)", () => {
  const rows = (...whens: Predicate[]): GraphSpec => minimal({
    fields: [
      { key: "goal", kind: "text", scope: "sticky" },
      { key: "verdict", kind: "choice", scope: "sticky", choices: ["pass", "reject"] },
      { key: "flag", kind: "boolean", scope: "sticky" },
      { key: "blob", kind: "json", scope: "sticky" },
    ],
    nodes: [
      { id: "draft", kind: "agent", title: "Draft the doc", prompt: "my-review.draft", reads: ["goal"], writes: ["verdict", "flag", "blob"] },
      ...whens.map((_, i): NodeSpec => ({ id: `to${i}`, kind: "command", title: `Path ${i}`, run: "true", reads: [], writes: [] })),
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [
      ...whens.map((when, i) => ({ from: "draft", to: `to${i}`, when })),
      { from: "draft", to: "done" },
      ...whens.map((_, i) => ({ from: `to${i}`, to: "done" })),
    ],
  });
  const shadowNotes = (spec: GraphSpec) => specProblems(spec).filter((p) => p.message.includes("never fires"));
  const reject: Predicate = { op: "equals", key: "verdict", value: "reject" };
  const pass: Predicate = { op: "equals", key: "verdict", value: "pass" };

  test("the probe: `has a value` above `is reject` is advice on that step, and nothing blocks", () => {
    const spec = rows({ op: "is-not-empty", key: "verdict" }, reject);
    expect(specProblems(spec).filter(isBlocking)).toEqual([]);
    const notes = shadowNotes(spec);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ node: "draft", where: "branching", severity: "advice" });
    expect(isBlocking(notes[0]!)).toBe(false);
    expect(notes[0]!.message).toContain("**Draft the doc**");
    expect(notes[0]!.message).toContain("`verdict == 'reject'`");
    expect(notes[0]!.message).toContain("(`verdict is set`)");
    expect(specAdvice(spec)).toContainEqual(notes[0]!);
  });

  test("each broader-first ordering is caught", () => {
    const cases: Array<[Predicate, Predicate]> = [
      [{ op: "not-equals", key: "verdict", value: "pass" }, reject],
      [{ op: "one-of", key: "verdict", values: ["pass", "reject"] }, pass],
      [{ op: "one-of", key: "verdict", values: ["pass", "reject"] }, { op: "one-of", key: "verdict", values: ["reject"] }],
      [reject, { ...reject }],
      [{ op: "is-not-empty", key: "flag" }, { op: "is-true", key: "flag" }],
      [{ op: "not-equals", key: "flag", value: false }, { op: "is-true", key: "flag" }],
      [{ op: "is-true", key: "flag" }, { op: "equals", key: "flag", value: true }],
      [{ op: "equals", key: "flag", value: false }, { op: "is-false", key: "flag" }],
      [{ op: "is-empty", key: "verdict" }, { op: "is-empty", key: "verdict" }],
    ];
    for (const [a, b] of cases) expect(shadowNotes(rows(a, b)), `${predicateLabel(a)} / ${predicateLabel(b)}`).toHaveLength(1);
  });

  test("near misses are silent: narrower first, disjoint values, other keys, other paths, Otherwise first", () => {
    const cases: Array<[Predicate, Predicate]> = [
      [reject, { op: "is-not-empty", key: "verdict" }],
      [pass, reject],
      [{ op: "not-equals", key: "verdict", value: "reject" }, reject],
      [{ op: "one-of", key: "verdict", values: ["pass"] }, { op: "one-of", key: "verdict", values: ["pass", "reject"] }],
      [{ op: "is-not-empty", key: "flag" }, reject],
      [{ op: "is-not-empty", key: "blob", path: "outcome" }, { op: "equals", key: "blob", path: "other", value: "x" }],
      [{ op: "is-not-empty", key: "blob" }, { op: "equals", key: "blob", path: "outcome", value: "x" }],
      [{ op: "is-not-empty", key: "verdict" }, { op: "is-empty", key: "verdict" }],
      [{ op: "is-true", key: "flag" }, { op: "is-false", key: "flag" }],
    ];
    for (const [a, b] of cases) expect(shadowNotes(rows(a, b)), `${predicateLabel(a)} / ${predicateLabel(b)}`).toEqual([]);
    // an Otherwise listed FIRST is still the weight-0 fallback, not a row that shadows anything
    const otherwiseFirst = rows(reject);
    otherwiseFirst.edges = [{ from: "draft", to: "done" }, ...otherwiseFirst.edges.filter((e) => !(e.from === "draft" && !e.when))];
    expect(shadowNotes(otherwiseFirst)).toEqual([]);
  });

  test("a row shadowed twice is one note, naming the first row that catches it", () => {
    const notes = shadowNotes(rows({ op: "is-not-empty", key: "verdict" }, pass, { op: "one-of", key: "verdict", values: ["pass"] }));
    // row 2 is shadowed by row 1; row 3 by rows 1 AND 2 — one note each, both naming row 1
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.message.includes("(`verdict is set`)"))).toBe(true);
  });
});

/**
 * HOW-60 (H2, decision 5A): given the bodies, specProblems checks each against its step. The
 * browser and the save route both pass them, so both refuse the same things.
 */
describe("a step and its instructions are checked together when the bodies are given (H2)", () => {
  const body = "Draft it.\n\nGoal: {{ context.goal }}";
  const ok = { "my-review.draft": body };
  const blocking = (spec: GraphSpec, bodies: Record<string, string>) => specProblems(spec, { bodies }).filter(isBlocking);

  test("matching bodies are clean", () => {
    expect(templateReads(body)).toEqual(["goal"]);
    expect(specProblems(minimal(), { bodies: ok })).toEqual([]);
  });

  test("an include is refused on the step, in Steps, naming what it includes", () => {
    const problems = blocking(minimal(), { "my-review.draft": `${body}\n\n{{> review._verify_result }}` });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "draft", where: "steps" });
    expect(problems[0]!.message).toBe(
      "**Draft the doc**'s instructions include `review._verify_result` with `{{> … }}`. A graph built here cannot include another prompt — paste the text it needs into the instructions instead.",
    );
  });

  test("a malformed include is still refused, without inventing an id", () => {
    const problems = blocking(minimal(), { "my-review.draft": `${body}\n{{> }}` });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("include another prompt with");
  });

  test("a step with no body is the existing 'has no file yet'", () => {
    const problems = blocking(minimal(), {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "draft", where: "steps" });
    expect(problems[0]!.message).toContain("has no file yet");
  });

  test("a body no step uses is a graph-level problem", () => {
    const problems = blocking(minimal(), { ...ok, "my-review.gone": "Old text." });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.node).toBeUndefined();
    expect(problems[0]!.where).toBe("steps");
    expect(problems[0]!.message).toBe(`Instructions are filed under "my-review.gone", but no step uses them. Remove them, or give a step that prompt.`);
  });

  test("reads that disagree with the body are refused, naming both directions", () => {
    const spec = minimal({
      fields: [...minimal().fields, { key: "work", kind: "text", scope: "sticky" }],
      inputs: ["goal", "work"],
    });
    const unlisted = blocking(spec, { "my-review.draft": `${body} {{ context.work }}` });
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]).toMatchObject({ node: "draft", where: "steps" });
    expect(unlisted[0]!.message).toContain("its instructions use `work`, which the step does not list");
    expect(unlisted[0]!.message).not.toContain("never use");

    const unused = blocking(spec, { "my-review.draft": "Draft it." });
    expect(unused).toHaveLength(1);
    expect(unused[0]!.message).toContain("it lists `goal`, which its instructions never use");
    expect(unused[0]!.message).not.toContain("does not list");

    const both = blocking(spec, { "my-review.draft": "Do {{ context.work }}" });
    expect(both[0]!.message).toContain("use `work`");
    expect(both[0]!.message).toContain("lists `goal`");
  });

  test("without bodies, no body checks run, and knownPrompts still works on its own", () => {
    const stale: GraphSpec = { ...minimal(), nodes: minimal().nodes.map((n) => (n.kind === "agent" ? { ...n, reads: [] } : n)) };
    expect(specProblems(stale).filter(isBlocking)).toEqual([]);
    expect(specProblems(minimal(), { knownPrompts: ["my-review.draft"] })).toEqual([]);
    expect(specProblems(minimal(), { knownPrompts: [] })[0]!.message).toContain("has no file yet");
  });
});

/**
 * HOW-56 T3 (decisions 3A + C): the powers a DRAFTED graph may not take beyond its base. Every
 * rule is pinned both ways — the draft it lets through and the draft it refuses — because a
 * rule that only ever refuses is as wrong as one that never does.
 */
describe("draftRuleProblems: a draft stays within the powers its base grants", () => {
  type Agent = Extract<NodeSpec, { kind: "agent" }>;
  const review: Agent = { id: "review", kind: "agent", title: "Review it", prompt: "my-review.review", reads: ["summary"], writes: [], readOnly: true };
  const base = (): GraphSpec => {
    const m = minimal();
    return minimal({ defaults: { effort: "high", harness: "claude" }, nodes: [m.nodes[0]!, review, m.nodes[1]!] });
  };
  /** the base, re-drafted: same steps, same defaults */
  const draft = (over: Partial<GraphSpec> = {}): GraphSpec => ({ ...base(), name: "my-redraft", ...over });
  const withStep = (n: NodeSpec): GraphSpec => draft({ nodes: [...base().nodes, n] });
  /** `null` = no base: a default parameter would swallow an explicit `undefined` */
  const blocking = (spec: GraphSpec, b: GraphSpec | null = base(), bodies?: Record<string, string | { copyOf: string }>) =>
    draftRuleProblems(spec, b ?? undefined, bodies ? { bodies } : {}).filter(isBlocking);
  const cmd = (run: string): NodeSpec => ({ id: "check", kind: "command", title: "Check", run, reads: [], writes: [] });

  test("a draft that only re-uses its base's powers is clean", () => {
    expect(draftRuleProblems(draft(), base())).toEqual([]);
  });

  test("a command must be EXACTLY a built-in", () => {
    expect(blocking(withStep(cmd("verify:run")))).toEqual([]);
    expect(blocking(withStep(cmd("  probe:pr  ")))).toEqual([]);

    const shell = blocking(withStep(cmd("echo hi")));
    expect(shell).toHaveLength(1);
    expect(shell[0]).toMatchObject({ node: "check", where: "steps" });
    expect(shell[0]!.message).toContain("**Check** runs `echo hi`, which is not one of Howdah's built-in steps");
    expect(shell[0]!.message).toContain("`verify:run`");
    expect(shell[0]!.message).not.toContain("`runs:launch`");

    // commandBuiltin() matches the FIRST WORD, and probe:pr is dispatched by equality, so this
    // would pass the builder's own check and run in bash
    const smuggled = blocking(withStep(cmd("probe:pr && rm -rf ~")));
    expect(smuggled).toHaveLength(1);
    expect(smuggled[0]!.message).toContain("`probe:pr && rm -rf ~`");
    expect(blocking(withStep(cmd("map:drift --since x")))).toHaveLength(1);
  });

  test("runs:launch is refused with its own sentence", () => {
    const launch = blocking(withStep(cmd("runs:launch")));
    expect(launch).toHaveLength(1);
    expect(launch[0]).toMatchObject({ node: "check", where: "steps" });
    expect(launch[0]!.message).toBe(
      "**Check** launches one run per approved slice. A drafted graph cannot launch runs — that starts many runs at once with no approval between them. Remove the step.",
    );
  });

  test("an approval step is refused", () => {
    expect(blocking(draft())).toEqual([]);
    const gate: NodeSpec = { id: "gate", kind: "approval", title: "Approve it", proposal: "p", base: "b", decision: "d", feedback: "f", redesignTo: "draft" };
    const problems = blocking(withStep(gate));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "gate", where: "steps" });
    expect(problems[0]!.message).toContain("**Approve it** is an approval step");
  });

  test("defaults must be the base's, whatever their key order", () => {
    expect(blocking(draft({ defaults: { harness: "claude", effort: "high" } }))).toEqual([]);

    const changed = blocking(draft({ defaults: { effort: "max", harness: "claude" } }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ where: "basics" });
    expect(changed[0]!.node).toBeUndefined();
    expect(changed[0]!.message).toContain("changes the default agent settings of `my-review`");

    const { defaults: _d, ...bare } = draft();
    expect(blocking(bare)).toHaveLength(1);
  });

  test("with no base, defaults must be absent (or empty, which is the same)", () => {
    const { defaults: _d, ...bare } = draft();
    expect(blocking(bare, null)).toEqual([]);
    expect(blocking({ ...bare, defaults: {} }, null)).toEqual([]);
    const set = blocking(draft(), null);
    expect(set).toHaveLength(1);
    expect(set[0]!.message).toContain("A drafted graph starts with none");
  });

  test("a step may not carry its own agent config", () => {
    expect(blocking(draft())).toEqual([]);
    const tuned = draft({ nodes: base().nodes.map((n) => (n.id === "draft" ? { ...n, config: { effort: "max" } } : n)) as NodeSpec[] });
    const problems = blocking(tuned);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ node: "draft", where: "steps" });
    expect(problems[0]!.message).toContain("**Draft the doc** sets its own agent settings");
  });

  test("a copy of a read-only base prompt keeps readOnly", () => {
    const copy = (readOnly: boolean): NodeSpec => ({
      id: "second_look", kind: "agent", title: "Second look", prompt: "my-redraft.second_look", reads: [], writes: [], ...(readOnly ? { readOnly: true as const } : {}),
    });
    const bodies = { "my-redraft.second_look": { copyOf: "my-review.review" } };
    expect(blocking(withStep(copy(true)), base(), bodies)).toEqual([]);

    const loosened = blocking(withStep(copy(false)), base(), bodies);
    expect(loosened).toHaveLength(1);
    expect(loosened[0]).toMatchObject({ node: "second_look", where: "steps" });
    expect(loosened[0]!.message).toBe(
      "**Second look** copies the instructions of `my-review.review`, which is read-only in `my-review`, but the step is not. Make it read-only, as the original is.",
    );

    // the base's own step, kept with its id, loosened: still refused
    const reviewLoosened = draft({ nodes: base().nodes.map((n) => (n.id === "review" ? { ...n, readOnly: undefined, prompt: "my-redraft.review" } : n)) as NodeSpec[] });
    expect(blocking(reviewLoosened, base(), { "my-redraft.review": { copyOf: "my-review.review" } })).toHaveLength(1);

    // a copy of a base step that was never read-only may stay writable; written-out text is not a copy
    expect(blocking(withStep(copy(false)), base(), { "my-redraft.second_look": { copyOf: "my-review.draft" } })).toEqual([]);
    expect(blocking(withStep(copy(false)), base(), { "my-redraft.second_look": "Look again." })).toEqual([]);
  });

  test("a NEW step that can change files is a permission callout, never a block", () => {
    const step = (readOnly: boolean): NodeSpec => ({
      id: "polish", kind: "agent", title: "Polish", prompt: "my-redraft.polish", reads: [], writes: [], ...(readOnly ? { readOnly: true as const } : {}),
    });
    const flagged = draftRuleProblems(withStep(step(false)), base());
    expect(flagged).toEqual([{
      node: "polish", where: "steps", severity: "advice", kind: "permission",
      message: "**Polish** is a new step that can change files. Make it read-only if it only needs to look.",
    }]);
    expect(flagged.filter(isBlocking)).toEqual([]);

    expect(draftRuleProblems(withStep(step(true)), base())).toEqual([]);
    // `draft` is writable but is the base's own step: not new, so not called out
    expect(draftRuleProblems(draft(), base()).filter((p) => p.kind === "permission")).toEqual([]);
  });

  test("with no base, every writable agent step is new", () => {
    const { defaults: _d, ...bare } = draft();
    const flagged = draftRuleProblems(bare);
    expect(flagged.map((p) => [p.node, p.kind, p.severity])).toEqual([["draft", "permission", "advice"]]);
  });

  test("every refusal is reported, not just the first", () => {
    const messy = draft({ defaults: { effort: "low" }, nodes: [...base().nodes, cmd("echo hi"), { ...cmd("runs:launch"), id: "launch" }] });
    expect(blocking(messy).map((p) => p.node ?? "(graph)")).toEqual(["(graph)", "check", "launch"]);
  });
});

describe("drafted: where a graph came from rides in the spec, never in the Graph (HOW-56)", () => {
  const provenance = { run: "plan-feature-abc--draft", draftHash: "c53:0011223344556" };
  const withDrafted = (): GraphSpec => ({ ...minimal(), drafted: provenance });

  test("the exact shape parses, and survives a JSON round trip", () => {
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify(withDrafted())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.drafted).toEqual(provenance);
    const again = parseGraphSpec(JSON.parse(JSON.stringify(parsed.spec)));
    expect(again).toEqual(parsed);
  });

  test("HOW-65: { run, draftHash, edited: true } parses and round-trips; edited is kept", () => {
    const edited = { ...provenance, edited: true as const };
    const parsed = parseGraphSpec(JSON.parse(JSON.stringify({ ...minimal(), drafted: edited })));
    expect(parsed.ok && parsed.spec.drafted).toEqual(edited);
    if (parsed.ok) expect(parseGraphSpec(JSON.parse(JSON.stringify(parsed.spec)))).toEqual(parsed);
    expect(shapeOf(buildGraph({ ...minimal(), drafted: edited }))).toEqual(shapeOf(buildGraph(minimal())));
  });

  test("anything but exactly { run, draftHash } (+ edited: true) is dropped, and the spec still parses", () => {
    for (const bad of [
      null, "x", [], {},
      { run: "r" },
      { draftHash: "h" },
      { run: "r", draftHash: "h", extra: 1 },
      { run: "r", draftHash: "h", edited: false },
      { run: "r", draftHash: "h", edited: "yes" },
      { run: "r", edited: true },
      { run: "r", draftHash: "h", edited: true, extra: 1 },
      { run: 3, draftHash: "h" },
      { run: "r", draftHash: "" },
      { run: "", draftHash: "h" },
    ]) {
      const parsed = parseGraphSpec({ ...minimal(), drafted: bad });
      expect([bad, parsed.ok]).toEqual([bad, true]);
      if (parsed.ok) expect([bad, "drafted" in parsed.spec]).toEqual([bad, false]);
    }
  });

  test("it is NOT compiled: the same shapeOf, the same def bar the spec", () => {
    expect(SPEC_VERSION).toBe(1);
    expect(shapeOf(buildGraph(withDrafted()))).toEqual(shapeOf(buildGraph(minimal())));
    const { spec: _a, ...drafted } = buildGraph(withDrafted()).def;
    const { spec: _b, ...plain } = buildGraph(minimal()).def;
    expect(drafted).toEqual(plain);
    expect(buildGraph(withDrafted()).def.spec?.drafted).toEqual(provenance);
  });

  test("...and it is not a problem to report", () => {
    expect(specProblems(withDrafted())).toEqual(specProblems(minimal()));
  });
});

describe("renameDraft: the graph's name moves every prompt it owns (HOW-65)", () => {
  test("prompt ids and body keys under <old>. move; copies keep their target; step ids stay", () => {
    const d = cleanDraft();
    const { spec, bodies } = renameDraft(d.spec, d.prompts, "my-review");
    expect(spec.name).toBe("my-review");
    expect(spec.nodes.map((n) => n.id)).toEqual(d.spec.nodes.map((n) => n.id));
    expect(spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.prompt] : []))).toEqual(["my-review.work", "my-review.review"]);
    expect(bodies).toEqual({
      "my-review.work": { copyOf: "quick-task.work" },
      "my-review.review": d.prompts["quick-review.review"]!,
    });
    expect(d.spec.name).toBe("quick-review"); // not mutated
  });

  test("a prompt filed under another prefix, and a body no step names, are left alone", () => {
    const d = borrowedPrompt();
    d.prompts["quick-review.orphan"] = "x";
    const { spec, bodies } = renameDraft(d.spec, d.prompts, "other");
    expect(spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.prompt] : []))).toEqual(["other.work", "quick-task.review"]);
    expect(Object.keys(bodies).sort()).toEqual(["other.work", "quick-review.orphan", "quick-task.review"]);
  });

  test("renaming an unnamed draft moves its `.<step>` ids, as the builder's name box needs", () => {
    const spec: GraphSpec = { ...minimal(), name: "", nodes: minimal().nodes.map((n) => (n.kind === "agent" ? { ...n, prompt: `.${n.id}` } : n)) };
    const agentIds = spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.id] : []));
    const out = renameDraft(spec, Object.fromEntries(agentIds.map((id) => [`.${id}`, "t"])), "x");
    expect(out.spec.nodes.flatMap((n) => (n.kind === "agent" ? [n.prompt] : []))).toEqual(agentIds.map((id) => `x.${id}`));
  });
});

describe("resolveDraftBodies: text, or a copy of a prompt Howdah has", () => {
  const known = ["review.local", "write-doc.review"];

  test("text and a known copy resolve", () => {
    expect(resolveDraftBodies({ "x.draft": "Draft it.", "x.review": { copyOf: "review.local" } }, known)).toEqual({
      ok: true,
      bodies: { "x.draft": "Draft it.", "x.review": { copyOf: "review.local" } },
    });
    expect(resolveDraftBodies({}, known)).toEqual({ ok: true, bodies: {} });
  });

  test("an unknown copy is refused in the operator's words, naming both ids", () => {
    const r = resolveDraftBodies({ "x.review": { copyOf: "foo.bar" } }, known);
    expect(r).toEqual({
      ok: false,
      problems: [{
        where: "steps",
        message: "The instructions for `x.review` are a copy of `foo.bar`, which is not a prompt Howdah has. Copy one that exists, or write the instructions out.",
      }],
    });
  });

  test("a malformed body is refused separately", () => {
    for (const bad of [3, null, [], {}, { copyOf: 3 }, { copyOf: "review.local", extra: true }, { copy: "review.local" }]) {
      const r = resolveDraftBodies({ "x.review": bad }, known);
      expect([bad, r.ok]).toEqual([bad, false]);
      if (!r.ok) expect(r.problems[0]!.message).toContain("are neither text nor a copy");
    }
  });

  test("every problem is reported", () => {
    const r = resolveDraftBodies({ "x.a": { copyOf: "nope" }, "x.b": "fine", "x.c": 7 }, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.message.match(/`(x\.\w)`/)?.[1])).toEqual(["x.a", "x.c"]);
  });
});

describe("draftHashOf: an edit changes it, a rename does not (D-9A)", () => {
  const bodies = { "my-review.draft": "Draft it. {{ context.goal }}" };
  const hash = (spec: GraphSpec, b: Record<string, string | { copyOf: string }> = bodies) => draftHashOf(spec, b);

  test("deterministic, and node-free in form", () => {
    expect(hash(minimal())).toBe(hash(minimal()));
    expect(hash(minimal())).toMatch(/^c53:[0-9a-f]{14}$/);
  });

  test("key order and load normalisation are not edits", () => {
    const reordered = JSON.parse(JSON.stringify(minimal(), Object.keys(minimal()).reverse().concat("id", "kind", "title", "prompt", "reads", "writes", "outcome", "from", "to", "key", "scope")));
    expect(hash(reordered)).toBe(hash(minimal()));
    // parseGraphSpec drops a key it does not know, so a draft carrying junk hashes as without
    expect(hash({ ...minimal(), junk: 1 } as GraphSpec)).toBe(hash(minimal()));
  });

  test("a rename — the name, every prompt prefix and every body key together — is not an edit", () => {
    const renamed = minimal({
      name: "my-other",
      nodes: minimal().nodes.map((n) => (n.kind === "agent" ? { ...n, prompt: "my-other.draft" } : n)),
    });
    expect(hash(renamed, { "my-other.draft": bodies["my-review.draft"] })).toBe(hash(minimal()));
  });

  test("a position, and the provenance itself, are not edits", () => {
    const moved = minimal({ nodes: minimal().nodes.map((n, i) => ({ ...n, position: { x: i * 100, y: 7 } })) });
    expect(hash(moved)).toBe(hash(minimal()));
    expect(hash({ ...minimal(), drafted: { run: "r", draftHash: "h" } })).toBe(hash(minimal()));
  });

  test("a body edit, a title edit and an edge reorder are edits", () => {
    const base = hash(minimal());
    expect(hash(minimal(), { "my-review.draft": "Draft it again. {{ context.goal }}" })).not.toBe(base);
    expect(hash(minimal(), { "my-review.draft": { copyOf: "write-doc.draft" } })).not.toBe(base);
    expect(hash(minimal({ nodes: minimal().nodes.map((n) => (n.id === "draft" ? { ...n, title: "Write it" } : n)) }))).not.toBe(base);
    const twoEdges = minimal({ edges: [{ from: "draft", to: "done", when: { op: "is-empty", key: "summary" } }, { from: "draft", to: "done" }] });
    const swapped = minimal({ edges: [...twoEdges.edges].reverse() });
    expect(hash(swapped)).not.toBe(hash(twoEdges));
  });
});

describe("checkGraphDraft: a draft is published only if it would save (HOW-64, HOW-56 T5)", () => {
  const check = (v: unknown) => checkGraphDraft(v, CATALOG, materialiseFake);

  test("a clean draft — one copy, one new body — has nothing to say", () => {
    expect(check(cleanDraft())).toEqual([]);
  });

  test("the same draft sent as a JSON string is read, not refused", () => {
    expect(check(JSON.stringify(cleanDraft()))).toEqual([]);
  });

  for (const [name, c] of Object.entries(EDGE_CASES))
    test(`${name}: refused with exactly one sentence, word for word`, () => {
      const problems = check(c.draft());
      expect(problems).toHaveLength(1);
      if (name === "invalid JSON") expect(problems[0]).toStartWith(c.says);
      else expect(problems[0]).toBe(c.says);
    });

  test("advice never refuses: a new step that can change files is a callout for review, not a refusal", () => {
    const d = cleanDraft();
    expect(draftRuleProblems(d.spec, CATALOG.graphs[1]!.spec, { bodies: d.prompts }).filter((p) => p.kind === "permission")).toHaveLength(1);
    expect(check(d)).toEqual([]);
  });

  test("a copy of a read-only step must stay read-only", () => {
    const d = cleanDraft();
    d.spec.nodes[1] = { id: "quick-review.review", kind: "agent", prompt: "quick-review.review", reads: ["goal"], writes: ["verdict"] };
    d.prompts["quick-review.review"] = { copyOf: "look-only.review" };
    d.based_on = "look-only";
    d.spec.defaults = undefined;
    expect(check(d)).toEqual([
      "**quick-review.review** copies the instructions of `look-only.review`, which is read-only in `look-only`, but the step is not. Make it read-only, as the original is.",
    ]);
  });

  test("a copy's reads are judged on the COPIED text, as Save would judge them", () => {
    const d = cleanDraft();
    const work = d.spec.nodes[0]!;
    if (work.kind === "agent") work.reads = ["summary"]; // quick-task.work reads goal, not summary
    expect(check(d).join("\n")).toContain("does not match its instructions");
  });

  test("based_on must name a catalog graph, or be null", () => {
    expect(check({ ...cleanDraft(), based_on: "no-such-graph" })).toEqual([
      "graph.draft.based_on names `no-such-graph`, which is not a graph in the catalog. Name one of `look-only`, `quick-task`, or null.",
    ]);
    // null: no base, so the base's defaults are a change it may not make
    expect(check({ ...cleanDraft(), based_on: null })).toEqual([
      "This draft sets default agent settings. A drafted graph starts with none — set them in the builder after saving.",
    ]);
  });

  test("every missing part of the envelope is named at once", () => {
    expect(check({ spec: cleanDraft().spec, prompts: [], based_on: 3 })).toEqual([
      "graph.draft.prompts must be an object of prompt id → instructions text, or { \"copyOf\": \"<prompt id>\" }.",
      "graph.draft.based_on must be the name of the catalog graph this draft starts from, or null.",
      "graph.draft.notes must be a short text saying what the draft changes and why.",
    ]);
    expect(check([1])).toEqual([`graph.draft must be an object { "spec", "prompts", "based_on", "notes" }, not a list`]);
    expect(check({ ...cleanDraft(), spec: { version: 1, name: "Bad Name" } })).toEqual([
      `graph.draft.spec is not a graph Howdah can read: graph name must be kebab-case: "Bad Name"`,
    ]);
  });

  test("a copy the prompt reader cannot read is refused with the reader's own sentence", () => {
    expect(checkGraphDraft(cleanDraft(), CATALOG, () => ({ ok: false, error: "cannot read it" }))).toEqual(["cannot read it"]);
  });

  test("several problems are all reported, in a fixed order, so one repair can fix them all", () => {
    const d = renamed("quick-task");
    d.prompts["quick-task.extra"] = "Nobody runs this.\n";
    d.prompts["quick-task.work"] = { copyOf: "nope.prompt" };
    expect(check(d)).toEqual([
      "The instructions for `quick-task.work` are a copy of `nope.prompt`, which is not a prompt Howdah has. Copy one that exists, or write the instructions out.",
      "There is already a graph called `quick-task`. Pick another name.",
      // bodies unresolved: the spec is still judged against the ids it was given, minus body checks
    ]);
    delete d.prompts["quick-task.work"];
    d.prompts["quick-task.work"] = { copyOf: "quick-task.work" };
    expect(check(d)).toEqual([
      "There is already a graph called `quick-task`. Pick another name.",
      `Instructions are filed under "quick-task.extra", but no step uses them. Remove them, or give a step that prompt.`,
    ]);
  });
});
