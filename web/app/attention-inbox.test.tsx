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
import { AttentionInbox } from "./screens/attention";

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

function serve(body: unknown, status = 200, ready: unknown = []) {
  globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
    const isReady = String(input instanceof Request ? input.url : input).includes("/api/ready");
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
    const row = el.querySelector("a.run-row") as HTMLAnchorElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("href")).toBe("/run/implement-ticket-mu9kvg39#needs-input");
    expect(row.textContent).toContain("attempt failed");
    expect(row.textContent).toContain("implementation.plan");
    expect(row.querySelector(".wait-timer")!.textContent).toBe("waiting 2h 11m");
    // the one row state allowed the alarm colour, straight off the shared Row primitive
    expect(row.className).toContain("var(--attention-bg)");
  });

  test("a record with no run page is readable text, not a link to a run that does not exist", async () => {
    serve([HARNESS_ITEM]);
    const el = await render();
    expect(el.querySelectorAll("a")).toHaveLength(0); // /run/howdah says "No run howdah"
    const row = el.querySelector(".run-row")!;
    expect(row.textContent).toContain("howdah up"); // the fix is in the reason, where it reads
    expect(row.querySelector(".wait-timer")!.textContent).toBe("waiting 20m");
  });

  test("nothing waiting says so", async () => {
    serve([]);
    const el = await render();
    expect(el.querySelector(".empty")!.textContent).toContain("nothing needs you");
    expect(el.querySelectorAll("a.run-row")).toHaveLength(0);
  });

  test("a finished draft sits under Ready for you — quiet: no amber, no chime, no favicon raise", async () => {
    const surfaces = watchSurfaces();
    serve([], 200, [READY]);
    const el = await render();
    const group = el.querySelector('section[aria-label="Ready for you"]')!;
    expect(group.querySelector("h2")!.textContent).toContain("Ready for you");
    const row = group.querySelector("a.run-row") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/runs/draft-graph-mv1/draft");
    expect(row.textContent).toContain("like quick-task with a review");
    expect(row.textContent).toContain("finished 4m ago");
    expect(row.className).not.toContain("--attention"); // not the needs-input row state
    const badge = row.querySelector('[data-slot="badge"]') ?? row.firstElementChild!;
    expect(badge.className).toContain("border-border"); // the outline badge…
    expect(badge.className).not.toContain("bg-primary"); // …never the amber one
    expect(badge.querySelector("svg")).not.toBeNull(); // the neutral glyph
    expect(el.querySelector(".wait-timer")).toBeNull(); // the amber timer is the asks' alone
    expect(el.querySelector(".empty")).toBeNull();
    expect(el.textContent).toContain("nothing is waiting on you");
    await act(async () => { await Bun.sleep(1000); });
    expect(surfaces.chimes()).toBe(0);
    expect(favicon!.getAttribute("href")).toBe("/favicon.svg");
  });

  test("a twice-refused draft is an ordinary amber ask: it chimes, raises the favicon, and is not 'ready'", async () => {
    const surfaces = watchSurfaces();
    serve([REFUSED_DRAFT], 200, []);
    const el = await render();
    const row = el.querySelector("a.run-row") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/run/draft-graph-mv2#needs-input");
    expect(row.className).toContain("var(--attention-bg)");
    expect(row.textContent).toContain("runs:launch");
    expect(el.querySelector('section[aria-label="Ready for you"]')).toBeNull();
    await act(async () => { await Bun.sleep(1000); });
    expect(surfaces.chimes()).toBe(1);
    expect(favicon!.getAttribute("href")).toMatch(/^\/favicon-raise-\d\.svg$/);
  });

  test("asks and ready drafts together: the asks first, the quiet group under them", async () => {
    serve([ITEM], 200, [READY]);
    const el = await render();
    const rows = [...el.querySelectorAll("a.run-row")].map((a) => a.getAttribute("href"));
    expect(rows).toEqual(["/run/implement-ticket-mu9kvg39#needs-input", "/runs/draft-graph-mv1/draft"]);
  });

  test("a failed read leaves the loading state alone rather than rendering a lie", async () => {
    serve({ error: "nope" }, 500);
    const el = await render();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector(".empty")).toBeNull();
  });
});
