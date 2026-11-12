/**
 * GraphDag: the read-only picture of a graph (HOW-16 P2.10, HOW-22, HOW-65; on React Flow and a
 * real layered layout since HOW-68).
 *
 * WHY MOST OF THE ASSERTIONS HERE WERE REWRITTEN (HOW-68). The picture used to be one hand-drawn
 * `<svg class="dag" role="list">` whose nodes were `<g class="dag-node">`, zoomed by scaling the
 * SVG's width against a fixed viewBox, and the old tests read exactly those internals. It is a
 * React Flow canvas now, so there is no SVG root, no viewBox and no `<g>` to ask. What each test
 * was FOR is kept, and is asked of what the operator can reach instead:
 *
 *   - it is reachable without a mouse: one tab stop, arrows that walk in LAYOUT order and wrap,
 *     Enter/Space that select — and only on a step that can be selected;
 *   - every control is named;
 *   - a half-built shape is drawn, not crashed on (now a property of the pure `dagFlow`);
 *   - a removed step and the highlighted one are marked;
 *   - a card prints the part of an id that tells steps apart — WHOLE now, never cut in the middle.
 *
 * One expectation changed on purpose: every step is in the arrow walk, where only the selectable
 * ones used to be. A step you cannot act on still has a tooltip to read, and focus is how a
 * keyboard reads one; the old walk skipped them because focusing an SVG `<g>` with no tabIndex
 * was a silent no-op, which is not a reason any more.
 *
 * The fixture declares its nodes deliberately out of layout order, so a test that passes by
 * walking the declaration array cannot pass here.
 *
 * What a DOM without layout cannot see — the pan, the wheel, the tooltip's position, the minimap
 * — is driven in a real browser by tools/visual (shoot.mjs `feedback-*` steps).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraphDag, dagFlow, nameOf, openingView, revealBox, sharedGroupOf, wrapName, type GraphShapeDto } from "./graph-dag";
import { dagLayout } from "./lib/dag-layout";
import { allShortcuts } from "./lib/shortcuts";

let root: Root | null = null;
let host: HTMLElement | null = null;

/**
 * start(0) → plan(1) → probe(2) → build(3) → review(4). The declaration order is deliberately
 * none of: the layout order, the selectable order, or anything a ±1 over `shape.nodes` would
 * get right.
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

const node = (el: HTMLElement, id: string) => el.querySelector(`[data-dag-step="${id}"]`) as HTMLElement;
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.dagStep ?? "";
const press = (n: HTMLElement, key: string) =>
  act(() => { n.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

describe("GraphDag is reachable without a mouse", () => {
  test("the picture is a named region; a selectable step is a button, the rest are read-only stops", () => {
    const el = render({ onSelect: () => {} });
    const region = el.querySelector('[role="region"]')!;
    expect(region.getAttribute("aria-label")).toContain("implement-ticket graph — 5 steps");
    expect(region.getAttribute("tabindex")).toBe("0");
    for (const id of ["plan", "build", "review"]) expect(node(el, id).tagName).toBe("BUTTON");
    for (const id of ["start", "probe"]) {
      expect(node(el, id).tagName).toBe("DIV");
      expect(node(el, id).getAttribute("role")).toBe("group");
    }
    // the label is the card read aloud, not the id alone
    expect(node(el, "plan").getAttribute("aria-label")).toBe("agent node plan, claude · opus");
    expect(node(el, "probe").getAttribute("aria-label")).toBe("command node probe, probe:pr");
  });

  test("the steps are ONE tab stop — a roving tabindex, starting at the entry", () => {
    const el = render({ onSelect: () => {} });
    const stops = [...el.querySelectorAll<HTMLElement>("[data-dag-step]")];
    expect(stops.filter((s) => s.tabIndex === 0).map((s) => s.dataset.dagStep)).toEqual(["start"]);
    expect(stops.filter((s) => s.tabIndex === -1)).toHaveLength(4);
    // ...and it follows where the operator goes
    act(() => node(el, "build").focus());
    expect(stops.filter((s) => s.tabIndex === 0).map((s) => s.dataset.dagStep)).toEqual(["build"]);
  });

  test("a run's picture starts its tab stop on the step the run is on", () => {
    const el = render({ current: "build" });
    expect(node(el, "build").tabIndex).toBe(0);
    expect(node(el, "start").tabIndex).toBe(-1);
  });

  test("Enter and Space select (a real button's click), and the selection is spoken as pressed", () => {
    const picked: string[] = [];
    const el = render({ onSelect: (id) => picked.push(id), selected: "plan" });
    expect(node(el, "plan").getAttribute("aria-pressed")).toBe("true");
    expect(node(el, "build").getAttribute("aria-pressed")).toBe("false");
    // Enter and Space on a <button> ARE a click; the platform does that, so the click is what is sent
    act(() => node(el, "build").click());
    act(() => node(el, "review").click());
    expect(picked).toEqual(["build", "review"]);
    // a step that is not selectable answers neither: it is not a control at all
    act(() => node(el, "probe").click());
    press(node(el, "probe"), "Enter");
    expect(picked).toEqual(["build", "review"]);
    expect(node(el, "probe").hasAttribute("aria-pressed")).toBe(false);
  });

  test("the arrows walk EVERY step in layout order, whatever order the graph declares them in", () => {
    const el = render({ onSelect: () => {} });
    act(() => node(el, "plan").focus());
    expect(focused()).toBe("plan");
    press(node(el, "plan"), "ArrowDown");
    expect(focused()).toBe("probe"); // a command step: read-only, and still a stop (its tooltip)
    press(node(el, "probe"), "ArrowRight");
    expect(focused()).toBe("build");
    press(node(el, "build"), "ArrowUp");
    expect(focused()).toBe("probe");
  });

  test("Home and End follow the picture, and the walk wraps", () => {
    const el = render({ onSelect: () => {} });
    // `review` is declared FIRST and drawn LAST
    act(() => node(el, "build").focus());
    press(node(el, "build"), "Home");
    expect(focused()).toBe("start");
    press(node(el, "start"), "End");
    expect(focused()).toBe("review");
    // End → ArrowRight lands on the first step rather than nowhere
    press(node(el, "review"), "ArrowRight");
    expect(focused()).toBe("start");
    press(node(el, "start"), "ArrowUp");
    expect(focused()).toBe("review");
  });

  test("with no onSelect nothing is a button, and the steps can still be walked and read", () => {
    const el = render();
    expect(el.querySelectorAll("button[data-dag-step]")).toHaveLength(0);
    act(() => node(el, "start").focus());
    press(node(el, "start"), "ArrowDown");
    expect(focused()).toBe("plan");
  });

  test("a canSelect that admits every kind makes every step a button", () => {
    const el = render({ onSelect: () => {}, canSelect: () => true });
    expect(el.querySelectorAll("button[data-dag-step]")).toHaveLength(5);
  });

  test("a modified arrow is left alone: ⌘← is the browser's, not a walk", () => {
    const el = render();
    act(() => node(el, "plan").focus());
    act(() => { node(el, "plan").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, bubbles: true, cancelable: true })); });
    expect(focused()).toBe("plan");
  });
});

describe("the canvas pans and zooms, and says how", () => {
  const by = (el: HTMLElement, label: string) => el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;

  test("every control is present and named, because three of the four are icon-only", () => {
    const el = render();
    for (const label of ["Zoom out", "Zoom in", "Show the whole graph"]) expect(by(el, label)).not.toBeNull();
    // the percentage is a control too: it goes back to 100%
    const reset = [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes("back to 100%"));
    expect(reset?.textContent).toBe("100%");
    // none of them is a native `title=` tooltip
    expect(el.querySelector(".dag-view [title]")).toBeNull();
  });

  test("the picture opens at 100%, never fitted: text that cannot be read is not shown by default", () => {
    const el = render();
    const reset = [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes("back to 100%"))!;
    expect(reset.getAttribute("aria-label")).toBe("Zoom 100% — back to 100%");
    expect(openingView({ width: 4000, height: 3000 }, { width: 900, height: 600 }, undefined).zoom).toBe(1);
  });

  test("the opening view centres a graph that fits and keeps the focused step in view when it does not", () => {
    // fits on both axes: centred
    expect(openingView({ width: 400, height: 300 }, { width: 1000, height: 700 }, undefined)).toEqual({ x: 300, y: 200, zoom: 1 });
    // too tall: the step the run is on (y 2000) is brought to the middle of the pane
    const v = openingView({ width: 400, height: 3000 }, { width: 1000, height: 700 }, { x: 80, y: 2000, width: 248, height: 52 });
    expect(v.x).toBe(300);
    expect(2000 + 26 + v.y).toBe(350);
    // ...but never past the end of the graph
    const end = openingView({ width: 400, height: 3000 }, { width: 1000, height: 700 }, { x: 80, y: 2990, width: 248, height: 52 });
    expect(end.y).toBeGreaterThanOrEqual(700 - 3000 - 28);
    // an unmeasured pane is not reasoned about
    expect(openingView({ width: 400, height: 300 }, { width: 0, height: 0 }, undefined).zoom).toBe(1);
  });

  test("a step walked to is panned into view by the least that shows it, at the zoom in use", () => {
    const pane = { width: 800, height: 600 };
    const box = { x: 100, y: 100, width: 248, height: 52 };
    expect(revealBox({ x: 0, y: 0, zoom: 1 }, pane, box)).toBeNull(); // already in view
    expect(revealBox({ x: 0, y: -400, zoom: 1 }, pane, box)).toEqual({ x: 0, y: -72, zoom: 1 }); // above: down to the padding
    const below = revealBox({ x: 0, y: 0, zoom: 1 }, pane, { ...box, y: 900 })!;
    expect(900 + 52 + below.y).toBe(600 - 28);
    expect(revealBox({ x: 0, y: 0, zoom: 0.5 }, pane, { ...box, y: 2000 })!.zoom).toBe(0.5); // never a zoom
    expect(revealBox({ x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 }, box)).toBeNull();
  });

  test("the pan and zoom keys are rows in the one registry, so `?` lists them", () => {
    render();
    const rows = allShortcuts().filter((s) => s.scope === "A graph");
    expect(rows.map((s) => s.id).sort()).toEqual(["graph.fit", "graph.pan", "graph.walk", "graph.zoom-in", "graph.zoom-out"]);
    // listed, and handled where focus is — the registry must not also fire them
    expect(rows.every((s) => s.passive === true)).toBe(true);
  });

  test("the hint says which way the wheel goes: it zooms where the canvas is the pane, and needs a modifier on a page that scrolls", () => {
    expect(render().querySelector(".dag-hint")!.textContent).toContain("scroll to zoom");
    act(() => root!.unmount());
    host!.remove();
    expect(render({ wheel: "page" }).querySelector(".dag-hint")!.textContent).toContain("Ctrl + scroll to zoom");
  });

  test("the canvas is a bounded box its parents hand a height to, not a scroller", async () => {
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    const canvas = css.match(/\.dag-canvas\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(canvas).toContain("flex: 1");
    expect(canvas).toContain("min-height: 0"); // without this it grows to its content and is clipped
    expect(canvas).not.toContain("overflow"); // it pans; nothing is hidden by a layout rule
    for (const sel of ["\\.dag-view", "\\.run-graph"]) {
      const body = css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(body).toContain("min-height: 0");
    }
    // React Flow turns a read-only node's pointer events off; the card must take them back, or
    // it can be neither hovered for its tooltip nor pressed
    expect(css.match(/\.gb-node\.dag-card\s*\{([^}]*)\}/)?.[1] ?? "").toContain("pointer-events: auto");
  });
});

describe("the tooltip carries everything the card cannot print", () => {
  const open = async (el: HTMLElement, id: string) => {
    // focus is one of the two ways in (hover is the other); the primitive opens on both
    await act(async () => { node(el, id).focus(); await Bun.sleep(30); });
    return document.querySelector('[role="tooltip"]')?.textContent ?? "";
  };

  test("the full id, the kind in words, and what it runs on", async () => {
    const tip = await open(render(), "plan");
    expect(tip).toContain("plan");
    expect(tip).toContain("Ask an agent");
    expect(tip).toContain("claude · opus");
    // a graph that is not a run says nothing about visits
    expect(tip).not.toContain("not reached");
  });

  test("in a run: visits, time spent and how the latest visit stands", async () => {
    const el = render({ current: "build", visits: { plan: 2, build: 1 }, info: { plan: { took: "4m 38s", state: "done" }, build: { state: "running" } } });
    const tip = await open(el, "plan");
    expect(tip).toContain("2 visits · 4m 38s · done");
    expect(node(el, "plan").querySelector(".dag-visits")!.textContent).toBe("×2");
    // the trigger is tied to the tooltip while it is open
    expect(node(el, "plan").closest("[data-slot='tooltip-trigger']")!.getAttribute("aria-describedby")).toBe(document.querySelector('[role="tooltip"]')!.id);
  });

  test("a step the run has not got to says so; the one it is parked on says it is waiting on you", async () => {
    const el = render({ current: "build", waiting: true, visits: { build: 1 }, info: { build: { state: "running" } } });
    expect(await open(el, "review")).toContain("not reached");
    await act(async () => { node(el, "review").blur(); await Bun.sleep(10); });
    expect(await open(el, "build")).toContain("1 visit · waiting on you");
  });

  test("a builder's title leads, with the id it stands in for; a tuned step says it has its own settings", async () => {
    const shape: GraphShapeDto = { ...SHAPE, nodes: SHAPE.nodes.map((n) => (n.id === "plan" ? { ...n, title: "Write the plan", node_tuning: { model: "opus" }, maxVisits: 3 } : n)) };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<GraphDag shape={shape} />));
    expect(node(host, "plan").getAttribute("aria-label")).toBe("agent step Write the plan, id plan, claude · opus, has a node override");
    expect(node(host, "plan").querySelector(".dag-name")!.textContent).toBe("Write the plan");
    const tip = await open(host, "plan");
    expect(tip).toContain("Write the plan");
    expect(tip).toContain("has its own settings");
    expect(tip).toContain("at most 3 visits");
  });
});

describe("the step a run is on is marked, and amber is said once", () => {
  test("running: the accent outline and the running glyph, no amber", () => {
    const el = render({ current: "build" });
    expect(node(el, "build").classList.contains("current")).toBe(true);
    expect(el.querySelectorAll(".dag-card.waiting")).toHaveLength(0);
    expect(node(el, "build").getAttribute("aria-label")).toContain("current");
    expect(node(el, "build").querySelector("svg[data-shape]")).not.toBeNull();
  });

  test("parked waiting on you: exactly one card carries `waiting`", () => {
    const el = render({ current: "build", waiting: true });
    expect([...el.querySelectorAll<HTMLElement>(".dag-card.waiting")].map((c) => c.dataset.dagStep)).toEqual(["build"]);
    expect(node(el, "build").getAttribute("aria-label")).toContain("current, waiting on you");
  });

  test("the entry carries the builder's Start tab, so the two pictures agree on where a run begins", () => {
    const el = render();
    expect(node(el, "start").querySelector(".gb-node-entry")!.textContent).toBe("Start");
    expect(el.querySelectorAll(".gb-node-entry")).toHaveLength(1);
  });
});

/**
 * HOW-22, finding 1. This component draws a DRAFT as well as a run, and a draft is being typed:
 * the builder offers "go to [pick a step]", which stores an edge with an empty target, and
 * re-opening a hand-edited module can name a step that never existed. `pos.get(e.to)!` took the
 * whole app down with it — web/app has no error boundary. A picture is not a gate.
 *
 * (HOW-68: the surviving edges are counted on `dagFlow`, the pure function the canvas draws from,
 * as well as in the DOM — the wires are still one SVG this component writes.)
 */
describe("a half-built shape is drawn, not crashed on", () => {
  const withEdge = (e: { from: string; to: string }) => ({ ...SHAPE, edges: [...SHAPE.edges, e] });

  function draw(shape: GraphShapeDto): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<GraphDag shape={shape} />));
    return host;
  }

  test("an edge pointing at no step draws the OTHER edges instead of throwing", () => {
    const shape = withEdge({ from: "review", to: "" });
    // "fixed" must not mean "drew nothing": the four real edges are still there
    expect(dagFlow(shape).wires.map((w) => w.index)).toEqual([0, 1, 2, 3]);
    const el = draw(shape);
    expect(el.querySelectorAll(".dag-wire")).toHaveLength(SHAPE.edges.length);
    expect(el.querySelectorAll("[data-dag-step]")).toHaveLength(SHAPE.nodes.length);
  });

  test("an edge STARTING from no step is the same guard, reached by re-opening a hand edit", () => {
    const shape = withEdge({ from: "ghost", to: "review" });
    expect(dagFlow(shape).wires).toHaveLength(SHAPE.edges.length);
    expect(draw(shape).querySelectorAll(".dag-wire")).toHaveLength(SHAPE.edges.length);
  });

  test("the layout itself skips it: the slot is null, never a guess", () => {
    const laid = dagLayout("a", [{ id: "a", width: 100, height: 40 }, { id: "b", width: 100, height: 40 }], [{ from: "a", to: "b" }, { from: "a", to: "nowhere" }, { from: "", to: "b" }]);
    expect(laid.edges.map((e) => e !== null)).toEqual([true, false, false]);
    expect(laid.nodes.size).toBe(2);
  });

  test("a shape with no steps at all still renders, and so does one whose entry does not exist", () => {
    expect(dagFlow({ ...SHAPE, nodes: [], edges: [] })).toMatchObject({ cards: [], wires: [] });
    const el = draw({ ...SHAPE, nodes: [], edges: [] });
    expect(el.querySelector('[role="region"]')).not.toBeNull();
    expect(el.querySelectorAll(".dag-wire")).toHaveLength(0);
    act(() => root!.unmount());
    host!.remove();
    expect(draw({ ...SHAPE, entry: "gone" }).querySelectorAll("[data-dag-step]")).toHaveLength(SHAPE.nodes.length);
  });

  test("a step routed to itself, and two steps routed both ways, are laid out rather than refused", () => {
    const flow = dagFlow({ ...SHAPE, edges: [...SHAPE.edges, { from: "build", to: "build", label: "again" }, { from: "review", to: "build", label: "review_verdict == 'reject'" }] });
    expect(flow.wires).toHaveLength(6);
    expect(flow.wires.find((w) => w.from === "review" && w.to === "build")!.back).toBe(true);
    for (const w of flow.wires) expect(w.path).not.toContain("NaN");
  });
});

describe("the layout is a real layered one", () => {
  const flow = dagFlow({
    ...SHAPE,
    edges: [...SHAPE.edges, { from: "review", to: "build", label: "review_verdict == 'reject'" }],
  });
  const box = (id: string) => flow.cards.find((c) => c.node.id === id)!.box;

  test("the entry is at the top and each step is below the one that leads to it", () => {
    for (const [a, b] of [["start", "plan"], ["plan", "probe"], ["probe", "build"], ["build", "review"]] as const)
      expect(box(b).y).toBeGreaterThanOrEqual(box(a).y + box(a).height);
  });

  test("no two cards overlap, and no caption sits on a card", () => {
    const boxes = flow.cards.map((c) => c.box);
    const hit = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i]!, boxes[j]!)).toBe(false);
    for (const w of flow.wires) {
      if (!w.caption) continue;
      const cap = { x: w.caption.x - w.caption.width / 2, y: w.caption.y - 11, width: w.caption.width, height: 22 };
      for (const b of boxes) expect(hit(cap, b)).toBe(false);
    }
  });

  test("the loop back is the edge that returns, and it is the only one marked so", () => {
    expect(flow.wires.filter((w) => w.back).map((w) => `${w.from}→${w.to}`)).toEqual(["review→build"]);
  });

  test("a fallback beside a condition is captioned `otherwise`; a lone route is not captioned at all", () => {
    const branch = dagFlow({ ...SHAPE, edges: [...SHAPE.edges, { from: "build", to: "plan", label: "tests == 'fail'" }] });
    const fromBuild = branch.wires.filter((w) => w.from === "build");
    expect(fromBuild.map((w) => w.caption?.text).sort()).toEqual(["otherwise", "tests == 'fail'"]);
    expect(fromBuild.find((w) => w.caption?.otherwise)!.to).toBe("review");
    expect(branch.wires.find((w) => w.from === "start")!.caption).toBeUndefined();
  });

  test("a long condition is drawn in full in the DOM (a Truncate shows the rest on hover and focus)", () => {
    const long = "slice.approval == 'approved' && map.drift.count == 0 && verify.result == 'pass'";
    const shape = { ...SHAPE, edges: [...SHAPE.edges, { from: "review", to: "plan", label: long }] };
    const el = render({ shape });
    const caption = [...el.querySelectorAll(".dag-caption")].find((c) => c.textContent === long);
    expect(caption).toBeDefined(); // nothing is cut out of the document, only clipped by its box
    expect(dagFlow(shape).wires.find((w) => w.caption?.text === long)!.caption!.width).toBeLessThanOrEqual(232);
  });

  test("a route a run has taken is drawn stronger than one it has not", () => {
    const el = render({ taken: new Set(["start\u0000plan", "plan\u0000probe"]) });
    expect(el.querySelectorAll(".dag-wire.taken")).toHaveLength(2);
    expect(el.querySelectorAll(".dag-wire:not(.taken)")).toHaveLength(2);
    // with no run there is nothing to emphasise
    act(() => root!.unmount());
    host!.remove();
    expect(render().querySelectorAll(".dag-wire.taken")).toHaveLength(0);
  });
});

describe("HOW-65: a draft's removed steps, and the row in focus", () => {
  test("a removed step is drawn struck through and labelled `removed`; the highlighted one is ringed", () => {
    const el = render({ removed: new Set(["probe"]), highlight: "build" });
    expect(node(el, "probe").classList.contains("removed")).toBe(true);
    expect(node(el, "probe").getAttribute("aria-label")).toContain("removed");
    expect(node(el, "probe").querySelector(".dag-sub")!.textContent).toStartWith("removed");
    // the ring is the accent the selected card wears — it was amber, which means a run is waiting on you
    expect(node(el, "build").classList.contains("selected")).toBe(true);
    expect(node(el, "build").getAttribute("aria-label")).toContain("highlighted");
    expect(el.querySelectorAll(".dag-card.removed")).toHaveLength(1);
    expect(el.querySelectorAll(".dag-card.selected")).toHaveLength(1);
    expect(el.querySelectorAll(".dag-card.waiting")).toHaveLength(0);
  });

  test("without the props nothing is marked", () => {
    const el = render();
    expect(el.querySelectorAll(".dag-card.removed, .dag-card.selected")).toHaveLength(0);
  });
});

/**
 * D23, restated for HOW-68. The old box was 18 characters wide and SHORTENED the group
 * (`impl….local_review`) so the step could be read; `idParts(id, max, …)` did the cutting and
 * these tests pinned its arithmetic. The card now prints the id WHOLE, on two lines where it
 * needs them, so there is no `max` to fit — what is pinned is that nothing is cut, that the line
 * breaks where a reader would break it, and that the group is still dimmed or omitted.
 */
describe("D23: a card prints an id whole, and the part that tells steps apart stands out", () => {
  test("a long id wraps at the group's dot — never in the middle of a word, never with an ellipsis", () => {
    const ids = ["implementation.local_review", "implementation.plan_review", "implementation.implement_review", "delivery.publish"];
    expect(sharedGroupOf(ids)).toBeNull(); // two groups: the group is information, so it stays (dimmed)
    const shown = ids.map((id) => nameOf({ id }, null));
    expect(shown.map((n) => n.lines)).toEqual([
      ["implementation.", "local_review"],
      ["implementation.", "plan_review"],
      ["implementation.", "implement_review"],
      ["delivery.publish"],
    ]);
    for (const [i, n] of shown.entries()) {
      expect(n.lines.join("")).toBe(ids[i]!); // all of it is there
      expect(n.lines.join("")).not.toContain("…");
      expect(n.dim).toBe(ids[i]!.lastIndexOf(".") + 1); // the group and its dot are the dimmed part
      expect(n.mono).toBe(true);
    }
  });

  test("a group every step shares is omitted; an undotted id has nothing to dim", () => {
    const all = ["quick-task.work", "quick-task.review", "quick-task.done"];
    expect(sharedGroupOf(all)).toBe("quick-task");
    expect(nameOf({ id: "quick-task.work" }, "quick-task")).toEqual({ lines: ["work"], dim: 0, mono: true });
    expect(sharedGroupOf(["quick-task.work", "done"])).toBeNull(); // not EVERY node is in it
    expect(sharedGroupOf(["solo.step"])).toBeNull(); // one node has nothing to be told apart from
    expect(nameOf({ id: "work" }, null)).toEqual({ lines: ["work"], dim: 0, mono: true });
  });

  test("wrapName breaks at the strongest joint that fits, and only a name past three lines loses its tail", () => {
    expect(wrapName("short", 24)).toEqual(["short"]);
    expect(wrapName("delivery.reextract_revision_again", 24)).toEqual(["delivery.", "reextract_revision_again"]);
    expect(wrapName("a_step_name_that_is_long_but_has_joints", 24)).toEqual(["a_step_name_that_is_", "long_but_has_joints"]);
    expect(wrapName("Write the plan and the criteria", 26)).toEqual(["Write the plan and the", "criteria"]);
    expect(wrapName("x".repeat(30), 24)).toEqual(["x".repeat(24), "x".repeat(6)]); // no joint: a hard break, still whole
    const huge = wrapName("y".repeat(100), 24);
    expect(huge).toHaveLength(3);
    expect(huge[2]!.endsWith("…")).toBe(true); // the tooltip has all of it
  });

  test("the card is as tall as its lines, so the layout knows every box before anything is drawn", () => {
    const flow = dagFlow({ ...SHAPE, nodes: [...SHAPE.nodes, { id: "implementation.implement_review", kind: "agent" }], edges: [...SHAPE.edges, { from: "review", to: "implementation.implement_review" }] });
    const h = (id: string) => flow.cards.find((c) => c.node.id === id)!.box.height;
    expect(h("implementation.implement_review")).toBe(h("plan") + 18); // one more 18px line
    const el = render({ shape: { ...SHAPE, nodes: [...SHAPE.nodes, { id: "implementation.implement_review", kind: "agent" }] } });
    const name = node(el, "implementation.implement_review").querySelector(".dag-name")!;
    expect([...name.children].map((l) => l.textContent)).toEqual(["implementation.", "implement_review"]);
    expect(name.querySelector(".dag-name-group")!.textContent).toBe("implementation.");
  });
});
