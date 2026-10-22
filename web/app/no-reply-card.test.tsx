/**
 * HOW-69 — a park a reply cannot answer draws no reply box. The operator saw a `probe:pr`
 * command node park on "forge unreachable", typed into "Your reply…", and was refused with a
 * message the server had known all along. The card is now chosen by the read model's
 * `ask_reply` (engine/control.ts replyVerdict, the reply route's own rule), so these tests
 * render through the real deriveDetail with the real graph registry rather than a hand-built
 * detail: what is pinned is the seam between the route's rule and the component.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { GRAPHS } from "../../graphs/index";
import { StandingAsk } from "./run/ask";
import type { ParkCode } from "../../log/events";
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

const FORGE = "executor threw: forge unreachable: Post https://api.github.com/graphql: operation timed out";

/** an implement-ticket run parked on `node` with `code` — the shape of the ticket's screenshot */
function parked(node: string, code: ParkCode, reason: string): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "g" }, pinned_prompts: {} });
  log.add({ type: "node-started", node, visit: 257, attempt_id: `${node}#257` });
  log.add({ type: "node-finished", node, visit: 257, status: "failed", writes: {} });
  log.add({ type: "attention-raised", node, visit: 257, reason, code });
  return log;
}

function render(log: FakeLog, onResolved: () => void = () => {}): HTMLElement {
  const detail = deriveDetail("r1", log.events, {}, { graphs: GRAPHS });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider><StandingAsk runId="r1" detail={detail} ask={detail.ask!} onResolved={onResolved} /></ToastProvider>));
  return host;
}

type Call = { url: string; method: string | undefined };
function mockFetch(respond: () => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return respond();
  }) as unknown as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent?.trim());
const button = (el: HTMLElement, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const replyBox = (el: HTMLElement) => el.querySelector('[aria-label="your reply"]');
const click = (el: HTMLElement) => act(async () => { el.click(); });

describe("a park a reply cannot answer (HOW-69)", () => {
  test("a command-node park: no composer, the route's refusal verbatim, and Retry this step", () => {
    const el = render(parked("delivery.probe_pr", "executor-threw", FORGE));
    expect(replyBox(el)).toBeNull();
    expect(buttons(el)).not.toContain("Reply");
    expect(el.querySelector("#needs-input")).not.toBeNull();
    expect(el.textContent).toContain(FORGE);
    expect(el.textContent).toContain(
      'reply refused (executor-threw): "delivery.probe_pr" is a command node, so there is no prompt to carry it; fix the cause, then `resume r1`',
    );
    expect(buttons(el)).toContain("Retry this step");
  });

  test("Retry this step POSTs the run's resume and plays delivered → collapsing", async () => {
    const calls = mockFetch(() => json({ ok: true }, 202));
    let resolved = 0;
    const el = render(parked("delivery.probe_pr", "executor-threw", FORGE), () => resolved++);
    await click(button(el, "Retry this step"));
    expect(calls).toEqual([{ url: "/api/runs/r1/resume", method: "POST" }]);
    expect(buttons(el)).toContain("Retry requested");
    expect(button(el, "Retry requested").disabled).toBe(true);
    expect(el.querySelector("#needs-input")!.className).toContain("collapsing");
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(resolved).toBe(1);
  });

  test("a failed resume shows the server's words verbatim, and can be retried", async () => {
    mockFetch(() => json({ error: "graph not registered: implement-ticket" }, 404));
    const el = render(parked("delivery.probe_pr", "executor-threw", FORGE));
    await click(button(el, "Retry this step"));
    expect(el.querySelector('[role="alert"]')!.textContent).toBe("graph not registered: implement-ticket");
    expect(el.querySelector("#needs-input")!.className).not.toContain("collapsing");
    expect(buttons(el)).toContain("retry");
  });

  test("an agent-node park still gets the reply box", () => {
    const el = render(parked("delivery.fix_ci", "attempt-failed", "attempt failed"));
    expect(replyBox(el)).not.toBeNull();
    expect(buttons(el)).toContain("Reply");
    expect(buttons(el)).not.toContain("Retry this step");
  });

  test("a routing park: the refusal names its verb, with no Retry — resuming would not move it", () => {
    const el = render(parked("delivery.fix_ci", "no-edge", "no outgoing edge matched"));
    expect(replyBox(el)).toBeNull();
    expect(el.textContent).toContain("reply refused (no-edge): a reply cannot change where the graph routes; use `jump r1 <node> <msg>`");
    expect(buttons(el)).not.toContain("Retry this step");
  });

  test("a detail derived without graphs keeps today's composer (no verdict, no guess)", () => {
    const log = parked("delivery.probe_pr", "executor-threw", FORGE);
    const detail = deriveDetail("r1", log.events);
    expect(detail.ask_reply).toBeNull();
  });
});
