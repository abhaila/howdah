/**
 * The "Needs you" screen (HOW-20). Two things are pinned, because they are the two halves of
 * the ticket: a waiting run must be READABLE here — its reason, its node, its wait, and a
 * link to the card that answers it — and an empty inbox must SAY it is empty, because that is
 * how the operator learns the flood is over rather than wondering what the banners meant.
 *
 * HOW-67: the quiet "Ready for you" tier is pinned from the other side — it lists a finished
 * draft and links to its review page, and it NEVER chimes, raises the favicon or goes amber;
 * while an amber ask (a twice-refused draft's park) still does all three.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "../../engine/attention-inbox";
import type { ReadyItem } from "../draft";
import { AttentionInbox, inboxLine } from "./screens/attention";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realAudio = globalThis.Audio;
let favicon: HTMLLinkElement | null = null;

const ITEM: InboxItem = {
  id: "implement-ticket-mu9kvg39:implementation.plan:1",
  run: "implement-ticket-mu9kvg39",
  graph: "implement-ticket",
  node: "implementation.plan",
  visit: 1,
  reason: "attempt failed",
  raised_at: "2026-09-20T12:00:00.000Z",
  waited: "waiting 2h 11m",
  deep_link: "http://localhost:4711/run/implement-ticket-mu9kvg39#needs-input",
  href: "/run/implement-ticket-mu9kvg39#needs-input",
};

/** the one record that is about the harness, not a run — there is no /run/howdah to open */
const HARNESS_ITEM: InboxItem = {
  id: "howdah:__harness__:1",
  run: "howdah",
  graph: "",
  node: "__harness__",
  visit: 1,
  reason: "harness process 41234 is dead (heartbeat stale) — run `howdah up`",
  raised_at: "2026-09-20T12:00:00.000Z",
  waited: "waiting 20m",
  deep_link: "http://localhost:4711/attention",
  href: null,
};

function serve(body: unknown, status = 200, ready: unknown = [], settings: unknown = { chime: true }) {
  globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/settings")) return new Response(JSON.stringify(settings), { status: 200, headers: { "content-type": "application/json" } });
    const isReady = url.includes("/api/ready");
    return new Response(JSON.stringify(isReady ? ready : body), { status: isReady ? 200 : status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const READY: ReadyItem = {
  run: "draft-graph-mv1",
  name: null,
  intent: "like quick-task with a review",
  finished_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  href: "/runs/draft-graph-mv1/draft",
};

/** a twice-refused draft: the engine parked it and raised an ordinary attention record */
const REFUSED_DRAFT: InboxItem = {
  ...ITEM,
  id: "draft-graph-mv2:graph.draft:1",
  run: "draft-graph-mv2",
  graph: "draft-graph",
  node: "graph.draft",
  reason: "output contract violation: the draft cannot be saved: `runs:launch` is not something a draft may use",
  href: "/run/draft-graph-mv2#needs-input",
};

/** count chimes, and give the favicon hook a link to animate */
function watchSurfaces(): { chimes: () => number } {
  let n = 0;
  globalThis.Audio = class { constructor() { n++; } play() { return Promise.resolve(); } } as unknown as typeof Audio;
  favicon = document.createElement("link");
  favicon.id = "favicon";
  favicon.href = "/favicon.svg";
  document.head.appendChild(favicon);
  return { chimes: () => n };
}

async function render(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<AttentionInbox />); });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  globalThis.Audio = realAudio;
  favicon?.remove();
  favicon = null;
});

describe("AttentionInbox", () => {
  test("a waiting run reads as run, node, reason and wait — and links to its ask", async () => {
    serve([ITEM]);
    const el = await render();
    // HOW-68: rows are found by `data-nav-row` and cells by `data-col` — `.run-row` and
    // `.wait-timer` were howdah.css hooks, and the row is drawn with primitives now
    const row = el.querySelector("a[data-nav-row]") as HTMLAnchorElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("href")).toBe("/run/implement-ticket-mu9kvg39#needs-input");
    expect(row.textContent).toContain("attempt failed");
    expect(row.textContent).toContain("implementation.plan");
    expect(row.querySelector('[data-col="waited"]')!.textContent).toBe("2h 11m"); // HOW-68: the heading says "Waiting on you" once; the column is the number
    // the wait is plain text: the triangle already said "waiting on you" (DESIGN.md rule 1)
    expect(row.querySelector('[data-col="waited"]')!.className).not.toContain("attention");
    expect(row.querySelector("svg.status-glyph")!.getAttribute("data-shape")).toBe("triangle");
    // HOW-68: the row carries the FACT and no paint. It used to assert the amber tint
    // (`--attention-bg`); DESIGN.md rule 1 says the alarm is said once, and a tinted row beside
    // an amber glyph and an amber nav count said it three times. Row keeps `data-needs-input`.
    expect(row.getAttribute("data-needs-input")).toBe("true");
    expect(row.className).not.toContain("var(--attention");
  });

  test("a record with no run page is readable text, not a link to a run that does not exist", async () => {
    serve([HARNESS_ITEM]);
    const el = await render();
    expect(el.querySelectorAll("a")).toHaveLength(0); // /run/howdah says "No run howdah"
    const row = el.querySelector("[data-needs-input]")!;
    expect(row.textContent).toContain("howdah up"); // the fix is in the reason, where it reads
    expect(row.querySelector('[data-col="waited"]')!.textContent).toBe("20m");
    // D22: there is no step column any more; `__harness__` is not a step anyone can open, so it is not printed at all
    expect(row.querySelector('[data-col="step"]')).toBeNull();
    expect(row.textContent).not.toContain("__harness__");
  });

  test("nothing waiting says so", async () => {
    serve([]);
    const el = await render();
    expect(el.querySelector(".empty")!.textContent).toContain("Every run is on its own") // HOW-68: the title already says "Nothing needs you"; the body does not repeat it in lower case;
    expect(el.querySelectorAll("a[data-nav-row]")).toHaveLength(0);
  });

  test("a finished draft sits under Ready for you — quiet: no amber, no chime, no favicon raise", async () => {
    const surfaces = watchSurfaces();
    serve([], 200, [READY]);
    const el = await render();
    const group = el.querySelector('section[aria-label="Ready for you"]')!;
    expect(group.querySelector("h2")!.textContent).toContain("Ready for you");
    const row = group.querySelector("a[data-nav-row]") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/runs/draft-graph-mv1/draft");
    expect(row.textContent).toContain("like quick-task with a review");
    expect(row.textContent).toContain("finished 4m ago");
    expect(row.className).not.toContain("--attention"); // not the needs-input row state
    // HOW-68: the chip sits in the row's middle cell now (the first cell is the status glyph)
    const badge = [...row.querySelectorAll("span")].find((x) => x.textContent === "ready" && x.className.includes("border"))!;
    expect(badge.className).toContain("border-border"); // the outline badge…
    expect(badge.className).not.toContain("bg-primary"); // …never the amber one
    expect(badge.querySelector("svg")).not.toBeNull(); // the neutral glyph
    expect(row.querySelector("svg.status-glyph")!.getAttribute("data-shape")).toBe("check"); // a finished run, not a waiting one
    expect(row.outerHTML).not.toContain("attention"); // nothing amber anywhere in a ready row
    expect(el.querySelector('[data-col="waited"]')).toBeNull(); // the wait column is the asks' alone
    expect(el.querySelector(".empty")).toBeNull();
    expect(el.textContent).toContain("Nothing is waiting on you.");
    await act(async () => { await Bun.sleep(1000); });
    expect(surfaces.chimes()).toBe(0);
    expect(favicon!.getAttribute("href")).toBe("/favicon.svg");
  });

  test("a twice-refused draft is an ordinary amber ask: it chimes, raises the favicon, and is not 'ready'", async () => {
    const surfaces = watchSurfaces();
    // HOW-68: the sound is for NEWS. This session has already looked and seen nothing waiting,
    // so the ask below is new; the settings fixture has the sound turned on.
    window.dispatchEvent(new Event("howdah:settings-changed"));
    sessionStorage.setItem("howdah-asks-seen", "[]");
    serve([REFUSED_DRAFT], 200, []);
    const el = await render();
    const row = el.querySelector("a[data-nav-row]") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/run/draft-graph-mv2#needs-input");
    // HOW-68: marked as waiting, not tinted (see the first test in this file)
    expect(row.getAttribute("data-needs-input")).toBe("true");
    expect(row.textContent).toContain("runs:launch");
    expect(el.querySelector('section[aria-label="Ready for you"]')).toBeNull();
    await act(async () => { await Bun.sleep(1000); });
    expect(surfaces.chimes()).toBe(1);
    expect(favicon!.getAttribute("href")).toMatch(/^\/favicon-raise-\d\.svg$/);
  });

  test("asks and ready drafts together: the asks first, the quiet group under them", async () => {
    serve([ITEM], 200, [READY]);
    const el = await render();
    const rows = [...el.querySelectorAll("a[data-nav-row]")].map((a) => a.getAttribute("href"));
    expect(rows).toEqual(["/run/implement-ticket-mu9kvg39#needs-input", "/runs/draft-graph-mv1/draft"]);
  });

  // HOW-68 confirming review: this used to expect the skeleton to STAY, which in a browser was a
  // screen that loads for ever while the server is down. The half worth keeping is unchanged — a
  // failed read is never drawn as "Nothing needs you" — and the failure is now said, with a retry.
  test("a failed first read says so and offers a retry — never the loading state for ever, never 'nothing needs you'", async () => {
    serve({ error: "nope" }, 500);
    const el = await render();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain("did not answer");
    expect(el.textContent).toContain("Could not load what needs you");
    expect(el.textContent).not.toContain("Nothing needs you");
    expect(el.querySelector("h1")!.textContent).toBe("Needs you");
    // Try again reads again, and a good answer replaces the error
    serve([ITEM]);
    const retry = [...el.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelector('a[href="/run/implement-ticket-mu9kvg39#needs-input"]')).not.toBeNull();
  });
  // HOW-68: the row says WHAT is being asked, in the sentence the run's own ask card uses
  test("a row joined to the board reads as name, question, step and wait — the long id never crowds out the reason", async () => {
    const LONG = "implement-ticket-how-431-add-rate-limit-headers-to-the-public-api-gateway-and-document-them-mhv3a7xw";
    const item: InboxItem = { ...ITEM, id: `${LONG}:delivery.publish:1`, run: LONG, node: "delivery.publish", reason: "five sentences\nand a CLI command", href: `/run/${LONG}#needs-input` };
    const board = [{
      id: LONG, graph: "implement-ticket", name: "HOW-431 Rate-limit headers", parent: null, goal: "g", status: "needs-input", started_at: null, last_event_at: null,
      waiting_since: "2026-09-20T12:00:00.000Z", needs_input_reason: item.reason, failure: null, paused: false, outcome: null,
      current: { node: "delivery.publish", visit: 1, since: "2026-09-20T12:00:00.000Z" }, last_activity_at: null, cost_usd: 0, cost_partial: false, commits: null, pr: null,
      park: { code: "acceptance-unmet", node: "delivery.publish", visit: 1, ask: null },
    }];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/api/ready") ? [] : url.includes("/api/runs") ? board : url.includes("/api/settings") ? {} : [item];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const el = await render();
    await act(async () => { await Bun.sleep(20); });
    const row = el.querySelector("a[data-nav-row]")!;
    const cell = (name: string) => row.querySelector(`[data-col="${name}"]`)!.textContent!.replace(/\s+/g, " ").trim();
    expect(cell("name")).toBe("HOW-431 Rate-limit headers"); // the NAME, not the 100-character id
    // D22: the step column is gone — it repeated what most sentences already say and cut the
    // sentence at 1024. Where the sentence does not name the step, the id follows it.
    expect(cell("line")).toBe("Publish? Some acceptance criteria are not proven.·delivery.publish");
    expect(row.querySelector('[data-col="step"]')).toBeNull();
    // in a slot of its own, so a long sentence cannot cut it off the row
    expect(row.querySelector('[data-col="line"] [data-slot="inbox-step"] [data-slot="truncate"]')!.textContent).toBe("delivery.publish");
    expect(cell("waited")).toBe("2h 11m");
    expect(row.textContent).not.toContain(LONG);
    // every cell that can be long is a Truncate, so nothing wraps into the next row (audit 3.1.8)
    for (const name of ["name", "line"]) expect(row.querySelector(`[data-col="${name}"] [data-slot="truncate"]`), name).not.toBeNull();
  });

  test("D22: a sentence that already names the step does not get the id a second time", () => {
    const named = inboxLine({ ...ITEM, node: "implementation.plan", reason: "implementation.plan failed: exit 1" }, undefined, Date.now());
    expect(named.stepAfter).toBeNull();
    const unnamed = inboxLine({ ...ITEM, node: "plan.approve", reason: "A proposal is waiting for your decision." }, undefined, Date.now());
    expect(unnamed.stepAfter).toBe("plan.approve");
    expect(inboxLine({ ...ITEM, node: "__harness__", reason: "run `howdah up`" }, undefined, Date.now()).stepAfter).toBeNull();
  });

  test("inboxLine: a run the board does not know, or whose park is a different ask, falls back to the record's own first line", () => {
    const fallback = inboxLine({ ...ITEM, reason: "\nfirst line\nsecond" }, undefined, Date.now());
    expect(fallback).toMatchObject({ name: ITEM.run, named: false, body: "first line", step: "implementation.plan" });
    expect(fallback.line.parts.map((p) => p.value)).toEqual(["Needs you.", "first line"]);
    expect(fallback.stepAfter).toBe("implementation.plan"); // D22: printed after the sentence, not in a column
    expect(inboxLine(HARNESS_ITEM, undefined, Date.now()).step).toBeNull();
  });
});

test("waitedColumn: the server's sentence becomes the board's column, hours padded (HOW-68)", async () => {
  const { waitedColumn } = await import("./screens/attention");
  expect(waitedColumn("waiting 19h 6m")).toBe("19h 06m");
  expect(waitedColumn("waiting 2h 11m")).toBe("2h 11m");
  expect(waitedColumn("waiting 20m")).toBe("20m");
  expect(waitedColumn("3d")).toBe("3d"); // an unexpected shape is printed as given
});
