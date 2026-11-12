/**
 * The Logs list is windowed (HOW-68 final pass): switching to it on a long run was one
 * 600–760ms task, 200 rows each measuring three `Truncate`s. What is pinned here is that the
 * window is exact (fixed 28px rows), that the scroller's height does not change, and that the
 * SELECTED row is always in the DOM — J/K select a row and then focus it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LOG_ROW_HEIGHT, RunLogs, WINDOW_FROM, windowRows } from "./run/logs";

describe("windowRows", () => {
  test("a short list is rendered whole", () => {
    expect(windowRows(0, 0, 600, null)).toEqual([]);
    expect(windowRows(WINDOW_FROM, 0, 600, null)).toEqual([[0, WINDOW_FROM]]);
  });

  test("a long list renders what is on screen and twenty rows either side", () => {
    // 1000 rows, scrolled to row 500, a 560px pane (20 rows)
    expect(windowRows(1000, 500 * LOG_ROW_HEIGHT, 560, null)).toEqual([[480, 540]]);
    expect(windowRows(1000, 0, 560, null)).toEqual([[0, 40]]);
    expect(windowRows(1000, 1000 * LOG_ROW_HEIGHT - 560, 560, null)).toEqual([[960, 1000]]);
  });

  test("the selected row and its neighbours are rendered wherever they are", () => {
    expect(windowRows(1000, 500 * LOG_ROW_HEIGHT, 560, 10)).toEqual([[9, 12], [480, 540]]);
    expect(windowRows(1000, 500 * LOG_ROW_HEIGHT, 560, 900)).toEqual([[480, 540], [899, 902]]);
    // inside or touching the window: one span
    expect(windowRows(1000, 500 * LOG_ROW_HEIGHT, 560, 500)).toEqual([[480, 540]]);
    expect(windowRows(1000, 500 * LOG_ROW_HEIGHT, 560, 540)).toEqual([[480, 542]]);
    expect(windowRows(1000, 0, 560, 999)).toEqual([[0, 40], [998, 1000]]);
  });
});

describe("the Logs pane on a long run", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const realFetch = globalThis.fetch;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = host = null;
    globalThis.fetch = realFetch;
  });
  const page = (n: number) => ({
    total: n, oldest: 1,
    rows: Array.from({ length: n }, (_, i) => ({ seq: i + 1, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, type: "chunk", merged: 1, node: "do", visit: 1, kind: "tool", depth: 1, summary: `tool_result · row ${i + 1}` })),
  });
  async function mount(n: number): Promise<HTMLElement> {
    globalThis.fetch = (async () => new Response(JSON.stringify(page(n)), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<RunLogs runId="r1" />); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return host;
  }
  const heights = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".log-row, [aria-hidden][style]")]
    .reduce((sum, e) => sum + (e.classList.contains("log-row") ? LOG_ROW_HEIGHT : parseFloat(e.style.height || "0")), 0);

  test("200 events are a window of rows and spacers that add up to all 200", async () => {
    const el = await mount(200);
    const rows = el.querySelectorAll(".log-row");
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length).toBeLessThan(120);
    expect(heights(el)).toBe(200 * LOG_ROW_HEIGHT);
    // it opens pinned to the newest event, which is also the selected one — and it is in the DOM
    expect(el.querySelector(".log-row[data-selected]")!.getAttribute("aria-label")).toContain("chunk");
    expect(el.textContent).toContain("row 200");
    expect(el.textContent).not.toContain("row 1 "); // the top of the list is a spacer
    expect(el.textContent).toContain("200 of 200");
  });

  test("a short log renders every row and no spacer", async () => {
    const el = await mount(30);
    expect(el.querySelectorAll(".log-row")).toHaveLength(30);
    expect(heights(el)).toBe(30 * LOG_ROW_HEIGHT);
  });
});
