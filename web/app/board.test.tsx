/**
 * HOW-50 — the Runs screen as a live board: grouped, needs-you first, each row carrying its
 * vital signs, and fed by ONE board-level stream rather than a poll per row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RunBoardRow } from "../board";
import { RunsList, groupCount, groupRuns, waitingNotes } from "./screens/runs";
import { matchesFilter, prChip, runAge, runLine } from "./lib/board";
import { installShortcuts, resetShortcutsForTest } from "./lib/shortcuts";

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
    current: null, last_activity_at: null, cost_usd: 0, cost_partial: false, commits: null, pr: null, park: null,
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

/**
 * HOW-68 redrew the row: status glyph · name · WHAT IT IS WAITING FOR OR DOING · age · cost.
 * The assertions below used to read the old `.bv-*` columns ("waiting 12m", "active 14s ago",
 * "3 commits", a `PR merged` chip) and a `.home-strip`; they now read the new columns by
 * `data-col`, because the facts moved — a waiting row says its QUESTION where it said only how
 * long it had waited, and the vital signs are one sentence instead of four fixed cells.
 */
const col = (rowEl: Element, name: string) => rowEl.querySelector(`[data-col="${name}"]`)!;
/** a cell's words; the PR chip rides inside the line's cell and is read on its own */
const text = (rowEl: Element, name: string) => {
  const cell = col(rowEl, name).cloneNode(true) as Element;
  if (name === "line") cell.querySelector('[data-col="pr"]')?.remove();
  return cell.textContent!.replace(/\s+/g, " ").trim();
};

describe("the board", () => {
  test("needs-you is drawn above running, each row with ONE status glyph", async () => {
    serve(RUNS);
    const el = await mount();
    const heads = [...el.querySelectorAll("section[data-group]")].map((h) => h.getAttribute("data-group"));
    expect(heads).toEqual(["needs-you", "running", "recent", "older"]);
    expect([...el.querySelectorAll("section[data-group] h2")].map((h) => h.textContent)).toEqual(["Needs you1", "Running1", "Finished1", "Older1"]);
    const firstRow = el.querySelector("section[data-group] a[data-nav-row]")!;
    expect(firstRow.getAttribute("href")).toBe("/run/asking");
    // the status is a SHAPE with a name (DESIGN.md): one glyph per row, and it says which
    const glyphs = [...el.querySelectorAll("a[data-nav-row] svg.status-glyph")];
    expect(glyphs.map((g) => [g.getAttribute("data-shape"), g.getAttribute("aria-label")])).toEqual([
      ["triangle", "Waiting on you"], ["half", "Running"], ["check", "Done"], ["check", "Done"],
    ]);
  });

  test("a running row: its step, how long on it, last activity and commits in one line; cost marked as a floor", async () => {
    serve(RUNS);
    const el = await mount();
    const live = el.querySelector('a[href="/run/live"]')!;
    expect(text(live, "line")).toBe("implementation.implement · 27m on this step · active 14s ago · 3 commits");
    expect(col(live, "line").querySelector(".font-mono")!.textContent!.trim()).toBe("implementation.implement"); // the step id is the only mono in the row
    expect(text(live, "cost")).toBe("≥$1.95");
    expect(text(live, "age")).toBe("1h 00m"); // how long the run has been going
  });

  test("a parked row says WHAT it is waiting for, and for how long; a finished one its outcome, PR and full cost", async () => {
    serve([
      row({ id: "asking", status: "needs-input", waiting_since: iso(12 * 60_000), current: { node: "plan", visit: 1, since: iso(20 * 60_000) }, needs_input_reason: "five sentences and a CLI command", park: { code: "acceptance-unmet", node: "plan", visit: 1, ask: null } }),
      RUNS[3]!,
    ]);
    const el = await mount();
    const asking = el.querySelector('a[href="/run/asking"]')!;
    expect(text(asking, "line")).toBe("Publish? Some acceptance criteria are not proven.");
    expect(col(asking, "line").querySelector(".font-semibold")!.textContent!.trim()).toBe("Publish?"); // the bold label marks the row
    expect(text(asking, "age")).toBe("12m");
    const done = el.querySelector('a[href="/run/fresh-done"]')!;
    expect(text(done, "line")).toBe("Merged");
    expect(text(done, "pr")).toBe("PR"); // the row already said "Merged"
    expect(text(done, "cost")).toBe("$0.42");
  });

  test("THE ALARM IS SAID ONCE: a waiting row is marked by its glyph and bold label — no tint, no stripe, no amber text", async () => {
    serve(RUNS);
    const el = await mount();
    const asking = el.querySelector('a[href="/run/asking"]')!;
    expect(asking.getAttribute("data-needs-input")).toBe("true"); // the fact, without the paint
    expect(asking.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "")).not.toContain("attention");
    expect(asking.querySelector("svg.status-glyph")!.getAttribute("data-shape")).toBe("triangle");
  });

  test("a cost that is entirely unreported says so instead of '≥$0.00'", async () => {
    serve([row({ id: "codex", status: "done", outcome: "success", cost_usd: 0, cost_partial: true })]);
    const el = await mount();
    expect(text(el, "cost")).toBe("unknown");
  });

  test("a running row that has gone quiet says so in words — it no longer turns amber", async () => {
    serve([row({ id: "quiet", status: "running", current: { node: "b", visit: 1, since: iso(3_600_000) }, last_activity_at: iso(6 * 60_000) })]);
    const el = await mount();
    expect(col(el, "line").getAttribute("data-quiet")).toBe("true");
    expect(text(el, "line")).toBe("b · 1h 00m on this step · no output for 6m");
    expect(el.querySelector('a[data-nav-row]')!.outerHTML).not.toContain("attention"); // amber means waiting on you, only
  });

  test("ONE board stream drives refreshes, not a poll per row", async () => {
    serve(RUNS);
    await mount();
    expect(StubEventSource.urls).toEqual(["/api/board/events"]);
    const before = fetches;
    await act(async () => { StubEventSource.last!.onmessage!({ data: '{"changed":["live"]}' }); await new Promise((r) => setTimeout(r, 20)); });
    expect(fetches).toBe(before + 1);
  });

  test("a supervisor that is not running is one quiet line saying what that means and what to do", async () => {
    serve(RUNS);
    const el = await mount();
    const note = el.querySelector('[data-slot="supervisor-note"]')!;
    expect(note.textContent).toContain("will not be resumed automatically");
    expect(note.textContent).toContain("bun cli/main.ts up");
  });
});

describe("the row's words (lib/board.ts)", () => {
  const said = (r: RunBoardRow) => runLine(r, NOW).parts.map((p) => p.value).join(" ");

  test("every status says something a person can act on", () => {
    expect(said(row({ id: "a", status: "needs-input", park: { code: "harness-unauthenticated", node: "n", visit: 1, ask: null } }))).toBe("Log in. The agent's CLI is signed out on this machine.");
    expect(said(row({ id: "a", status: "needs-input", park: { code: null, node: "n", visit: 1, ask: { kind: "user-question", questions: [{ question: "Cursor or offset pagination?" }] } } }))).toBe("Question. Cursor or offset pagination?");
    expect(said(row({ id: "a", status: "harness-dead", current: { node: "build", visit: 1, since: iso(1000) } }))).toBe("Runner died. It stopped at build — resume it to continue.");
    expect(said(row({ id: "a", status: "failed-recoverable", failure: { node: "build", visit: 1, reason: "x", at: iso(0) } }))).toBe("Step failed. build can be retried.");
    expect(said(row({ id: "a", status: "waiting", paused: true, current: { node: "build", visit: 1, since: iso(1000) } }))).toBe("Paused at build");
    expect(said(row({ id: "a", status: "queued" }))).toBe("Queued");
    expect(said(row({ id: "a", status: "done", outcome: "success", commits: 2 }))).toBe("Done · 2 commits");
    expect(said(row({ id: "a", status: "failed-terminal", outcome: "failed", failure: { node: "triage.reproduce", visit: 1, reason: "x", at: iso(0) } }))).toBe("Failed at triage.reproduce");
    expect(said(row({ id: "a", status: "failed-terminal", outcome: "aborted" }))).toBe("Aborted");
  });

  test("a park this vocabulary does not know falls back to the engine's own first line, never to nothing", () => {
    const r = row({ id: "a", status: "needs-input", needs_input_reason: "\nthe harness asked for something new\nsecond line", park: { code: null, node: "n", visit: 1, ask: null } });
    expect(said(r)).toBe("Needs you. the harness asked for something new");
    // and a row from a read model with no park at all still renders (an older server)
    expect(said({ ...r, park: undefined as unknown as null })).toBe("Needs you. the harness asked for something new");
  });

  test("the PR chip does not repeat what the row already said", () => {
    expect(prChip(row({ id: "a", status: "done", pr: { url: "u", state: "MERGED" } }))).toBe("PR");
    expect(prChip(row({ id: "a", status: "running", pr: { url: "u", state: "OPEN" } }))).toBe("PR open");
    expect(prChip(row({ id: "a", status: "failed-terminal", pr: { url: "u", state: "CLOSED" } }))).toBe("PR closed");
    expect(prChip(row({ id: "a", status: "done" }))).toBeNull();
    // the forge's enum is not a word: the chip read "PR changes_required"
    expect(prChip(row({ id: "a", status: "needs-input", pr: { url: "u", state: "CHANGES_REQUIRED" as never } }))).toBe("PR changes required");
  });

  test("the age column means waiting, running or finished — and says which", () => {
    expect(runAge(row({ id: "a", status: "needs-input", waiting_since: iso(173 * 60_000) }), NOW)).toMatchObject({ text: "2h 53m", what: "Waiting on you since" });
    expect(runAge(row({ id: "a", status: "running" }), NOW)).toMatchObject({ text: "1h 00m", what: "Started" });
    expect(runAge(row({ id: "a", status: "done", last_event_at: iso(17 * 3_600_000) }), NOW)).toMatchObject({ text: "17h 00m ago", what: "Finished" });
  });

  test("the filter matches every word, across name, goal, id, graph, status and step", () => {
    const r = row({ id: "implement-ticket-abc", status: "needs-input", name: "Rate-limit headers", current: { node: "delivery.publish", visit: 1, since: iso(0) } });
    for (const q of ["", "rate", "RATE headers", "implement-ticket", "needs input", "needs-input", "publish", "abc rate"]) expect(matchesFilter(r, q), q).toBe(true);
    for (const q of ["webhook", "rate webhook", "done"]) expect(matchesFilter(r, q), q).toBe(false);
  });

  test("a notification's words: the run's name and the question, for waiting runs only", () => {
    expect(waitingNotes([
      row({ id: "a", status: "needs-input", name: "Paginate invoices", park: { code: null, node: "n", visit: 1, ask: { kind: "user-question", questions: [{ question: "Cursor or offset?" }] } } }),
      row({ id: "b", status: "running" }),
    ])).toEqual({ a: { name: "Paginate invoices", body: "Cursor or offset?" } });
  });
});

describe("the list's keyboard (HOW-68: J/K move, Enter opens, / filters)", () => {
  let uninstall: (() => void) | null = null;
  beforeEach(() => { resetShortcutsForTest(); uninstall = installShortcuts(); });
  afterEach(() => { uninstall?.(); resetShortcutsForTest(); });
  const press = (key: string, target: EventTarget = document.body) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  const selected = (el: HTMLElement) => [...el.querySelectorAll("a[data-selected]")].map((a) => a.getAttribute("href"));

  test("J and K move a visible selection through the rows in the order they are drawn, across groups", async () => {
    serve(RUNS);
    const el = await mount();
    expect(selected(el)).toEqual([]);
    press("j");
    expect(selected(el)).toEqual(["/run/asking"]);
    expect((document.activeElement as HTMLElement).getAttribute("href")).toBe("/run/asking"); // selection IS focus: Enter opens it natively
    press("j", document.activeElement!);
    press("ArrowDown", document.activeElement!);
    expect(selected(el)).toEqual(["/run/fresh-done"]);
    press("k", document.activeElement!);
    expect(selected(el)).toEqual(["/run/live"]);
    for (let i = 0; i < 6; i++) press("k", document.activeElement!);
    expect(selected(el)).toEqual(["/run/asking"]); // clamped, never wraps off the top
  });

  test("/ focuses the filter; typing narrows the list; Escape clears it; an empty result says so", async () => {
    serve(RUNS);
    const el = await mount();
    press("/");
    const filter = el.querySelector('input[type="search"]') as HTMLInputElement;
    expect(document.activeElement).toBe(filter);
    const type = (v: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, v);
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type("live");
    expect([...el.querySelectorAll("a[data-nav-row]")].map((a) => a.getAttribute("href"))).toEqual(["/run/live"]);
    press("j", filter); // a single key typed INTO the field is a character, not a command
    expect(selected(el)).toEqual([]);
    type("zzzz");
    expect(el.querySelectorAll("a[data-nav-row]")).toHaveLength(0);
    expect(el.textContent).toContain("No run matches “zzzz”");
    press("Escape", filter);
    expect(el.querySelectorAll("a[data-nav-row]")).toHaveLength(4);
  });

  test("the keys are rows in the ONE registry, so the ? sheet lists them", async () => {
    serve(RUNS);
    await mount();
    const { allShortcuts } = await import("./lib/shortcuts");
    const lists = allShortcuts().filter((s) => s.scope === "Lists").map((s) => [s.id, s.keys]);
    expect(lists).toEqual([["list.next", ["j", "arrowdown"]], ["list.prev", ["k", "arrowup"]], ["list.open", "enter"], ["list.filter", "/"]]);
  });

  test("a filter never hides a standing ask from the attention surfaces", async () => {
    serve(RUNS);
    const el = await mount();
    const filter = el.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "live");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(JSON.parse(sessionStorage.getItem("howdah-asks-seen") ?? "[]")).toContain("asking");
  });
});

describe("HOW-68 sign-off: the group count and the rail's badge cannot read as a contradiction", () => {
  const rows = (...statuses: RunBoardRow["status"][]) => statuses.map((status, i) => row({ id: `r${i}`, status }));
  test("only waiting runs: the bare number, which is the rail's number", () => {
    expect(groupCount("needs-you", rows("needs-input", "needs-input"))).toBe(2);
  });
  test("waiting runs beside stopped ones: the count says which is which", () => {
    expect(groupCount("needs-you", rows("needs-input", "needs-input", "harness-dead", "failed-recoverable")))
      .toBe("4 · 2 waiting on you, 2 to resume or retry");
  });
  test("only stopped runs, and every other group: the bare number", () => {
    expect(groupCount("needs-you", rows("harness-dead"))).toBe(1);
    expect(groupCount("running", rows("running", "waiting"))).toBe(2);
  });
  test("a run that produced output this second is active NOW, not \"0s ago\"", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    const live = row({ id: "a", status: "running", last_activity_at: "2026-11-12T11:59:59Z" });
    expect(runLine(live, now).parts.map((p) => p.value).join(" ")).toContain("active now");
  });
});
