import { describe, expect, test } from "bun:test";
import { ContextStore, ContextError } from "./context";

interface Ctx {
  work: string;
  review_verdict: "pass" | "reject";
  "pr.state": string;
  publication_summary: string;
}

function store() {
  return new ContextStore<Ctx>({
    work: { scope: "sticky", writer: "intake" },
    review_verdict: { scope: "cleared", writer: "review" },
    "pr.state": { scope: "per-visit", writer: "probe_pr" },
    publication_summary: { scope: "sticky", writer: "publish" },
  });
}

const reader = (node: string, visit = 1) => ({ node, visit });

function write<K extends keyof Ctx & string>(s: ContextStore<Ctx>, node: string, visit: number, key: K, value: Ctx[K]) {
  s.beginAttempt(node, visit);
  s.set(key, value);
  s.endAttempt("succeeded");
}

describe("declaration discipline (D3)", () => {
  test("undeclared key write is rejected", () => {
    const s = store();
    s.beginAttempt("intake", 1);
    // @ts-expect-error — undeclared key is also a compile error
    expect(() => s.set("nonsense", "x")).toThrow(ContextError);
    s.endAttempt("failed");
  });

  test("only the declared writer may write", () => {
    const s = store();
    s.beginAttempt("publish", 1);
    expect(() => s.set("work", "hijack")).toThrow(/not a declared writer/);
    s.endAttempt("failed");
  });

  test("read of a never-written key throws and names the reason", () => {
    const s = store();
    expect(() => s.get("work", reader("planner"))).toThrow(/never written/);
  });

  test("writes outside an attempt are rejected", () => {
    const s = store();
    expect(() => s.set("work", "x")).toThrow(/outside an attempt/);
  });
});

describe("publish-on-success (OV-1 applied to context)", () => {
  test("failed attempt publishes nothing", () => {
    const s = store();
    s.beginAttempt("intake", 1);
    s.set("work", "the ticket");
    s.endAttempt("failed");
    expect(s.has("work")).toBe(false);
  });

  test("successful attempt publishes with provenance", () => {
    const s = store();
    write(s, "intake", 1, "work", "the ticket");
    expect(s.get("work", reader("planner"))).toBe("the ticket");
    expect(s.provenanceOf("work")).toMatchObject({ node: "intake", visit: 1 });
  });
});

describe("scope: sticky", () => {
  test("persists across writer re-entry, replaced on next success", () => {
    const s = store();
    write(s, "intake", 1, "work", "v1");
    s.beginAttempt("intake", 2); // re-entry: sticky stays visible
    expect(s.get("work", reader("other"))).toBe("v1");
    s.set("work", "v2");
    s.endAttempt("succeeded");
    expect(s.get("work", reader("other"))).toBe("v2");
  });
});

describe("scope: cleared", () => {
  test("veiled during a new attempt, restored if the attempt fails", () => {
    const s = store();
    write(s, "review", 1, "review_verdict", "pass");
    s.beginAttempt("review", 2);
    expect(s.has("review_verdict")).toBe(false);
    expect(() => s.get("review_verdict", reader("router"))).toThrow(/veiled/);
    s.endAttempt("failed");
    // the old answer stands again
    expect(s.get("review_verdict", reader("router"))).toBe("pass");
  });

  test("replaced when the new attempt succeeds", () => {
    const s = store();
    write(s, "review", 1, "review_verdict", "pass");
    s.beginAttempt("review", 2);
    s.set("review_verdict", "reject");
    s.endAttempt("succeeded");
    expect(s.get("review_verdict", reader("router"))).toBe("reject");
  });
});

describe("scope: per-visit", () => {
  test("writer re-entry invalidates permanently; failure does NOT restore", () => {
    const s = store();
    write(s, "probe_pr", 1, "pr.state", "OPEN");
    s.beginAttempt("probe_pr", 2);
    expect(s.has("pr.state")).toBe(false);
    s.endAttempt("failed");
    // unlike cleared: the stale probe never comes back
    expect(s.has("pr.state")).toBe(false);
    expect(() => s.get("pr.state", reader("router"))).toThrow(/invalidated/);
  });

  test("fresh write in the new visit is readable with new provenance", () => {
    const s = store();
    write(s, "probe_pr", 1, "pr.state", "OPEN");
    write(s, "probe_pr", 2, "pr.state", "MERGED");
    expect(s.get("pr.state", reader("router", 2))).toBe("MERGED");
    expect(s.provenanceOf("pr.state")).toMatchObject({ node: "probe_pr", visit: 2 });
  });
});

describe("read tracking (A5.1 context_read)", () => {
  test("reads are recorded with reader, key, and writer provenance", () => {
    const s = store();
    write(s, "intake", 1, "work", "the ticket");
    const mark = s.readCount;
    s.get("work", reader("planner", 1));
    const reads = s.drainReads(mark);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      key: "work",
      by: "planner",
      visit: 1,
      found: true,
      provenance: { node: "intake", visit: 1 },
    });
  });

  test("failed reads are recorded too", () => {
    const s = store();
    const mark = s.readCount;
    expect(() => s.get("work", reader("planner"))).toThrow();
    expect(s.drainReads(mark)[0]).toMatchObject({ key: "work", found: false });
  });
});
