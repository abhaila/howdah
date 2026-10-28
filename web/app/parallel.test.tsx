/**
 * HOW-73 — the run view and the builder over a parallel step. The Steps pane draws the branches
 * of one visit as one block of concurrent rows; the DAG draws the fork and the join and puts the
 * branches in one layer (web/app/lib/layout.ts, the ONE placement); and the builder OPENS a
 * parallel graph and draws it without crashing — editing one there is deferred, and the panel
 * says so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { RunSteps } from "./run/steps";
import { GraphDag, type GraphShapeDto } from "./graph-dag";
import { layout } from "./lib/layout";
import { specToFlow } from "./builder/canvas";
import { GraphBuilder } from "./screens/graph-builder";
import { ToastProvider } from "./components/ui/toast";
import { PARALLEL_REVIEW_SPEC, parallelReview } from "../../engine/fixtures/parallel-review";
import type { GraphSpec } from "../../core/graph-spec";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

function mountInto(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

const BRANCHES = ["review_security", "review_tests", "review_ux"];

/** the shape the server's graph API serves for the fixture (web/server.ts: flowEdges) */
function dagShape(): GraphShapeDto {
  const g = parallelReview();
  return {
    name: g.def.name, description: "", entry: g.def.entry,
    nodes: Object.entries(g.def.nodes).map(([id, n]) => ({
      id, kind: n.kind,
      ...(n.kind === "parallel" ? { branches: [...n.branches], join: n.join } : {}),
    })),
    edges: g.flowEdges().map((e) => ({ from: e.from, to: e.to, ...(e.kind ? { kind: e.kind } : {}) })),
  };
}

describe("Steps: concurrent rows", () => {
  test("the branches of one visit are one grouped block, each row with its own state", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "parallel-review", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-started", node: "fan", visit: 1, attempt_id: "fan#1" });
    for (const b of BRANCHES) log.add({ type: "node-started", node: b, visit: 1, attempt_id: `${b}#1`, parallel: { node: "fan", visit: 1 } });
    log.add({ type: "node-finished", node: "review_security", visit: 1, status: "succeeded", writes: {} });
    const detail = deriveDetail("r", log.events, {}, { runnerAlive: true });
    const el = mountInto(<RunSteps timeline={detail.timeline} ask={detail.ask} selected={null} now={new Date(log.last.ts).getTime()} onSelect={() => {}} />);
    const group = el.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("fan@1 — 3 steps at once");
    const rows = [...group.querySelectorAll(".step-row")];
    expect(rows.map((r) => r.getAttribute("aria-label")?.split(" — ")[0])).toEqual(BRANCHES.map((b) => `${b}@1`));
    expect(rows.map((r) => r.classList.contains("branch"))).toEqual([true, true, true]);
    expect(rows[0]!.classList.contains("succeeded")).toBe(true);
    expect(rows[1]!.classList.contains("running")).toBe(true);
    // the parallel step's own row sits outside the block
    expect(el.querySelector('.step-row[aria-label^="fan@1"]')!.closest('[role="group"]')).toBeNull();
  });
});

describe("GraphDag: fork and join", () => {
  test("the fork and join edges are drawn, dashed, and the branches share one layer", () => {
    const shape = dagShape();
    const el = mountInto(<GraphDag shape={shape} />);
    expect(el.querySelectorAll('[data-edge-kind="fork"]')).toHaveLength(3);
    expect(el.querySelectorAll('[data-edge-kind="join"]')).toHaveLength(3);
    for (const p of el.querySelectorAll("[data-edge-kind]")) expect(p.getAttribute("stroke-dasharray")).toBe("4 3");
    const pos = layout(shape);
    const ys = BRANCHES.map((b) => pos.get(b)!.y);
    expect(new Set(ys).size).toBe(1);
    expect(pos.get("done")!.y).toBeGreaterThan(ys[0]!);
    expect(pos.get("fan")!.y).toBeLessThan(ys[0]!);
    expect(el.querySelector('[aria-label^="parallel node fan"]')!.getAttribute("aria-label")).toContain("parallel · 3 at once");
  });
});

/** a builder-owned copy of the fixture spec: a builder graph's prompts are `<graph>.<step>` */
const OWNED: GraphSpec = {
  ...PARALLEL_REVIEW_SPEC,
  nodes: PARALLEL_REVIEW_SPEC.nodes.map((n) => (n.kind === "agent" ? { ...n, prompt: `${PARALLEL_REVIEW_SPEC.name}.${n.id}` } : n)),
};

describe("builder: a parallel graph opens and draws", () => {
  test("specToFlow draws the implied fork/join wires, none of them selectable or deletable", () => {
    const flow = specToFlow(OWNED, [], () => {});
    const implied = flow.edges.filter((e) => /^(fork|join)/.test(e.id));
    expect(implied).toHaveLength(6);
    for (const e of implied) expect(e).toMatchObject({ deletable: false, selectable: false });
    expect(flow.nodes.find((n) => n.id === "fan")?.data).toMatchObject({ kind: "parallel" });
  });

  test("the builder opens a saved parallel graph without crashing, and the panel says editing is deferred", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const body = url === "/api/graphs" ? { graphs: [{ name: "parallel-review" }], problems: [] }
        : url === "/api/graphs/parallel-review" ? { spec: OWNED, builder: true }
        : url.startsWith("/api/local-prompts/") ? { body: "Review {{ context.summary }} for {{ context.goal }}." }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ToastProvider><GraphBuilder name="parallel-review" /></ToastProvider>); });
    await act(async () => { await Bun.sleep(20); });
    const kinds = [...host.querySelectorAll("[data-testid=gb-node]")].map((n) => (n as HTMLElement).dataset.kind);
    expect(kinds).toContain("parallel");
    const open = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Edit fan"));
    expect(open).toBeDefined();
    act(() => open!.click());
    expect(host.textContent).toContain("is not supported here yet");
    expect(host.textContent).toContain("runs review_security, review_tests, review_ux at once");
  });
});
