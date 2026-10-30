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
import { RunReport } from "./run/report";
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
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect([...el.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/api/runs/r1/report", "/api/runs/r1/report?download=1"]);
});
