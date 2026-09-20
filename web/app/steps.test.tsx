/**
 * StepDetail pane routing (system-map 1d review): the Steps detail panel is the ONE detail
 * component, and which pane leads decides whether a parked operator can act at all. An
 * awaiting-approval park is decided on the approval card (Ask hidden); ANY other park on the
 * approval step — attempt-failed, or a pre-start max-visits at a visit that never started — is
 * answered by a reply, so Ask stays and leads. Also: the panel's tabs work from the keyboard.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog, drift, failApproval, ghostsV1, proposeAndPark, proposeRound, started } from "../slice.fixtures";
import { StepDetail } from "./run/steps";
import { askRowKey } from "./status";
import { deriveStatus } from "../derive";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

function renderStep(log: FakeLog, node: string | null, visit = 1): HTMLElement {
  const detail = deriveDetail("r1", log.events);
  const row = node === null ? null : detail.timeline.findLast((t) => t.node === node && t.visit === visit) ?? null;
  if (node !== null) expect(row).not.toBeNull();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<StepDetail runId="r1" row={row} detail={detail} ask={detail.ask} now={Date.now()} onResolved={() => {}} />));
  return host;
}

const tabs = (el: HTMLElement) => [...el.querySelectorAll('.sd-tabs [role="tab"]')] as HTMLElement[];
const tabLabels = (el: HTMLElement) => tabs(el).map((t) => t.textContent);
const selected = (el: HTMLElement) => tabs(el).find((t) => t.getAttribute("aria-selected") === "true")?.textContent;

describe("StepDetail pane routing on the approval step", () => {
  test("awaiting-approval: the approval card leads and Ask is hidden (the card IS the ask)", () => {
    const log = new FakeLog();
    started(log);
    proposeAndPark(log, ghostsV1());
    const el = renderStep(log, "slice.approve", 1);
    expect(tabLabels(el)).toEqual(["Approval", "Prompt & context", "Output"]);
    expect(selected(el)).toBe("Approval");
    expect(el.querySelector(".approval-card.needs-you")).not.toBeNull();
  });

  test("attempt-failed: Ask leads with the reply card; the Approval tab points back to it, amber", async () => {
    const log = new FakeLog();
    started(log);
    proposeRound(log, ghostsV1());
    failApproval(log, 1, "approval executor threw: base unreadable");
    const el = renderStep(log, "slice.approve", 1);
    expect(tabLabels(el)).toEqual(["Ask", "Approval", "Prompt & context", "Output"]);
    expect(selected(el)).toBe("Ask");
    expect(el.querySelector(".ask-card h3")!.textContent).toBe("Needs you — slice.approve@1");
    expect(el.querySelector(".ask-card")!.textContent).toContain("approval executor threw: base unreadable");

    await act(async () => tabs(el).find((t) => t.textContent === "Approval")!.click());
    const card = el.querySelector(".approval-card")!;
    expect(card.classList.contains("needs-you")).toBe(true);
    expect(card.querySelector('[data-testid="ap-explain"]')!.textContent).toContain("Answer it in the Ask tab");
  });

  test("max-visits at a visit that never started: the step's latest row carries the ask, and Ask leads", () => {
    const log = new FakeLog();
    started(log);
    proposeRound(log, ghostsV1());
    log.add({ type: "attention-raised", node: "slice.approve", visit: 2, reason: "maxVisits exceeded (2 > 1)", code: "max-visits" });
    const el = renderStep(log, "slice.approve", 1);
    expect(tabLabels(el)[0]).toBe("Ask");
    expect(selected(el)).toBe("Ask");
    expect(el.querySelector(".ask-card h3")!.textContent).toBe("Needs you — slice.approve@2");
    expect(el.querySelector(".sd-head .step-glyph.needs-input")).not.toBeNull();
  });

  test("a step that is not asking keeps Ask after its slice panes (the drift step opens on Drift)", () => {
    const log = new FakeLog();
    started(log);
    log.add({ type: "node-started", node: "map.drift", visit: 1, attempt_id: "map.drift#1" });
    log.add(drift([{ key: "a", outcome: "verified" }]));
    const el = renderStep(log, "map.drift", 1);
    expect(tabLabels(el)).toEqual(["Drift", "Ask", "Prompt & context", "Output"]);
    expect(selected(el)).toBe("Drift");
    expect(el.querySelector(".drift-view")).not.toBeNull();
  });
});

describe("panel tabs are keyboard tabs", () => {
  test("role=tab, focusable, and Enter / Space switch panes", async () => {
    const log = new FakeLog();
    started(log);
    log.add({ type: "node-started", node: "map.drift", visit: 1, attempt_id: "map.drift#1" });
    log.add(drift([{ key: "a", outcome: "verified" }]));
    const el = renderStep(log, "map.drift", 1);
    for (const t of tabs(el)) expect(t.getAttribute("tabindex")).toBe("0");
    const press = (label: string, key: string) =>
      act(async () => {
        tabs(el).find((t) => t.textContent === label)!.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
      });
    await press("Output", "Enter");
    expect(selected(el)).toBe("Output");
    await press("Drift", " ");
    expect(selected(el)).toBe("Drift");
    // the Step / Run scope switch is the same component
    expect([...el.querySelectorAll('.sd-scope [role="tab"]')].map((t) => t.textContent)).toEqual(["Step", "Run"]);
  });
});

describe("an ask on a node with no step row", () => {
  // approval-missing after a jump to implementation.implement before it ever ran: the requires
  // gate parks pre-start, so no row exists for that node at all
  const jumpedPastApproval = () => {
    const log = new FakeLog();
    started(log);
    proposeAndPark(log, ghostsV1());
    log.add({ type: "operator-jump", to: "implementation.implement", reset_budgets: true });
    log.add({ type: "attention-raised", node: "implementation.implement", visit: 1, reason: "no current approval for slice.approve", code: "approval-missing" });
    return log;
  };

  test("the detail panel carries the canonical Ask card, whichever row is selected", () => {
    const el = renderStep(jumpedPastApproval(), "slice.approve", 1);
    const fallback = el.querySelector('[data-testid="rowless-ask"]')!;
    expect(fallback.textContent).toContain("implementation.implement has no step yet");
    expect(fallback.querySelector(".ask-card h3")!.textContent).toBe("Needs you — implementation.implement@1");
    expect(fallback.querySelector(".ask-card")!.textContent).toContain("no current approval for slice.approve");
    // one Ask card for the one ask — the selected row does not also carry it
    expect(el.querySelectorAll(".ask-card").length).toBe(1);
  });

  test("…and with no row selected at all", () => {
    const el = renderStep(jumpedPastApproval(), null);
    expect(el.querySelector('[data-testid="rowless-ask"] .ask-card')).not.toBeNull();
    expect(el.textContent).not.toContain("pick a step");
  });

  test("an ask that a row carries gets no fallback", () => {
    const log = new FakeLog();
    started(log);
    proposeRound(log, ghostsV1());
    failApproval(log);
    expect(renderStep(log, "slice.approve", 1).querySelector('[data-testid="rowless-ask"]')).toBeNull();
  });
});

describe("askRowKey", () => {
  const rows = [
    { node: "a", visit: 1 },
    { node: "b", visit: 1 },
    { node: "a", visit: 2 },
    { node: "b", visit: 2 },
  ];

  test("an exact node@visit match", () => {
    expect(askRowKey(rows, { node: "b", visit: 1 })).toBe("b@1");
  });

  test("the exact visit wins over the node's latest visit", () => {
    expect(askRowKey(rows, { node: "a", visit: 1 })).toBe("a@1");
  });

  test("a pre-start park (a visit that never started) falls back to the node's latest visit", () => {
    expect(askRowKey(rows, { node: "a", visit: 3 })).toBe("a@2");
  });

  test("a node that never ran has no row", () => {
    expect(askRowKey(rows, { node: "never", visit: 1 })).toBeNull();
    expect(askRowKey([], { node: "a", visit: 1 })).toBeNull();
  });

  test("no ask, no row — and historic (resolved) parks never reach it", () => {
    expect(askRowKey(rows, null)).toBeNull();
    const log = new FakeLog();
    started(log);
    log.add({ type: "node-started", node: "a", visit: 1, attempt_id: "a#1" });
    log.add({ type: "attention-raised", node: "a", visit: 1, reason: "old", code: "attempt-failed" });
    log.add({ type: "attention-resolved", node: "a", visit: 1, reply: "go", source: "operator" });
    log.add({ type: "node-started", node: "b", visit: 1, attempt_id: "b#1" });
    const detail = deriveDetail("r", log.events);
    expect(askRowKey(detail.timeline, deriveStatus(log.events).ask)).toBeNull();
    log.add({ type: "attention-raised", node: "b", visit: 1, reason: "now", code: "attempt-failed" });
    expect(askRowKey(deriveDetail("r", log.events).timeline, deriveStatus(log.events).ask)).toBe("b@1");
  });
});
