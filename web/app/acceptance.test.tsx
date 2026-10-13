/**
 * HOW-51 — the Acceptance card: red rows unmet, green rows with their evidence, waived rows on
 * the record, superseded rows struck through but kept, plan-proposed rows tagged — and no card
 * at all for a run that never wrote a contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { AcceptanceCard } from "./run/acceptance";
import { RunChat } from "./run/chat";
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

const SHOT = "evidence/implementation.evidence@1/01-index.png";
function contractLog(finished = true): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "implementation.local_review", visit: 1, attempt_id: "r#1" });
  log.add({
    type: "node-finished", node: "implementation.local_review", visit: 1, status: "succeeded", writes: {
      acceptance: [
        { id: "ac-1", text: "tests cover the parser", source: "ticket", passes: true, evidence: { kind: "verify.result", note: "parser.test.ts" } },
        { id: "ac-2", text: "the panel shows the plan", source: "ticket", passes: true, evidence: { kind: "screenshot", file: SHOT } },
        { id: "ac-3", text: "it feels right", source: "plan", passes: false, evidence: null },
        { id: "ac-4", text: "old wording", source: "ticket", passes: false, evidence: null, superseded: true },
        { id: "ac-5", text: "the full suite runs", source: "plan", passes: false, evidence: null },
      ],
    },
  });
  log.add({ type: "acceptance-waived", criterion_id: "ac-3", reason: "subjective; checked by eye", by: "operator" });
  if (finished) log.add({ type: "run-finished", outcome: "success" });
  return log;
}

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
  return host;
}
const state = (el: HTMLElement) => [...el.querySelectorAll(".ac-row")].map((r) => r.getAttribute("data-state"));

describe("the Acceptance card", () => {
  test("pass / waived / superseded / fail, with the counts that matter", () => {
    const detail = deriveDetail("r1", contractLog().events);
    const el = render(<AcceptanceCard runId="r1" detail={detail} onChanged={() => {}} />);
    expect(state(el)).toEqual(["pass", "pass", "waived", "superseded", "fail"]);
    expect(el.querySelector(".ac-score")!.textContent).toBe("3 of 4 met"); // superseded rows do not count
    expect(el.querySelector(".ac-card")!.getAttribute("data-met")).toBe("false");
    expect(el.textContent).toContain("1 unmet");
  });

  test("each green row links its evidence; the waived row says who and why", () => {
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog().events)} onChanged={() => {}} />);
    const rows = [...el.querySelectorAll(".ac-row")];
    expect(rows[0]!.textContent).toContain("tests passed — parser.test.ts");
    expect(rows[1]!.querySelector("a")!.getAttribute("href")).toBe("/api/runs/r1/file/evidence/implementation.evidence%401/01-index.png");
    expect(rows[2]!.querySelector(".ac-waived")!.textContent).toBe("waived by the operator — subjective; checked by eye");
  });

  test("rows the ticket did not ask for are tagged 'proposed by plan'; superseded rows stay, struck", () => {
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog().events)} onChanged={() => {}} />);
    const rows = [...el.querySelectorAll(".ac-row")];
    expect(rows.map((r) => r.textContent!.includes("proposed by plan"))).toEqual([false, false, true, false, true]);
    expect(rows[3]!.textContent).toContain("old wording");
    expect(rows[3]!.textContent).toContain("superseded");
  });

  test("waiving asks for a reason and posts the decision; a refusal is shown verbatim", async () => {
    const posted: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ error: "criterion \"ac-5\" was superseded — waive the row that replaced it" }), { status: 409 });
    }) as typeof fetch;
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog(false).events)} onChanged={() => {}} />);
    act(() => (el.querySelector(".ac-waive-open") as HTMLButtonElement).click());
    const waive = [...el.querySelectorAll("button")].find((b) => b.textContent === "Waive")!;
    expect(waive.disabled).toBe(true); // no reason, no waiver
    const input = el.querySelector(".ac-waive input") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "CI runs it on merge");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { waive.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(posted).toEqual([{ url: "/api/runs/r1/acceptance/waive", body: { criterion: "ac-5", reason: "CI runs it on merge" } }]);
    expect(el.querySelector(".field-error")!.textContent).toBe("criterion \"ac-5\" was superseded — waive the row that replaced it");
  });

  test("a finished run offers no waiver — there is no gate left to open", () => {
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog().events)} onChanged={() => {}} />);
    expect(el.querySelector(".ac-waive-open")).toBeNull();
  });

  test("a finished run's Chat LEADS with the card", () => {
    const detail = deriveDetail("r1", contractLog().events);
    const el = render(<RunChat runId="r1" detail={detail} ask={null} onPickStep={() => {}} onResolved={() => {}} />);
    expect(el.querySelector(".chat-head .ac-card")).not.toBeNull();
  });

  test("migration: a run with no acceptance renders no card — not an empty red one", () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "run-finished", outcome: "success" });
    const detail = deriveDetail("r1", log.events);
    expect(detail.acceptance).toBeNull();
    const el = render(<RunChat runId="r1" detail={detail} ask={null} onPickStep={() => {}} onResolved={() => {}} />);
    expect(el.querySelector(".ac-card")).toBeNull();
  });
});
