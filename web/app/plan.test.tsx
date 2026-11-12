/**
 * HOW-78 — the Plan and Report tabs. A plan comment goes into the build through the channels the
 * run already has: a steer while a steerable turn is live, else a jump back to the planning step
 * carrying the comment. Which one is said before the send, and a finished run offers neither.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail, type RunDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { RunPlan, planInstruction, planRoute } from "./run/plan";
import { REPORT_SANDBOX, RunReport, canMapChange } from "./run/report";
import { ToastProvider } from "@/components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

const DECL = { implementation_plan: { scope: "sticky" as const, writer: ["implementation.plan"] } };

function planned(finished = false): RunDetail {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "implementation.plan", visit: 1, attempt_id: "p#1" });
  log.add({ type: "node-finished", node: "implementation.plan", visit: 1, status: "succeeded", writes: { implementation_plan: "## Approach\nAdd a reconciler." } });
  if (finished) log.add({ type: "run-finished", outcome: "success" });
  return deriveDetail("r1", log.events, DECL as never);
}

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
  return host;
}

const textarea = (el: HTMLElement) => el.querySelector("textarea")!;
function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new window.Event("input", { bubbles: true })); });
}
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

describe("the Plan tab", () => {
  test("draws the plan as a document, and a graph without a plan says so", () => {
    expect(render(<RunPlan runId="r1" detail={planned()} onChanged={() => {}} />).querySelector(".plan-doc")!.textContent).toContain("Add a reconciler.");
    act(() => root!.unmount()); root = null;
    const none = deriveDetail("r2", [], {});
    expect(render(<RunPlan runId="r2" detail={none} onChanged={() => {}} />).textContent).toContain("no planning step");
  });

  test("with no live turn, a comment is a jump back to implementation.plan carrying it", async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    const el = render(<RunPlan runId="r1" detail={planned()} onChanged={() => {}} />);
    expect(el.querySelector(".plan-route")!.textContent).toContain("implementation.plan");
    type(textarea(el), "keep the old endpoint");
    await act(async () => { button(el, "Send comment").click(); });
    expect(sent).toEqual([{ url: "/api/runs/r1/jump", body: { node: "implementation.plan", message: planInstruction("comment", "keep the old endpoint") } }]);
  });

  test("a refusal is shown verbatim", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "runner is live — pause or abort first, then jump" }), { status: 400 })) as unknown as typeof fetch;
    const el = render(<RunPlan runId="r1" detail={planned()} onChanged={() => {}} />);
    type(textarea(el), "x");
    await act(async () => { button(el, "Send comment").click(); });
    expect(el.querySelector(".field-error")!.textContent).toBe("runner is live — pause or abort first, then jump");
  });

  test("Edit the plan starts from the plan's own text; a finished run offers no send", () => {
    const el = render(<RunPlan runId="r1" detail={planned()} onChanged={() => {}} />);
    act(() => { button(el, "Edit the plan").click(); });
    expect(textarea(el).value).toBe("## Approach\nAdd a reconciler.");
    expect(planRoute(planned(true))).toEqual({ kind: "closed", why: "the run has finished (success)" });
  });
});

test("the Report tab frames the derived page, sandboxed, with Open and Download", () => {
  // happy-dom would otherwise fetch the frame's page from a server that is not running
  const settings = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM?.settings;
  if (settings) settings.disableIframePageLoading = true;
  const el = render(<RunReport runId="r1" detail={planned()} />);
  const frame = el.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe("/api/runs/r1/report");
  // HOW-68 feedback: the page's PR link has to open in the operator's browser. `allow-scripts`
  // alone BLOCKED a new tab, so the link loaded the forge inside the frame; the sandbox now
  // permits a new tab that is an ordinary page — and still nothing that reaches this origin.
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
  expect(REPORT_SANDBOX.split(" ").sort()).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-scripts"]);
  for (const never of ["allow-same-origin", "allow-top-navigation", "allow-forms", "allow-downloads", "allow-modals"]) expect(REPORT_SANDBOX).not.toContain(never);
  const links = [...el.querySelectorAll("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["/api/runs/r1/report", "/api/runs/r1/report?download=1"]);
  // Open is a new tab that is handed neither this window nor where it came from; Download is a download
  expect(links[0]!.getAttribute("target")).toBe("_blank");
  expect(links[0]!.getAttribute("rel")).toBe("noopener noreferrer");
  expect(links[1]!.hasAttribute("download")).toBe(true);
});

describe("HOW-68 feedback: the plan uses the width its pane has", () => {
  test("the plan and the answer are two regions of ONE scroller: the document, then the contract and the composer", () => {
    const el = render(<RunPlan runId="r1" detail={planned()} onChanged={() => {}} />);
    const pane = el.querySelector(".plan-pane")!;
    const layout = pane.querySelector(".plan-layout")!;
    expect([...layout.children].map((c) => (c as HTMLElement).dataset.slot)).toEqual(["plan-main", "plan-side"]);
    expect(layout.querySelector('[data-slot="plan-main"] .plan-doc')).not.toBeNull();
    expect(layout.querySelector('[data-slot="plan-side"] .plan-compose')).not.toBeNull();
    // in reading order the plan comes before the box that answers it, whichever side it is drawn on
    expect(layout.querySelector(".plan-doc")!.compareDocumentPosition(layout.querySelector(".plan-compose")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("no 760px cap: one column to ~110 characters, and two once the PANE (not the window) has room", async () => {
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    const rule = (sel: string) => css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(css).not.toContain(".plan-column");
    expect(rule("\\.plan-pane")).toContain("container-type: inline-size");
    expect(rule("\\.plan-layout")).toContain("minmax(0, 880px)");
    // the markdown primitive's 75ch measure is the transcript's; the plan's is its column
    expect(css).toMatch(/\.md\.plan-doc > \* \{ max-width: none; \}/);
    const wide = css.match(/@container \(min-width: 1160px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(wide).toContain("minmax(0, 880px) minmax(340px, 460px)");
    // beside the plan the contract stays in view — sticky in the SAME scroller, never a second one
    expect(wide).toMatch(/\.plan-side \{ position: sticky;/);
    expect(wide).not.toContain("overflow");
  });
});

describe("Map this change (HOW-78)", () => {
  const mapless = (written: boolean, finished = false) => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: {}, pinned_prompts: {} });
    if (written) {
      log.add({ type: "node-started", node: "implementation.report", visit: 1, attempt_id: "r#1" });
      log.add({ type: "node-finished", node: "implementation.report", visit: 1, status: "succeeded", writes: { change_map: { title: "t" } } });
    }
    if (finished) log.add({ type: "run-finished", outcome: "success" });
    return deriveDetail("r1", log.events, { change_map: { scope: "sticky", writer: ["implementation.report"] } } as never);
  };

  test("offered only when the graph has the step, no visit wrote the map, and the run is not over", () => {
    expect(canMapChange(mapless(false))).toBe(true);
    expect(canMapChange(mapless(true))).toBe(false);
    expect(canMapChange(mapless(false, true))).toBe(false);
    expect(canMapChange(deriveDetail("r2", [], {}))).toBe(false);
  });

  test("it is a jump to implementation.report, and a refusal is shown verbatim", async () => {
    const settings = (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM?.settings;
    if (settings) settings.disableIframePageLoading = true;
    const sent: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: "runner is live — pause or abort first, then jump" }), { status: 400 });
    }) as typeof fetch;
    const el = render(<RunReport runId="r1" detail={mapless(false)} />);
    await act(async () => { button(el, "Map this change").click(); });
    expect(sent).toEqual([{ node: "implementation.report" }]);
    expect(el.querySelector(".field-error")!.textContent).toBe("runner is live — pause or abort first, then jump");
  });
});
