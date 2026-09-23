/**
 * GraphDag's keyboard (HOW-16 P2.10). This was the one component in the app with no
 * accessibility at all: an `onClick` on an SVG `<g>`, reachable by mouse and by nothing else.
 *
 * What is pinned here is the part that is easy to write and easy to get wrong. Only a
 * SELECTABLE node is a focus stop — on the Graphs screen that means agent nodes — so an arrow
 * walk that steps through every node instead dies the moment it meets a command, worktree or
 * wait node, because focusing a `<g>` with no tabIndex is a silent no-op. Every built-in graph
 * interleaves those with its agent nodes, so that is the common case, not an edge one. And the
 * walk follows the LAYOUT, not the order the graph file happens to declare its nodes in: the
 * arrows have to move the way the picture reads.
 *
 * The fixture declares its nodes deliberately out of layout order, so a test that passes by
 * walking the declaration array cannot pass here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraphDag, type GraphShapeDto } from "./graph-dag";

let root: Root | null = null;
let host: HTMLElement | null = null;

/**
 * start(0) → plan(1) → probe(2) → build(3) → review(4). The declaration order is deliberately
 * none of: the layout order, the selectable order, or anything a ±1 over `shape.nodes` would
 * get right — `plan`'s neighbour in the array is the unfocusable `probe`, and the first and
 * last entries are the last-drawn node and an unfocusable one.
 */
const SHAPE: GraphShapeDto = {
  name: "implement-ticket",
  description: "",
  entry: "start",
  nodes: [
    { id: "review", kind: "agent", harness: "claude" },
    { id: "plan", kind: "agent", harness: "claude", model: "opus" },
    { id: "probe", kind: "command", run: "probe:pr" },
    { id: "build", kind: "agent", harness: "codex" },
    { id: "start", kind: "worktree" },
  ],
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "probe" },
    { from: "probe", to: "build" },
    { from: "build", to: "review" },
  ],
};

function render(props: Partial<React.ComponentProps<typeof GraphDag>> = {}): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<GraphDag shape={SHAPE} {...props} />));
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

const node = (el: HTMLElement, id: string) =>
  [...el.querySelectorAll(".dag-node")].find((n) => (n.getAttribute("aria-label") ?? "").split(",")[0]!.endsWith(` node ${id}`)) as SVGGElement;
const focused = () => (document.activeElement?.getAttribute("aria-label") ?? "").split(",")[0]!.replace(/^\w+ node /, "");
const press = (n: SVGGElement, key: string) =>
  act(() => { n.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

describe("GraphDag is reachable without a mouse", () => {
  test("the picture is a list, and only the selectable nodes are focus stops", () => {
    const el = render({ onSelect: () => {} });
    // `svg.dag`, not `svg`: the zoom controls are icon Buttons, so lucide's own <svg>s now
    // come first in the DOM and a bare tag selector picks up a magnifying glass
    expect(el.querySelector("svg.dag")!.getAttribute("role")).toBe("list");
    expect(el.querySelector("svg.dag")!.getAttribute("aria-label")).toContain("5 nodes");
    for (const id of ["plan", "build", "review"]) {
      expect(node(el, id).getAttribute("role")).toBe("button");
      expect(node(el, id).getAttribute("tabindex")).toBe("0");
    }
    for (const id of ["start", "probe"]) {
      expect(node(el, id).getAttribute("role")).toBe("listitem");
      expect(node(el, id).getAttribute("tabindex")).toBeNull();
    }
    // the label is the box read aloud, not the id alone — it is what replaced the native title
    expect(node(el, "plan").getAttribute("aria-label")).toBe("agent node plan, claude · opus");
  });

  test("Enter and Space select, and the selection is spoken as pressed", () => {
    const picked: string[] = [];
    const el = render({ onSelect: (id) => picked.push(id), selected: "plan" });
    expect(node(el, "plan").getAttribute("aria-pressed")).toBe("true");
    expect(node(el, "build").getAttribute("aria-pressed")).toBe("false");
    press(node(el, "build"), "Enter");
    press(node(el, "review"), " ");
    expect(picked).toEqual(["build", "review"]);
    // a node that is not selectable answers neither
    press(node(el, "probe"), "Enter");
    expect(picked).toEqual(["build", "review"]);
  });

  test("the arrows step OVER a node that cannot be focused, instead of dying on it", () => {
    const el = render({ onSelect: () => {} });
    act(() => node(el, "plan").focus());
    expect(focused()).toBe("plan");
    // plan → build crosses `probe`, a command node: walking every node focused a `<g>` with no
    // tabIndex, which does nothing, and the walk ended there
    press(node(el, "plan"), "ArrowDown");
    expect(focused()).toBe("build");
    press(node(el, "build"), "ArrowRight");
    expect(focused()).toBe("review");
    press(node(el, "review"), "ArrowUp");
    expect(focused()).toBe("build");
  });

  test("the walk is in layout order and wraps, whatever order the graph declares its nodes in", () => {
    const el = render({ onSelect: () => {} });
    // `review` is declared FIRST and drawn LAST; Home/End follow the picture
    act(() => node(el, "build").focus());
    press(node(el, "build"), "Home");
    expect(focused()).toBe("plan");
    press(node(el, "plan"), "End");
    expect(focused()).toBe("review");
    // End → ArrowRight lands on the first node rather than nowhere
    press(node(el, "review"), "ArrowRight");
    expect(focused()).toBe("plan");
    press(node(el, "plan"), "ArrowUp");
    expect(focused()).toBe("review");
  });

  test("with no onSelect the graph is a picture: no focus stops, and no key does anything", () => {
    const el = render();
    for (const id of ["plan", "build", "review", "start", "probe"]) {
      expect(node(el, id).getAttribute("tabindex")).toBeNull();
      expect(node(el, id).getAttribute("role")).toBe("listitem");
    }
    press(node(el, "plan"), "ArrowDown"); // must not throw, and must not move focus
    expect(focused()).toBe(""); // nothing in the picture took focus
  });

  test("a canSelect that admits every kind walks every node", () => {
    const el = render({ onSelect: () => {}, canSelect: () => true });
    act(() => node(el, "start").focus());
    press(node(el, "start"), "ArrowDown");
    expect(focused()).toBe("plan");
    press(node(el, "plan"), "ArrowDown");
    expect(focused()).toBe("probe");
  });
});

/**
 * Zoom and pan. The graph used to be a fixed-size SVG in an unbounded box: reachable only
 * because the PAGE scrolled, so once the shell owned the viewport the bottom of a tall graph
 * could not be reached at all. What is pinned here is that scaling changes the rendered size
 * WITHOUT touching the viewBox — the graph has to grow, not reflow — and that the controls
 * are named, since they are icon-only.
 */
describe("the graph canvas can be zoomed and panned", () => {
  const dag = (el: HTMLElement) => el.querySelector("svg.dag") as SVGElement;
  const by = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  const pct = (el: HTMLElement) => el.querySelector(".dag-zoom")!.textContent;

  test("zooming scales the rendered size and leaves the coordinate space alone", () => {
    const el = render();
    const box = dag(el).getAttribute("viewBox");
    const w0 = Number(dag(el).getAttribute("width"));
    expect(pct(el)).toBe("100%");

    act(() => by(el, "Zoom in").click());
    expect(Number(dag(el).getAttribute("width"))).toBeGreaterThan(w0);
    expect(pct(el)).toBe("110%");
    // the graph grows; it must not re-lay-out, or every node moves under the operator
    expect(dag(el).getAttribute("viewBox")).toBe(box);

    act(() => by(el, "Zoom out").click());
    expect(Number(dag(el).getAttribute("width"))).toBe(w0);
    expect(pct(el)).toBe("100%");
  });

  test("zoom clamps at both ends rather than inverting or vanishing", () => {
    const el = render();
    for (let i = 0; i < 30; i++) act(() => by(el, "Zoom out").click());
    expect(pct(el)).toBe("30%");
    expect(by(el, "Zoom out").disabled).toBe(true);
    expect(Number(dag(el).getAttribute("width"))).toBeGreaterThan(0);

    for (let i = 0; i < 40; i++) act(() => by(el, "Zoom in").click());
    expect(pct(el)).toBe("200%");
    expect(by(el, "Zoom in").disabled).toBe(true);
  });

  test("reset returns to 100% from either direction", () => {
    const el = render();
    act(() => by(el, "Zoom in").click());
    act(() => by(el, "Zoom in").click());
    expect(pct(el)).not.toBe("100%");
    act(() => by(el, "Reset zoom to 100%").click());
    expect(pct(el)).toBe("100%");
  });

  test("every control is named, because all four are icon-only", () => {
    const el = render();
    for (const label of ["Zoom out", "Zoom in", "Fit the graph to the pane", "Reset zoom to 100%"])
      expect(by(el, label)).not.toBeNull();
  });

  test("the canvas is a bounded scroller, which is what `overflow: auto` alone never gave it", async () => {
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    const scroll = css.match(/\.dag-scroll\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(scroll).toContain("overflow: auto");
    expect(scroll).toContain("min-height: 0"); // without this it grows to the graph and clips
    expect(scroll).toContain("flex: 1");
    // and its parents have to hand a height down for that to mean anything
    for (const sel of ["\\.dag-view", "\\.run-graph"]) {
      const body = css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toContain("min-height: 0");
    }
  });
});


/**
 * HOW-22, finding 1. This component now draws a DRAFT as well as a run, and a draft is being
 * typed: the builder's Branching pane offers "go to [pick a step]", which stores an edge with
 * an empty target, and re-opening a hand-edited module can name a step that never existed.
 * `pos.get(e.to)!` took the whole app down with it — web/app has no error boundary, so the
 * wizard and the operator's unsaved draft went too. A picture is not a gate.
 */
describe("a half-built shape is drawn, not crashed on", () => {
  /** the fixture with one extra edge, so the count of SURVIVING edges is checkable */
  const withEdge = (e: { from: string; to: string }) => ({ ...SHAPE, edges: [...SHAPE.edges, e] });

  function draw(shape: GraphShapeDto): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<GraphDag shape={shape} />));
    return host;
  }

  const edges = (el: HTMLElement) => el.querySelectorAll(".dag-edge").length;

  test("an edge pointing at no step draws the OTHER edges instead of throwing", () => {
    const el = draw(withEdge({ from: "review", to: "" }));
    // "fixed" must not mean "drew nothing": the four real edges are still there
    expect(edges(el)).toBe(SHAPE.edges.length);
    expect(el.querySelectorAll(".dag-node")).toHaveLength(SHAPE.nodes.length);
  });

  test("an edge STARTING from no step is the same guard, reached by re-opening a hand edit", () => {
    const el = draw(withEdge({ from: "ghost", to: "review" }));
    expect(edges(el)).toBe(SHAPE.edges.length);
  });

  test("a shape with no steps at all still renders", () => {
    const el = draw({ ...SHAPE, nodes: [], edges: [] });
    expect(el.querySelector("svg.dag")).not.toBeNull();
    expect(edges(el)).toBe(0);
  });
});
