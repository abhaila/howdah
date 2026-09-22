/**
 * Authoring a graph from the viewer (D2/D9). The file stays the artifact and `validate()`
 * stays the judge; what these routes add is that the operator never has to leave the UI to
 * get one, and never has to guess why one was refused.
 *
 * The rule the save route exists to keep: what is on disk is always a graph the launcher
 * accepts. A refused save must change nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHowdahServer } from "./server";
import { localGraphPath } from "../graphs/local";

const ROOT = join(import.meta.dir, "..");
const base = mkdtempSync(join(tmpdir(), "howdah-gapi-"));
const server = createHowdahServer({ runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port: 0, repoRoot: ROOT });
const url = (p: string) => `http://localhost:${server.port}${p}`;
const origin = () => `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

const post = (p: string, body?: unknown) =>
  fetch(url(p), { method: "POST", headers: { "content-type": "application/json", origin: origin() }, body: JSON.stringify(body ?? {}) });
const put = (p: string, body: unknown) =>
  fetch(url(p), { method: "PUT", headers: { "content-type": "application/json", origin: origin() }, body: JSON.stringify(body) });

describe("creating a graph from the viewer", () => {
  test("a created graph lands in HOWDAH_HOME and appears in the catalog as local", async () => {
    const r = await post("/api/graphs", { name: "from-ui", kind: "custom" });
    expect(r.status).toBe(201);
    expect((await r.json() as { path: string }).path).toBe(localGraphPath(base, "from-ui"));
    expect(existsSync(join(ROOT, "graphs", "from-ui.ts"))).toBe(false); // never this repo

    const cat = (await (await fetch(url("/api/graphs"))).json()) as { graphs: Array<{ name: string; source: string }> };
    expect(cat.graphs.find((g) => g.name === "from-ui")?.source).toBe("local");
  });

  test("a bad name is refused before anything is written", async () => {
    for (const name of ["Bad", "../escape", "has space", ""]) {
      const r = await post("/api/graphs", { name, kind: "custom" });
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toContain("kebab-case");
    }
    const r = await post("/api/graphs", { name: "fine-name", kind: "../../evil" });
    expect(r.status).toBe(400);
  });

  test("creating the same name twice is refused, not silently overwritten", async () => {
    await post("/api/graphs", { name: "dupe", kind: "custom" });
    const before = readFileSync(localGraphPath(base, "dupe"), "utf8");
    const again = await post("/api/graphs", { name: "dupe", kind: "custom" });
    expect(again.status).toBe(422);
    expect(readFileSync(localGraphPath(base, "dupe"), "utf8")).toBe(before);
  });
});

describe("editing a graph from the viewer", () => {
  test("source round-trips, and a good edit is kept", async () => {
    await post("/api/graphs", { name: "editable", kind: "custom" });
    const got = (await (await fetch(url("/api/graphs/editable/source"))).json()) as { source: string };
    expect(got.source).toContain('name: "editable"');

    const edited = got.source.replace('description: "TODO: one line on what this graph does"', 'description: "edited in the browser"');
    expect((await put("/api/graphs/editable/source", { source: edited })).status).toBe(200);

    // the change is visible to the launcher immediately, with no viewer restart
    const cat = (await (await fetch(url("/api/graphs"))).json()) as { graphs: Array<{ name: string; description: string }> };
    expect(cat.graphs.find((g) => g.name === "editable")?.description).toBe("edited in the browser");
  });

  test("a save that would break the graph is refused AND changes nothing on disk", async () => {
    await post("/api/graphs", { name: "guarded", kind: "custom" });
    const path = localGraphPath(base, "guarded");
    const original = readFileSync(path, "utf8");

    const broken = original.replace(/edges: \[[^\]]*\]/, "edges: []");
    const r = await put("/api/graphs/guarded/source", { source: broken });
    expect(r.status).toBe(422);
    expect((await r.json() as { error: string }).error).toMatch(/dead end|no outgoing edge/);
    expect(readFileSync(path, "utf8")).toBe(original);

    // and the graph is still runnable afterwards, not stuck in a broken state
    const cat = (await (await fetch(url("/api/graphs"))).json()) as { graphs: Array<{ name: string }>; problems: unknown[] };
    expect(cat.graphs.some((g) => g.name === "guarded")).toBe(true);
    expect(cat.problems).toEqual([]);
  });

  test("a built-in graph has no editable source", async () => {
    const r = await fetch(url("/api/graphs/write-doc/source"));
    expect(r.status).toBe(404);
    expect((await r.json() as { error: string }).error).toContain("built-in");
  });

  test("a name that is not kebab-case is refused before any path is built", async () => {
    // `..` and `%2e%2e` never reach this route at all: both normalise to `/api/source`, which
    // is not a route, so no path is ever built from them. The cases that matter are the ones
    // that DO arrive as one segment, and every one of them is refused before any file access.
    for (const name of ["Bad", "..%2F..%2Fetc", "has%20space", "etc%2Fpasswd"]) {
      const r = await fetch(url(`/api/graphs/${name}/source`));
      expect(r.status).toBe(400);
      expect((await r.json() as { error: string }).error).toContain("not a local graph");
    }
  });
});

describe("the deeper gate and deletion", () => {
  test("typecheck passes on a fresh scaffold and reports real type errors", async () => {
    await post("/api/graphs", { name: "checked-api", kind: "custom" });
    const clean = (await (await post("/api/graphs/checked-api/typecheck")).json()) as { ok: boolean };
    expect(clean.ok).toBe(true);

    // a type error that save cannot see: it loads and validates perfectly well
    const path = localGraphPath(base, "checked-api");
    writeFileSync(path, readFileSync(path, "utf8").replace('inputs: ["goal"]', 'inputs: ["goal"], maxSteps: "nope" as any'));
    const bad = (await (await post("/api/graphs/checked-api/typecheck")).json()) as { ok: boolean; diagnostics: string[] };
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.join("\n")).toContain("maxSteps");
  }, 60_000);

  test("only a local graph can be deleted", async () => {
    await post("/api/graphs", { name: "goner", kind: "custom" });
    const del = (p: string) => fetch(url(p), { method: "DELETE", headers: { origin: origin() } });
    expect((await del("/api/graphs/write-doc")).status).toBe(400);
    expect((await del("/api/graphs/goner")).status).toBe(200);
    expect(existsSync(localGraphPath(base, "goner"))).toBe(false);
  });
});

/**
 * HOW-22: the builder's save route. It carries the same promise as the source route — a
 * refused save changes nothing — over one more kind of file, and it is also how a graph is
 * created, so the built-in collision has to be answered before anything is written.
 */
describe("saving a graph built in the viewer", () => {
  const spec = (name: string, over: Record<string, unknown> = {}) => ({
    version: 1,
    name,
    description: "built in the browser",
    fields: [
      { key: "goal", kind: "text", scope: "sticky" },
      { key: "summary", kind: "text", scope: "sticky" },
    ],
    inputs: ["goal"],
    entry: "draft",
    nodes: [
      { id: "draft", kind: "agent", title: "Draft it", prompt: `${name}.draft`, reads: [], writes: ["summary"] },
      { id: "done", kind: "terminal", outcome: "success" },
    ],
    edges: [{ from: "draft", to: "done" }],
    ...over,
  });
  const prompts = (name: string, body = "Write it. Goal: {{ context.goal }}") => ({ [`${name}.draft`]: body });

  test("a built graph is created, listed as local, and says the builder can re-open it", async () => {
    const r = await put("/api/graphs/built-here/builder", { spec: spec("built-here"), prompts: prompts("built-here") });
    expect(r.status).toBe(201);
    expect(existsSync(localGraphPath(base, "built-here"))).toBe(true);

    const cat = (await (await fetch(url("/api/graphs"))).json()) as { graphs: Array<{ name: string; source: string; kind: string; builder: boolean }> };
    const entry = cat.graphs.find((g) => g.name === "built-here")!;
    expect(entry.source).toBe("local");
    expect(entry.kind).toBe("plain");
    expect(entry.builder).toBe(true);
  });

  test("the spec comes back out of the shape route exactly as it went in, bar derived reads", async () => {
    await put("/api/graphs/round-trip/builder", { spec: spec("round-trip"), prompts: prompts("round-trip") });
    const shape = (await (await fetch(url("/api/graphs/round-trip"))).json()) as { builder: boolean; spec: { nodes: Array<Record<string, unknown>> } };
    expect(shape.builder).toBe(true);
    // `reads` is DERIVED server-side from the prompt body, which asks for goal
    expect(shape.spec.nodes[0]!.reads).toEqual(["goal"]);
    expect(shape.spec.nodes[0]!.title).toBe("Draft it");
  });

  test("saving it again updates rather than creating, and the change is live at once", async () => {
    await put("/api/graphs/updatable/builder", { spec: spec("updatable"), prompts: prompts("updatable") });
    const again = await put("/api/graphs/updatable/builder", {
      spec: spec("updatable", { description: "second thoughts" }),
      prompts: prompts("updatable"),
    });
    expect(again.status).toBe(200);
    const cat = (await (await fetch(url("/api/graphs"))).json()) as { graphs: Array<{ name: string; description: string }> };
    expect(cat.graphs.find((g) => g.name === "updatable")?.description).toBe("second thoughts");
  });

  test("a name a built-in already owns is refused BEFORE anything is written", async () => {
    const r = await put("/api/graphs/write-doc/builder", { spec: spec("write-doc"), prompts: prompts("write-doc") });
    expect(r.status).toBe(409);
    expect((await r.json() as { error: string }).error).toContain("Howdah's own graphs");
    expect(existsSync(localGraphPath(base, "write-doc"))).toBe(false);
  });

  test("a spec the server cannot vouch for is refused, not written", async () => {
    for (const bad of [
      { spec: { ...spec("nope"), version: 9 } },
      { spec: { ...spec("nope"), nodes: [{ id: "x", kind: "agent", prompt: "../../etc/passwd" }] } },
      { spec: "not even an object" },
    ]) {
      const r = await put("/api/graphs/nope/builder", { ...bad, prompts: {} });
      expect(r.status).toBe(400);
    }
    // and the path and the spec have to agree about the name
    const mismatch = await put("/api/graphs/one-name/builder", { spec: spec("another-name"), prompts: {} });
    expect(mismatch.status).toBe(400);
    expect(existsSync(localGraphPath(base, "one-name"))).toBe(false);
  });

  test("a save that fails the gate leaves the graph AND its prompts at the last good version", async () => {
    await put("/api/graphs/kept/builder", { spec: spec("kept"), prompts: prompts("kept") });
    const graphBytes = readFileSync(localGraphPath(base, "kept"), "utf8");
    const promptPath = join(base, "prompts", "kept.draft.md");
    const promptBytes = readFileSync(promptPath, "utf8");

    const r = await put("/api/graphs/kept/builder", {
      spec: spec("kept", { edges: [] }),                       // a dead end: validate() refuses
      prompts: prompts("kept", "REWRITTEN — must not survive"),
    });
    expect(r.status).toBe(422);
    expect((await r.json() as { error: string }).error).toMatch(/nowhere|dead end|no outgoing edge/);
    expect(readFileSync(localGraphPath(base, "kept"), "utf8")).toBe(graphBytes);
    expect(readFileSync(promptPath, "utf8")).toBe(promptBytes);
  });

  test("the builder save never runs tsc — the compiler is not in this loop", async () => {
    // the typecheck route is the only tsc path, and it is a POST nobody makes here; what
    // this asserts is that a save is fast enough to be one, and that it gated anyway
    const started = Date.now();
    const r = await put("/api/graphs/no-tsc/builder", { spec: spec("no-tsc"), prompts: prompts("no-tsc") });
    expect(r.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(5000); // a tsc pass on this repo is far slower
  });

  test("a step's instructions can be read back for editing, and nothing outside HOWDAH_HOME can", async () => {
    await put("/api/graphs/readable/builder", { spec: spec("readable"), prompts: prompts("readable", "Body one") });
    const got = (await (await fetch(url("/api/local-prompts/readable.draft"))).json()) as { body: string };
    expect(got.body).toBe("Body one");
    expect((await fetch(url("/api/local-prompts/delivery.publish"))).status).toBe(404); // a repo prompt is not local
    expect((await fetch(url("/api/local-prompts/Not%20An%20Id"))).status).toBe(400);
  });

  test("tuning accepts a built graph's step ids like any other graph's", async () => {
    await put("/api/graphs/tunable/builder", { spec: spec("tunable"), prompts: prompts("tunable") });
    expect((await put("/api/graphs/tunable/tuning", { nodes: { draft: { harness: "codex" } } })).status).toBe(200);
    expect((await put("/api/graphs/tunable/tuning", { nodes: { nosuch: { harness: "codex" } } })).status).toBe(400);
  });

  test("a hand-written local graph reads as builder:false, and keeps its source editor", async () => {
    await post("/api/graphs", { name: "hand-written", kind: "custom" });
    const shape = (await (await fetch(url("/api/graphs/hand-written"))).json()) as { builder: boolean; spec: unknown };
    expect(shape.builder).toBe(false);
    expect(shape.spec).toBeNull();
    expect((await fetch(url("/api/graphs/hand-written/source"))).status).toBe(200);
  });
});
