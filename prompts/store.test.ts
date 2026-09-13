import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptStore, PromptStoreError } from "./store";
import { defineGraph } from "../core/graph";

interface Ctx {
  goal: string;
  work: string;
  extra_facts: string;
  discovery: "candidate" | "idle";
}

// A minimal graph whose `discover` node consumes the prompt under test.
const consumer = defineGraph<Ctx>({
  name: "consumer",
  entry: "discover",
  inputs: ["goal"],
  nodes: {
    discover: {
      kind: "agent",
      prompt: "discover",
      reads: ["goal", "work"],
      writes: { discovery: { scope: "per-visit" } },
    },
    done: { kind: "terminal", outcome: "success" },
  },
  edges: [{ from: "discover", to: "done" }],
});
// note: consumer would fail path validation (`work` has no writer) — irrelevant here,
// template-read validation only compares template refs against node declarations.

function fixture(body: string, version = 3): string {
  const dir = mkdtempSync(join(tmpdir(), "howdah-store-"));
  writeFileSync(join(dir, "discover.md"), `---\nid: discover\nversion: ${version}\n---\n${body}`);
  return dir;
}

describe("PromptStore.load", () => {
  test("parses id, version, body", () => {
    const store = new PromptStore(fixture("Find work.\n\n{{ context.goal }}\n"));
    const p = store.load("discover");
    expect(p.version).toBe(3);
    expect(p.body).toContain("Find work.");
  });

  test("unknown prompt throws", () => {
    const store = new PromptStore(fixture("x"));
    expect(() => store.load("nope")).toThrow(PromptStoreError);
  });

  test("real prompts dir: every prompt loads with a version", () => {
    const store = new PromptStore();
    const ids = store.list();
    expect(ids.length).toBeGreaterThanOrEqual(18);
    for (const id of ids) expect(store.load(id).version).toBeGreaterThanOrEqual(1);
  });
});

describe("templateReads", () => {
  test("extracts context and inputs refs, ignores filters and internal.*", () => {
    const reads = PromptStore.templateReads(
      "Goal: {{ context.goal }}\nWork: {{ inputs.work | json }}\nTurn: {{ context.internal.visit }}\nAgain: {{ context.goal }}",
    );
    expect(reads).toEqual(["goal", "work"]);
  });
});

describe("accept", () => {
  let dir: string;
  let store: PromptStore;

  beforeEach(() => {
    dir = fixture("Find work toward {{ context.goal }}.\n");
    store = new PromptStore(dir);
  });

  test("happy path: bumps version, stamps provenance, keeps body", () => {
    const v = store.accept(
      { id: "discover", base_version: 3, body: "Better: {{ context.goal }} and {{ context.work }}.\n", provenance: "eval 15/15" },
      [consumer],
    );
    expect(v).toBe(4);
    const raw = readFileSync(join(dir, "discover.md"), "utf8");
    expect(raw).toContain("version: 4");
    expect(raw).toContain("provenance: eval 15/15");
    expect(store.load("discover").body).toContain("Better:");
  });

  test("stale base_version is refused (D7)", () => {
    expect(() =>
      store.accept({ id: "discover", base_version: 2, body: "x" }, [consumer]),
    ).toThrow(/stale base/);
    // and the file is untouched
    expect(store.load("discover").version).toBe(3);
  });

  test("revision introducing an undeclared read is refused (OV-3)", () => {
    expect(() =>
      store.accept(
        { id: "discover", base_version: 3, body: "Use {{ context.extra_facts }} too.\n" },
        [consumer],
      ),
    ).toThrow(/undeclared reads[\s\S]*extra_facts/);
    expect(store.load("discover").version).toBe(3);
  });

  test("inputs count as declared for template-read validation", () => {
    // inputs.goal resolves via the graph inputs list, not node reads
    const v = store.accept(
      { id: "discover", base_version: 3, body: "{{ inputs.goal }}\n" },
      [consumer],
    );
    expect(v).toBe(4);
  });

  test("accepting twice with the same base is refused the second time", () => {
    const proposal = { id: "discover", base_version: 3, body: "v4 body {{ context.goal }}\n" };
    store.accept(proposal, [consumer]);
    expect(() => store.accept(proposal, [consumer])).toThrow(/stale base/);
  });
});

describe("proposal files", () => {
  const { loadProposal, acceptProposal, rejectProposal } = require("./proposals") as typeof import("./proposals");
  const { mkdtempSync: mkTmp, writeFileSync: wf } = require("node:fs") as typeof import("node:fs");

  function proposalFixture(status = "pending", base = 3) {
    const promptDir = mkTmp(join(tmpdir(), "howdah-prop-"));
    wf(join(promptDir, "discover.md"), `---\nid: discover\nversion: 3\n---\nOld {{ context.goal }}\n`);
    const path = join(promptDir, "discover.v4.proposal.md");
    wf(path, `---\nid: discover\nbase_version: ${base}\nproposed_version: 4\nstatus: ${status}\n---\nNew {{ context.goal }}\n`);
    return { store: new PromptStore(promptDir), path };
  }

  test("accept: pending proposal bumps the prompt and stamps the file", () => {
    const { store, path } = proposalFixture();
    expect(acceptProposal(path, [consumer], store)).toBe(4);
    expect(loadProposal(path).status).toBe("accepted");
    expect(store.load("discover").body).toContain("New");
  });

  test("accept: non-pending proposal is refused", () => {
    const { store, path } = proposalFixture("accepted");
    expect(() => acceptProposal(path, [consumer], store)).toThrow(/already accepted/);
  });

  test("accept: stale base leaves proposal pending for re-draft", () => {
    const { store, path } = proposalFixture("pending", 2);
    expect(() => acceptProposal(path, [consumer], store)).toThrow(/stale base/);
    expect(loadProposal(path).status).toBe("pending");
  });

  test("reject stamps status + reason", () => {
    const { path } = proposalFixture();
    rejectProposal(path, "too verbose\nfor the harness");
    const p = loadProposal(path);
    expect(p.status).toBe("rejected");
    expect(p.frontmatter).toContain("rejection_reason: too verbose for the harness");
  });
});
