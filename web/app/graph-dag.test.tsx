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
    expect(el.querySelector("svg")!.getAttribute("role")).toBe("list");
    expect(el.querySelector("svg")!.getAttribute("aria-label")).toContain("5 nodes");
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
