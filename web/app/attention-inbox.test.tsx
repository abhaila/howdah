/**
 * The "Needs you" screen (HOW-20). Two things are pinned, because they are the two halves of
 * the ticket: a waiting run must be READABLE here — its reason, its node, its wait, and a
 * link to the card that answers it — and an empty inbox must SAY it is empty, because that is
 * how the operator learns the flood is over rather than wondering what the banners meant.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "../../engine/attention-inbox";
import { AttentionInbox } from "./screens/attention";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

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

function serve(body: unknown, status = 200) {
  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
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

  test("a failed read leaves the loading state alone rather than rendering a lie", async () => {
    serve({ error: "nope" }, 500);
    const el = await render();
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector(".empty")).toBeNull();
  });
});
