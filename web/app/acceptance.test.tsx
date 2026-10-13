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

  // HOW-58: the rail's layout (judged-by on its own line, waive aligned under the text) rests
  // on this structure — the CSS addresses these elements as children of these parents
  test("structure the rail layout depends on: 'judged by' in the head, Waive… in its row's body", () => {
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog(false).events)} onChanged={() => {}} />);
    const by = el.querySelector(".ac-by")!;
    expect(by.parentElement!.classList.contains("ac-head")).toBe(true);
    expect(by.textContent).toBe("judged by implementation.local_review@1");
    const open = el.querySelector(".ac-waive-open")!;
    expect(open.parentElement!.classList.contains("ac-row-body")).toBe(true);
    expect(open.closest(".ac-row")!.getAttribute("data-state")).toBe("fail");
    act(() => (open as HTMLButtonElement).click());
    // the input is the first child: `.ac-waive > :first-child` is what lets it share a line or wrap
    expect(el.querySelector(".ac-waive")!.firstElementChild!.tagName).toBe("INPUT");
    expect(el.querySelector(".ac-waive")!.parentElement!.classList.contains("ac-row-body")).toBe(true);
  });

  test("a finished run offers no waiver — there is no gate left to open", () => {
    const el = render(<AcceptanceCard runId="r1" detail={deriveDetail("r1", contractLog().events)} onChanged={() => {}} />);
    expect(el.querySelector(".ac-waive-open")).toBeNull();
  });

  // HOW-59: it leads from INSIDE the transcript. In the pane's fixed head a long contract pushed
  // the scrolling transcript off the screen, and then nothing in Chat could be scrolled at all.
  test("a finished run's Chat LEADS with the card — as the transcript's first item, never the fixed head", () => {
    const detail = deriveDetail("r1", contractLog().events);
    const el = render(<RunChat runId="r1" detail={detail} ask={null} onPickStep={() => {}} onResolved={() => {}} />);
    expect(el.querySelector(".chat-head .ac-card")).toBeNull();
    const log = el.querySelector(".chat-log")!;
    expect(log.firstElementChild!.querySelector(".ac-card")).not.toBeNull();
  });

  test("a run held at the delivery gate shows the card WITH the ask, inside the transcript", () => {
    const events = contractLog(false);
    events.add({ type: "attention-raised", node: "delivery.publish", visit: 1, reason: "1 unmet", code: "acceptance-unmet" });
    const detail = deriveDetail("r1", events.events);
    const el = render(<RunChat runId="r1" detail={detail} ask={detail.ask} onPickStep={() => {}} onResolved={() => {}} />);
    expect(el.querySelector(".chat-head .ac-card")).toBeNull();
    expect(el.querySelector(".chat-log .cv-standing .ac-card")).not.toBeNull();
  });

  test("HOW-59: an unprovable row says why; after-publish rows wait; one control waives all the unprovable", async () => {
    const log = new FakeLog();
    log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
    log.add({ type: "node-finished", node: "verify.run", visit: 1, status: "succeeded", writes: { "verify.result": { outcome: "not-checked", reason: "no verify command is configured" } } });
    log.add({
      type: "node-finished", node: "implementation.local_review", visit: 1, status: "succeeded", writes: {
        acceptance: [
          { id: "ac-1", text: "tests cover it", source: "plan", check: "tests", passes: false, evidence: null },
          { id: "ac-2", text: "it reads well", source: "plan", check: "human", passes: false, evidence: null },
          { id: "ac-3", text: "CI is green", source: "plan", check: "after-publish", passes: false, evidence: null },
          { id: "ac-4", text: "the handler is gone", source: "plan", check: "command", passes: false, evidence: null },
        ],
      },
    });
    const detail = deriveDetail("r1", log.events);
    expect(detail.acceptance).toMatchObject({ unmet: 3, unprovable: 2 });
    const posted: unknown[] = [];
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, waived: ["ac-1", "ac-2"], remaining: 1, resumed: false }), { status: 202 });
    }) as typeof fetch;
    const el = render(<AcceptanceCard runId="r1" detail={detail} onChanged={() => {}} />);
    expect(state(el)).toEqual(["fail", "fail", "later", "fail"]);
    const meta = [...el.querySelectorAll(".ac-meta")].map((m) => m.textContent);
    expect(meta[0]).toContain("can't be proved in this run: it needs the tests, and the tests were never run (no verify command is configured)");
    expect(meta[0]).toContain("checked by tests");
    expect(meta[2]).toContain("not held at publish");
    expect(meta[3]).toContain("no evidence yet");
    const open = [...el.querySelectorAll("button")].find((b) => b.textContent === "Waive all unprovable…")!;
    act(() => open.click());
    const input = el.querySelector(".ac-unprovable input") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "no test command yet");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const go = [...el.querySelectorAll("button")].find((b) => b.textContent === "Waive 2")!;
    await act(async () => { go.click(); await new Promise((r) => setTimeout(r, 20)); });
    expect(posted).toEqual([{ unprovable: true, reason: "no test command yet" }]);
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
