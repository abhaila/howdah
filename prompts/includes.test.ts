/**
 * Includes vs the prompt library, proposals and the store (system-map 1c review): a prompt that
 * `{{> id }}`-includes others runs text that several prompt versions produced, so
 *   - renders record the include closure (run-started.pinned_includes, prompt-rendered.includes)
 *     and the library groups by the composite version key;
 *   - consumers follow includes (`via` the includer), and an included prompt's page shows those
 *     indirect renders and feedback, labelled;
 *   - a proposal records base_includes and is stale when ANY included prompt moved; changing the
 *     include lines needs `fork: true`; the review view names the indirect consumers affected.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineGraph } from "../core/graph";
import { Engine } from "../engine/run";
import { PromptStore, PromptStoreError } from "./store";
import { appendFeedback, consumersOf, outcomeRows, promptDetail, promptSummaries, scanRuns, versionKey } from "./library";
import { acceptProposal, viewProposal } from "./proposals";

interface Ctx {
  goal: string;
  summary: string;
}

/** `work` includes the partial `shared._rules`; `check` includes nothing */
const graph = defineGraph<Ctx>({
  name: "inc",
  entry: "work",
  inputs: ["goal"],
  nodes: {
    work: { kind: "agent", prompt: "work" as never, reads: ["goal"], writes: { summary: { scope: "sticky" } } },
    check: { kind: "agent", prompt: "check" as never, reads: ["goal", "summary"], writes: {} },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [
    { from: "work", to: "check" },
    { from: "check", to: "done" },
  ],
});

function repo(versions: { work?: number; rules?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "howdah-inc-lib-"));
  for (const d of ["prompts", "feedback", join("reviser", "proposals")]) mkdirSync(join(root, d), { recursive: true });
  const write = (id: string, version: number, body: string) =>
    writeFileSync(join(root, "prompts", `${id}.md`), `---\nid: ${id}\nversion: ${version}\n---\n${body}`);
  write("work", versions.work ?? 1, "Do {{ context.goal }}.\n\n{{> shared._rules }}\n");
  write("shared._rules", versions.rules ?? 1, "Rules: be precise.\n");
  write("check", 1, "Check {{ context.summary }}.\n");
  return { root, write, runsDir: join(root, "runs"), store: new PromptStore(join(root, "prompts")) };
}

const paths = (root: string, runsDir: string) => ({ root, runsDir, promptsDir: join(root, "prompts"), feedbackDir: join(root, "feedback"), proposalsDir: join(root, "reviser", "proposals") });

async function run(r: ReturnType<typeof repo>, id: string) {
  const engine = new Engine(graph, {
    dir: join(r.runsDir, id),
    promptsDir: join(r.root, "prompts"),
    executors: { agent: async ({ nodeId }) => ({ status: "succeeded", writes: nodeId === "work" ? { summary: "done" } : {} }) },
  });
  await engine.start({ goal: "ship" });
  return engine;
}

describe("renders record the include closure", () => {
  test("run-started.pinned_includes and prompt-rendered.includes carry the included versions", async () => {
    const r = repo({ rules: 4 });
    const events = (await run(r, "a")).log.read();
    expect(events[0]).toMatchObject({ type: "run-started", pinned_prompts: { work: 1, check: 1 }, pinned_includes: { work: { "shared._rules": 4 } } });
    const renders = events.filter((e) => e.type === "prompt-rendered");
    expect(renders.map((e) => e.type === "prompt-rendered" && e.includes)).toEqual([{ "shared._rules": 4 }, undefined]);
  });
});

describe("library: composite versions, consumers and evidence through includes", () => {
  test("versionKey names every text that ran", () => {
    expect(versionKey("slice.fix_ci", 1, { "delivery.fix_ci": 2, "slice._design": 1 })).toBe("slice.fix_ci v1 · delivery.fix_ci v2 · slice._design v1");
    expect(versionKey("check", 3)).toBe("check v3");
  });

  test("consumersOf follows includes and marks them via the includer", () => {
    const r = repo();
    expect(consumersOf([graph], "shared._rules", r.store)).toEqual([{ graph: "inc", node: "work", via: "work" }]);
    expect(consumersOf([graph], "work", r.store)).toEqual([{ graph: "inc", node: "work" }]);
    expect(consumersOf([graph], "shared._rules")).toEqual([]); // no store: direct only, as before
  });

  test("an included prompt's page shows the indirect renders and feedback, labelled; tallies group by the composite key", async () => {
    const r = repo();
    await run(r, "a");
    r.write("shared._rules", 2, "Rules: be precise and brief.\n"); // the partial moves; `work` stays v1
    const b = await run(r, "b");
    const hashB = b.log.read().find((e) => e.type === "prompt-rendered" && e.node === "work");
    if (hashB?.type !== "prompt-rendered") throw new Error("no render");
    appendFeedback(join(r.root, "feedback"), "work", { run: "b", node: "work", visit: 1, note: "rules too terse", verdict: "reject", rendered_hash: hashB.rendered_hash });

    const rows = outcomeRows(scanRuns(r.runsDir), "shared._rules");
    expect(rows.map((x) => [x.via, x.version_key])).toEqual([
      ["work", "work v1 · shared._rules v1"],
      ["work", "work v1 · shared._rules v2"],
    ]);
    const detail = promptDetail(paths(r.root, r.runsDir), [graph], "shared._rules", r.store);
    expect(detail.consumers).toEqual([{ graph: "inc", node: "work", via: "work" }]);
    expect(detail.indirect_feedback).toMatchObject([{ note: "rules too terse", via: "work", version_key: "work v1 · shared._rules v2" }]);
    expect(detail.feedback).toMatchObject({ count: 0, indirect: 1 });
    expect(detail.outcomes).toMatchObject({ renders: 2, indirect: 2 });
    // the includer's own page keeps the two texts apart though its version never moved
    const work = promptDetail(paths(r.root, r.runsDir), [graph], "work", r.store);
    expect(Object.keys(work.by_version)).toEqual(["work v1 · shared._rules v1", "work v1 · shared._rules v2"]);
    expect(work.feedback_entries).toMatchObject([{ note: "rules too terse", version_key: "work v1 · shared._rules v2" }]);
    const summary = promptSummaries(paths(r.root, r.runsDir), [graph], r.store).find((s) => s.id === "shared._rules")!;
    expect(summary.consumers).toEqual([{ graph: "inc", node: "work", via: "work" }]);
  });
});

describe("proposals and accept through includes", () => {
  const proposal = (r: ReturnType<typeof repo>, id: string, fm: string, body: string) => {
    const file = `${id}.v2.proposal.md`;
    writeFileSync(join(r.root, "reviser", "proposals", file), `---\nid: ${id}\nbase_version: 1\n${fm}proposed_version: 2\nstatus: pending\ncreated: 2026-09-19T00:00:00Z\n---\n${body}`);
    return { file, path: join(r.root, "reviser", "proposals", file) };
  };
  const view = (r: ReturnType<typeof repo>, file: string) => viewProposal(join(r.root, "reviser", "proposals"), file, r.store, r.root, [graph]);

  test("a proposal is stale when an INCLUDED prompt moved, and accept refuses it", () => {
    const r = repo();
    const p = proposal(r, "work", `base_includes: {"shared._rules":1}\n`, "Do {{ context.goal }} well.\n\n{{> shared._rules }}\n");
    expect(view(r, p.file)).toMatchObject({ stale: false, stale_reason: null, base_includes: { "shared._rules": 1 } });
    r.write("shared._rules", 2, "Rules: changed.\n");
    const v = view(r, p.file);
    expect(v.stale).toBe(true);
    expect(v.stale_reason).toContain("shared._rules v1 → v2");
    expect(() => acceptProposal(p.path, [graph], r.store)).toThrow(/included prompt moved/);
  });

  test("a proposal for a prompt with includes but no base_includes is stale (it never recorded what it saw)", () => {
    const r = repo();
    const p = proposal(r, "work", "", "Do {{ context.goal }} well.\n\n{{> shared._rules }}\n");
    expect(view(r, p.file).stale_reason).toContain("did not record the versions of the prompts it includes");
  });

  test("changing the include lines is refused unless the proposal is marked a fork", () => {
    const r = repo();
    const dropped = proposal(r, "work", `base_includes: {"shared._rules":1}\n`, "Do {{ context.goal }}.\n\nRules: be precise.\n");
    expect(() => acceptProposal(dropped.path, [graph], r.store)).toThrow(/changes work's includes \(shared._rules → none\)/);
    const fork = proposal(r, "work", `base_includes: {"shared._rules":1}\nfork: true\n`, "Do {{ context.goal }}.\n\nRules: be precise.\n");
    expect(acceptProposal(fork.path, [graph], r.store)).toBe(2);
  });

  test("accepting a revision of an included prompt: the review view names the indirect consumers it changes", () => {
    const r = repo();
    const p = proposal(r, "shared._rules", "", "Rules: be exact.\n");
    expect(view(r, p.file).indirect_consumers).toEqual([{ graph: "inc", node: "work", via: "work" }]);
    expect(acceptProposal(p.path, [graph], r.store)).toBe(2);
  });

  test("a partial revised to read an undeclared key is refused through its includer", () => {
    const r = repo();
    const p = proposal(r, "shared._rules", "", "Rules for {{ context.summary }}.\n");
    expect(() => acceptProposal(p.path, [graph], r.store)).toThrow(PromptStoreError);
    expect(() => acceptProposal(p.path, [graph], r.store)).toThrow(/inc\/work: template reads "summary"/);
  });
});
