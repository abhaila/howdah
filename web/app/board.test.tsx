/**
 * HOW-50 — the Runs screen as a live board: grouped, needs-you first, each row carrying its
 * vital signs, and fed by ONE board-level stream rather than a poll per row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunBoardRow } from "../board";
import { RunsList, groupRuns } from "./screens/runs";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

class StubEventSource {
  static urls: string[] = [];
  static last: StubEventSource | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) { StubEventSource.urls.push(url); StubEventSource.last = this; }
  addEventListener() {}
  close() {}
}

const NOW = Date.now();
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

function row(over: Partial<RunBoardRow> & Pick<RunBoardRow, "id" | "status">): RunBoardRow {
  return {
    graph: "implement-ticket", name: null, parent: null, goal: over.id, started_at: iso(3_600_000), last_event_at: iso(1000),
    waiting_since: null, needs_input_reason: null, failure: null, paused: false, outcome: null,
    current: null, last_activity_at: null, cost_usd: 0, cost_partial: false, commits: null, pr: null,
    ...over,
  };
}

let fetches = 0;
function serve(runs: RunBoardRow[]) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/runs") fetches++;
    const body = url === "/api/runs" ? runs : url === "/api/app" ? { home: "/h", repoRoot: "/r", source: "r", supervisorHeartbeat: null } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function mount(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunsList />));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  return host;
}

beforeEach(() => {
  fetches = 0;
  StubEventSource.urls = [];
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

const RUNS = [
  row({ id: "old-done", status: "done", outcome: "success", last_event_at: iso(3 * 86_400_000) }),
  row({ id: "live", status: "running", current: { node: "implementation.implement", visit: 2, since: iso(27 * 60_000) }, last_activity_at: iso(14_000), cost_usd: 1.949, cost_partial: true, commits: 3, pr: null }),
  row({ id: "asking", status: "needs-input", waiting_since: iso(12 * 60_000), current: { node: "plan", visit: 1, since: iso(20 * 60_000) } }),
  row({ id: "fresh-done", status: "done", outcome: "success", cost_usd: 0.42, pr: { url: "https://github.com/o/r/pull/9", state: "MERGED" } }),
];

describe("groupRuns", () => {
  test("Needs you / Running / Recently finished / Older, needs-you first, empty groups dropped", () => {
    expect(groupRuns(RUNS, NOW).map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ["needs-you", ["asking"]],
      ["running", ["live"]],
      ["recent", ["fresh-done"]],
      ["older", ["old-done"]],
    ]);
    expect(groupRuns([RUNS[1]!], NOW).map((g) => g.key)).toEqual(["running"]);
  });
});

describe("the board", () => {
  test("needs-you is drawn above running, each row with the one StatusBadge", async () => {
    serve(RUNS);
    const el = await mount();
    const heads = [...el.querySelectorAll(".board-group-head")].map((h) => h.getAttribute("data-group"));
    expect(heads).toEqual(["needs-you", "running", "recent", "older"]);
    const firstRow = el.querySelector(".board-group .board-row")!;
    expect(firstRow.getAttribute("href")).toBe("/run/asking");
    expect(el.querySelectorAll(".board-row .status")).toHaveLength(4);
  });

  test("a running row: its step and for how long, last activity, cost marked as a floor, commits", async () => {
    serve(RUNS);
    const el = await mount();
    const live = el.querySelector('a[href="/run/live"]')!;
    expect(live.querySelector(".bv-step")!.textContent).toBe("implementation.implement@2 · for 27m");
    expect(live.querySelector(".bv-activity")!.textContent).toBe("active 14s ago");
    expect(live.querySelector(".bv-cost")!.textContent).toBe("≥$1.95");
    expect(live.querySelector(".bv-commits")!.textContent).toBe("3 commits");
  });

  test("a parked row says how long it has waited; a finished one shows its PR chip and full cost", async () => {
    serve(RUNS);
    const el = await mount();
    expect(el.querySelector('a[href="/run/asking"] .bv-step')!.textContent).toBe("waiting 12m");
    const done = el.querySelector('a[href="/run/fresh-done"]')!;
    expect(done.querySelector(".bv-pr")!.textContent).toBe("PR merged");
    expect(done.querySelector(".bv-cost")!.textContent).toBe("$0.42");
  });

  test("a cost that is entirely unreported says so instead of '≥$0.00'", async () => {
    serve([row({ id: "codex", status: "done", outcome: "success", cost_usd: 0, cost_partial: true })]);
    const el = await mount();
    expect(el.querySelector(".bv-cost")!.textContent).toBe("unknown");
  });

  test("a running row that has gone quiet turns amber", async () => {
    serve([row({ id: "quiet", status: "running", current: { node: "b", visit: 1, since: iso(3_600_000) }, last_activity_at: iso(6 * 60_000) })]);
    const el = await mount();
    expect(el.querySelector(".bv-activity")!.getAttribute("data-quiet")).toBe("true");
  });

  test("ONE board stream drives refreshes, not a poll per row", async () => {
    serve(RUNS);
    await mount();
    expect(StubEventSource.urls).toEqual(["/api/board/events"]);
    const before = fetches;
    await act(async () => { StubEventSource.last!.onmessage!({ data: '{"changed":["live"]}' }); await new Promise((r) => setTimeout(r, 20)); });
    expect(fetches).toBe(before + 1);
  });

  test("the Supervisor chip says what 'not seen' means and what to do", async () => {
    serve(RUNS);
    const el = await mount();
    expect(el.querySelector(".home-strip")!.textContent).toContain("dead runs will not be resumed automatically");
    expect(el.querySelector(".home-strip")!.textContent).toContain("howdah up");
  });
});
