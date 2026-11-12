/**
 * HOW-68 — the operator's first hands-on feedback on the redesigned run view, as behaviour:
 *
 *   "Would like full screen for the plan"           → focus: F hides the sidebar, the header and
 *                                                     the drawer; Esc or F leaves; per session.
 *   "dynamically change width of details"           → the drawer's edge is a separator: arrows,
 *                                                     Home/End, Enter resets, width remembered.
 *   "bring back link of PR on details"              → the pull request LEADS the drawer and sits
 *                                                     beside the status; the poll that buried it
 *                                                     (thirteen probe/wait pairs) folds to a row.
 *   "Link of PR … tries to open it within howdah"   → every external link is a new tab, and the
 *                                                     shell does not route a `target` link in-app.
 *
 * (The plan's layout and the report frame's sandbox are pinned in plan.test.tsx; the report
 * page's own links in core/run-report.test.ts. What needs real pixels — the drag, the popup, the
 * widths — is driven in a browser by tools/visual's `feedback-*` steps.)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { GRAPHS } from "../../graphs/index";
import { RunView, OPEN_GRACE_MS, foldTimeline, runPullRequests } from "./run/view";
import { RunSteps, foldedBlocks } from "./run/steps";
import { Drawer, DRAWER_MIN } from "./components/ui/drawer";
import { ToastProvider } from "./components/ui/toast";
import { allShortcuts, installShortcuts, isMac, resetShortcutsForTest } from "./lib/shortcuts";

let root: Root | null = null;
let host: HTMLElement | null = null;
let uninstall: () => void = () => {};
const realFetch = globalThis.fetch;

class StubEventSource {
  onmessage: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource;
  localStorage.clear();
  sessionStorage.clear();
  delete document.documentElement.dataset.runFocus;
  resetShortcutsForTest();
  uninstall = installShortcuts();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  uninstall();
  globalThis.fetch = realFetch;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ToastProvider>{node}</ToastProvider>));
  return host;
}
const settle = (ms = 50) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
}
const MOD: KeyboardEventInit = isMac() ? { metaKey: true } : { ctrlKey: true };
function serve(body: unknown) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? url;
    if ((init?.method ?? "GET") !== "GET") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (!/\/api\/runs\/[^/]+(?:\/shell)?$/.test(path)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const PR = "https://github.com/acme/acme-api/pull/4133";
const DECL = { publication_summary: { scope: "sticky" as const, writer: ["delivery.publish"] }, "pr.state": { scope: "per-visit" as const, writer: ["delivery.probe_pr"] } };

/** a run that published a PR and has polled it `polls` times — the operator's screenshot */
function polling(polls: number, opts: { forge?: boolean; state?: string } = {}) {
  const { forge = true, state = "OPEN" } = opts;
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: { goal: "move the secrets" }, pinned_prompts: {} });
  log.add({ type: "node-started", node: "delivery.publish", visit: 1, attempt_id: "delivery.publish#1" });
  log.add({ type: "node-finished", node: "delivery.publish", visit: 1, status: "succeeded", writes: { publication_summary: `Opened ${PR} — "Move the webhook secrets".` } });
  for (let i = 1; i <= polls; i++) {
    if (forge) log.add({ type: "reconciled", node: "delivery.probe_pr", git: { repo: true, branch: "howdah/r1", head: "abc", uncommitted: 0, unpushed: 0 }, forge: { kind: "pr", state: "OPEN", url: PR }, disagreements: [] });
    log.add({ type: "node-started", node: "delivery.probe_pr", visit: i, attempt_id: `delivery.probe_pr#${i}` });
    log.add({ type: "node-finished", node: "delivery.probe_pr", visit: i, status: "succeeded", writes: { "pr.state": state } });
    log.add({ type: "node-started", node: "delivery.wait", visit: i, attempt_id: `delivery.wait#${i}` });
    if (i < polls) log.add({ type: "node-finished", node: "delivery.wait", visit: i, status: "succeeded", writes: {} });
  }
  return deriveDetail("r1", log.events, DECL as never, { graphs: GRAPHS, runnerAlive: true });
}

const drawer = (el: HTMLElement) => el.querySelector('[data-slot="drawer"]');
async function open(detail: unknown): Promise<HTMLElement> {
  serve(detail);
  const el = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
  await settle();
  if (!drawer(el)) { press("i", MOD); await settle(); }
  return el;
}

describe("the pull request is easy to find", () => {
  test("runPullRequests: the probed PR, with the forge's word for it", () => {
    expect(runPullRequests(polling(2))).toEqual([{ url: PR, label: "acme-api #4133", state: "open" }]);
  });

  test("with ONE pull request the routing fact is its state: changes requested, CI failed, conflicts", () => {
    expect(runPullRequests(polling(2, { state: "CHANGES_REQUIRED" }))[0]!.state).toBe("changes requested");
    expect(runPullRequests(polling(2, { state: "CI_FAILED" }))[0]!.state).toBe("CI failed");
    expect(runPullRequests(polling(2, { state: "CONFLICTS" }))[0]!.state).toBe("conflicts");
    // the forge's own final word wins over a stale routing fact
    const merged = polling(2, { state: "CHANGES_REQUIRED" });
    expect(runPullRequests({ ...merged, pull_requests: [{ url: PR, state: "MERGED", observed_at: "" }] })[0]!.state).toBe("merged");
  });

  test("a PR no probe has reported is still a link, read from what the publish step said it opened — with NO state", () => {
    const unprobed = polling(1, { forge: false });
    expect(unprobed.pull_requests).toEqual([]); // the read model has nothing: this was "no PR link"
    expect(runPullRequests(unprobed)).toEqual([{ url: PR, label: "acme-api #4133", state: null }]);
  });

  test("a probed PR is the fact: another URL the summary merely mentions is not added beside it", () => {
    const d = polling(1);
    const mentions = { ...d, context: d.context.map((c) => (c.key === "publication_summary" ? { ...c, value: `Opened ${PR}, stacked on https://github.com/acme/acme-api/pull/4100` } : c)) };
    expect(runPullRequests(mentions).map((p) => p.url)).toEqual([PR]);
  });

  test("a run with no pull request has none, and a veiled or unwritten summary is not read", () => {
    const d = polling(1, { forge: false });
    expect(runPullRequests({ pull_requests: [], context: [] })).toEqual([]);
    expect(runPullRequests({ pull_requests: [], context: d.context.map((c) => ({ ...c, veiled: true })) })).toEqual([]);
  });

  test("it LEADS the Details drawer, as a link that opens in the operator's browser, with its state", async () => {
    const el = await open(polling(13));
    const groups = [...drawer(el)!.querySelectorAll(".run-details-group")];
    expect(groups[0]!.querySelector("h3")!.textContent).toBe("Pull request");
    const link = groups[0]!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(PR);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("acme-api #4133");
    expect(groups[0]!.textContent).toContain("open");
    // it used to be the fifth group, under the timeline
    expect(groups.findIndex((g) => g.querySelector("h3")?.textContent === "Timeline")).toBeGreaterThan(0);
  });

  test("...and beside the run's status in the header, named for a screen reader", async () => {
    const el = await open(polling(2, { state: "CHANGES_REQUIRED" }));
    const chip = el.querySelector('.run-head [data-slot="run-pr"]')!;
    expect(chip.getAttribute("href")).toBe(PR);
    expect(chip.getAttribute("target")).toBe("_blank");
    expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
    expect(chip.getAttribute("aria-label")).toBe("Pull request acme-api #4133, changes requested — opens in your browser");
    expect(chip.textContent).toContain("#4133");
    // neither the chip nor the wrapper its tooltip adds may shrink: at 1024 with the drawer open
    // a wrapper that gave way let the number run under the "More" button (seen in the final capture)
    expect(chip.className).toContain("shrink-0");
    expect(chip.parentElement!.className).toContain("shrink-0");
    // it follows the status line, so the header still reads name · status · PR · actions
    expect(el.querySelector("#run-status")!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a run with no pull request shows neither", async () => {
    const d = polling(1, { forge: false });
    const el = await open({ ...d, context: [] });
    expect(el.querySelector('[data-slot="run-pr"]')).toBeNull();
    expect([...drawer(el)!.querySelectorAll(".run-details-group h3")].map((h) => h.textContent)).not.toContain("Pull request");
  });
});

describe("a poll is one row, not a wall", () => {
  const row = (node: string, visit: number, status = "succeeded", duration_ms: number | null = 60_000) => ({ node, visit, status, duration_ms });
  const kinds = (items: ReturnType<typeof foldTimeline>) => items.map((i) => (i.kind === "row" ? `${i.row.node}@${i.row.visit}` : `[${i.nodes.join("↔")} ×${i.times}]`));

  test("alternating visits of the same two steps fold, and the LATEST stays a row of its own", () => {
    const rows = [row("publish", 1), ...Array.from({ length: 13 }, (_, i) => [row("probe", i + 1, "succeeded", 2000), row("wait", i + 1, "succeeded", 300_000)]).flat(), row("probe", 14, "running", null)];
    const items = foldTimeline(rows);
    expect(kinds(items)).toEqual(["publish@1", "[probe↔wait ×13]", "probe@14"]);
    const fold = items[1]!;
    if (fold.kind !== "fold") throw new Error("expected a fold");
    expect(fold.rows).toHaveLength(26); // every visit is still there to be shown
    expect(fold.duration_ms).toBe(13 * 302_000);
  });

  test("three or more visits of ONE step fold the same way", () => {
    expect(kinds(foldTimeline([row("a", 1), row("retry", 1), row("retry", 2), row("retry", 3), row("retry", 4), row("b", 1)]))).toEqual(["a@1", "[retry ×3]", "retry@4", "b@1"]);
  });

  test("nothing folds below the threshold: two of one step, or one poll and a half", () => {
    const same = [row("a", 1), row("a", 2), row("b", 1)];
    expect(foldTimeline(same).every((i) => i.kind === "row")).toBe(true);
    // probe, wait, probe: a fold here would say "×1" and hide two rows to say nothing repeated
    const once = [row("publish", 2), row("probe", 2), row("wait", 1), row("probe", 3), row("done", 1)];
    expect(foldTimeline(once).every((i) => i.kind === "row")).toBe(true);
  });

  test("a failure is never folded away: it ends the run of repeats and stays visible", () => {
    const rows = [row("probe", 1), row("wait", 1), row("probe", 2), row("wait", 2), row("probe", 3, "failed"), row("wait", 3), row("probe", 4)];
    const items = foldTimeline(rows);
    expect(kinds(items)).toEqual(["[probe↔wait ×2]", "probe@3", "wait@3", "probe@4"]);
    expect(items.flatMap((i) => (i.kind === "fold" ? i.rows : [])).some((r) => r.status === "failed")).toBe(false);
  });

  test("a review ↔ repair loop is a pair like any other; an empty timeline is empty", () => {
    const rows = [row("create", 1), row("plan", 1), row("implement", 1), row("review", 1), row("implement", 2), row("review", 2)];
    expect(kinds(foldTimeline(rows))).toEqual(["create@1", "plan@1", "[implement↔review ×2]", "review@2"]);
    expect(foldTimeline([])).toEqual([]);
  });

  test("in the drawer: thirteen polls are ONE disclosure row, and opening it shows every visit", async () => {
    const el = await open(polling(13));
    const list = [...drawer(el)!.querySelectorAll(".run-details-group")].find((g) => g.querySelector("h3")?.textContent === "Timeline")!;
    // publish, the fold, and the visit the run is on — it was 27 rows
    expect(list.querySelectorAll(".run-details-row")).toHaveLength(3);
    const fold = list.querySelector<HTMLElement>("[data-fold]")!;
    expect(fold.tagName).toBe("BUTTON");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("delivery.probe_pr ↔ delivery.wait");
    expect(fold.textContent).toContain("×13");
    expect(fold.getAttribute("aria-label")).toMatch(/^delivery\.probe_pr ↔ delivery\.wait, 13 times over .+ — show the 25 visits$/);
    // the latest visit is outside the fold: it is where the run is
    expect(list.querySelector('.run-details-row[data-step-status="running"]')!.textContent).toContain("delivery.wait@13");
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(list.querySelectorAll(".run-details-folded .run-details-row")).toHaveLength(25);
    // a folded visit is still the way to its step
    expect(list.querySelector(".run-details-folded .run-details-row")!.getAttribute("aria-label")).toStartWith("open delivery.probe_pr@1 in Steps");
    act(() => fold.click());
    expect(list.querySelectorAll(".run-details-folded")).toHaveLength(0);
  });
});

// The feedback pass folded the drawer's timeline and left the STEPS list a wall of the same rows.
describe("the Steps list folds a poll by the same rule", () => {
  function Harness({ detail, initial = null }: { detail: ReturnType<typeof polling>; initial?: string | null }) {
    const [picked, setPicked] = useState<string | null>(initial);
    return (
      <>
        <RunSteps timeline={detail.timeline} ask={detail.ask} selected={picked} now={Date.now()} onSelect={setPicked} />
        <output data-testid="picked">{picked ?? ""}</output>
      </>
    );
  }
  const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".steps .step-row")];
  const picked = (el: HTMLElement) => el.querySelector('[data-testid="picked"]')!.textContent;
  const key = (k: string) => press(k, {}, document.activeElement ?? document.body);

  test("thirteen polls are publish, ONE fold and the visit the run is on; the fold opens to every visit", async () => {
    const el = mount(<Harness detail={polling(13)} />);
    await settle();
    expect(rows(el)).toHaveLength(3); // it was 27
    const fold = el.querySelector<HTMLElement>(".steps [data-fold]")!;
    expect(fold.tagName).toBe("BUTTON");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("×13");
    expect(fold.getAttribute("aria-label")).toMatch(/^delivery\.probe_pr ↔ delivery\.wait, 13 times over .+ — show the 25 visits$/);
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(rows(el)).toHaveLength(28);
    expect(picked(el)).toBe(""); // opening a fold selects nothing
    // a folded visit is still a step you can select
    act(() => rows(el)[2]!.click());
    expect(picked(el)).toBe("delivery.probe_pr@1");
  });

  test("the list is one tab stop, and J/K walk the VISIBLE rows — the fold is one of them", async () => {
    const el = mount(<Harness detail={polling(13)} initial="delivery.publish@1" />);
    await settle();
    expect(rows(el).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    act(() => rows(el)[0]!.focus());
    key("j");
    await settle();
    // on the fold: nothing new is selected, and the fold carries the cursor
    expect(picked(el)).toBe("delivery.publish@1");
    expect(document.activeElement).toBe(el.querySelector(".steps [data-fold]"));
    expect(el.querySelector(".steps [data-selected]")).toBe(document.activeElement);
    key("j");
    await settle();
    expect(picked(el)).toBe("delivery.wait@13"); // past the closed fold, to the latest visit
    key("k");
    await settle();
    act(() => (document.activeElement as HTMLElement).click()); // Enter on a button is a click: open it
    key("j");
    await settle();
    expect(picked(el)).toBe("delivery.probe_pr@1"); // now the visits inside are rows to walk
    expect(rows(el).filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  test("a step chosen from elsewhere that sits inside a fold opens it", async () => {
    const el = mount(<Harness detail={polling(13)} initial="delivery.wait@4" />);
    await settle();
    expect(el.querySelector(".steps [data-fold]")!.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".steps [data-selected]")!.getAttribute("aria-label")).toStartWith("delivery.wait@4");
  });

  test("parallel branches are a group of their own and are never folded into", () => {
    const t = (node: string, visit: number, parallel?: { node: string; visit: number }) =>
      ({ node, visit, status: "succeeded", duration_ms: 1000, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z", offset_ms: 0, run_span_ms: 1000, waiting_ms: 0, usage: null, profile: null, ...(parallel ? { parallel } : {}) }) as unknown as ReturnType<typeof polling>["timeline"][number];
    const fan = { node: "fan", visit: 1 };
    const blocks = foldedBlocks([t("a", 1), t("a", 2), t("a", 3), t("a", 4), t("x", 1, fan), t("y", 1, fan), t("x", 1, fan), t("y", 1, fan), t("b", 1)]);
    expect(blocks.map((b) => (b.kind === "fold" ? `fold×${b.times}` : `${b.kind}:${b.rows.length}`))).toEqual(["fold×3", "rows:1", "group:4", "rows:1"]);
  });
});

describe("focus: the open pane has the window", () => {
  const focused = () => document.documentElement.dataset.runFocus === "1";

  test("F hides the header and the drawer and tells the shell; F again, or Esc, leaves", async () => {
    const el = await open(polling(2));
    expect(el.querySelector(".run-head")).not.toBeNull();
    press("f");
    await settle(10);
    expect(focused()).toBe(true); // what howdah.css hides the sidebar on
    expect(el.querySelector(".run-head")).toBeNull();
    expect(drawer(el)).toBeNull();
    // the strip carries what the header said, and the way out
    const bar = el.querySelector('[data-slot="run-focus-bar"]')!;
    expect(bar.querySelector("#run-status")).not.toBeNull();
    expect(bar.querySelector('[data-slot="run-pr"]')).not.toBeNull();
    expect(bar.querySelector('button[aria-label="Leave focus"]')!.getAttribute("aria-pressed")).toBe("true");
    press("f");
    await settle(10);
    expect(focused()).toBe(false);
    expect(el.querySelector(".run-head")).not.toBeNull();
    expect(drawer(el)).not.toBeNull(); // the drawer was open before, and it is open again
    press("f");
    await settle(10);
    press("Escape");
    await settle(10);
    expect(focused()).toBe(false);
    expect(el.querySelector('[data-slot="run-focus-bar"]')).toBeNull();
  });

  // The final pass, in a browser: the control that toggles focus is unmounted by the toggle, so
  // pressing it left keyboard focus on <body>.
  test("pressing the control hands keyboard focus to its counterpart, both ways", async () => {
    const el = await open(polling(2));
    const enter = el.querySelector<HTMLElement>('button[aria-label="Focus the pane"]')!;
    enter.focus();
    act(() => enter.click());
    await settle(10);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Leave focus");
    act(() => (document.activeElement as HTMLElement).click());
    await settle(10);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Focus the pane");
    // F with focus somewhere in the pane leaves it there
    const tabEl = el.querySelector<HTMLElement>('.run-tabs [role="tab"]')!;
    tabEl.focus();
    press("f", {}, tabEl);
    await settle(10);
    expect(document.activeElement).toBe(tabEl);
    // ...and F with focus on nothing moves it nowhere: a button that took focus on every F
    // raised its tooltip over the tab strip (seen in a browser)
    tabEl.blur();
    press("f");
    await settle(10);
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  test("the control does the same, and every tab can be read focused", async () => {
    const el = await open(polling(2));
    act(() => el.querySelector<HTMLElement>('button[aria-label="Focus the pane"]')!.click());
    expect(focused()).toBe(true);
    for (const key of ["1", "2", "3"]) {
      press(key);
      await settle(10);
      expect(el.querySelector(".run-body")!.getAttribute("data-tab")).toBe(["plan", "chat", "report"][Number(key) - 1]!);
      expect(focused()).toBe(true);
    }
    act(() => el.querySelector<HTMLElement>('button[aria-label="Leave focus"]')!.click());
    expect(focused()).toBe(false);
  });

  test("it is remembered for the session, and taken back when the run is left", async () => {
    const el = await open(polling(2));
    press("f");
    await settle(10);
    expect(sessionStorage.getItem("howdah.run.focus")).toBe("1");
    expect(localStorage.getItem("howdah.run.focus")).toBeNull(); // a way of reading, not a machine preference
    act(() => root!.unmount());
    root = null;
    expect(focused()).toBe(false); // another screen gets its sidebar back
    el.remove();
    // (mounted bare: the `open` helper presses ⌘I when it sees no drawer, which leaves focus)
    const again = mount(<RunView id="r1" graceMs={OPEN_GRACE_MS} />);
    await settle();
    expect(focused()).toBe(true);
    expect(again.querySelector(".run-head")).toBeNull();
  });

  test("⌘I while focused means `show me the details`: it leaves focus and opens them", async () => {
    const el = await open(polling(2));
    press("i", MOD); // close the drawer first
    await settle(10);
    press("f");
    await settle(10);
    press("i", MOD);
    await settle(10);
    expect(focused()).toBe(false);
    expect(drawer(el)).not.toBeNull();
  });

  test("F is a row in the one registry, so `?` lists it; and the shell rule exists", async () => {
    await open(polling(2));
    const row = allShortcuts().find((s) => s.id === "run.focus")!;
    expect(row).toMatchObject({ scope: "A run", keys: "f" });
    expect(row.label).toContain("Focus the pane");
    const css = readFileSync(new URL("../public/howdah.css", import.meta.url), "utf8");
    expect(css).toContain(":root[data-run-focus] .sidebar { display: none; }");
  });

  test("typing an f into a field is a letter, not a command", async () => {
    const el = await open(polling(2));
    const field = document.createElement("textarea");
    el.appendChild(field);
    press("f", {}, field);
    await settle(10);
    expect(focused()).toBe(false);
  });
});

describe("the Details drawer can be resized", () => {
  function Harness({ fixed = false }: { fixed?: boolean }) {
    const resizeKey = fixed ? undefined : "howdah.test.drawer";
    const [open, setOpen] = useState(true);
    return (
      <div data-testid="room">
        <Drawer open={open} onClose={() => setOpen(false)} label="Run details" resizeKey={resizeKey}><p>the details</p></Drawer>
      </div>
    );
  }
  const sep = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-slot="drawer-resize"]')!;
  const width = (el: HTMLElement) => (drawer(el) as HTMLElement).style.width;

  test("its edge is a real separator: named, focusable, with the value and its floor", () => {
    const el = mount(<Harness />);
    const s = sep(el);
    expect(s.getAttribute("role")).toBe("separator");
    expect(s.getAttribute("aria-orientation")).toBe("vertical");
    expect(s.tabIndex).toBe(0);
    expect(s.getAttribute("aria-label")).toContain("Resize Run details");
    expect(s.getAttribute("aria-valuenow")).toBe("320");
    expect(s.getAttribute("aria-valuemin")).toBe(String(DRAWER_MIN));
    expect(width(el)).toBe("320px");
    // 24px to grab (Tailwind's w-6, on the box that extends the 8px lane), with the 2px ring every focus stop shows
    expect(s.className).toContain("before:w-6");
    expect(s.className).toContain("focus-visible:outline-2");
  });

  test("the arrows resize it (left is wider: it is pinned to the right), Shift for more, and the width is remembered", () => {
    const el = mount(<Harness />);
    press("ArrowLeft", {}, sep(el));
    expect(width(el)).toBe("344px");
    expect(sep(el).getAttribute("aria-valuenow")).toBe("344");
    press("ArrowLeft", { shiftKey: true }, sep(el));
    expect(width(el)).toBe("440px");
    press("ArrowRight", {}, sep(el));
    expect(width(el)).toBe("416px");
    expect(localStorage.getItem("howdah.test.drawer.width")).toBe("416");
  });

  test("End is the narrowest it goes, and it never goes under 280px", () => {
    const el = mount(<Harness />);
    press("End", {}, sep(el));
    expect(width(el)).toBe("280px");
    press("ArrowRight", {}, sep(el));
    expect(width(el)).toBe("280px");
  });

  test("Enter and a double-click go back to the default", () => {
    const el = mount(<Harness />);
    press("ArrowLeft", { shiftKey: true }, sep(el));
    press("Enter", {}, sep(el));
    expect(width(el)).toBe("320px");
    press("ArrowLeft", {}, sep(el));
    act(() => { sep(el).dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
    expect(width(el)).toBe("320px");
  });

  test("a remembered width is where it opens next time; junk is ignored", () => {
    localStorage.setItem("howdah.test.drawer.width", "456");
    expect(width(mount(<Harness />))).toBe("456px");
    act(() => root!.unmount());
    host!.remove();
    localStorage.setItem("howdah.test.drawer.width", "12"); // under the floor: not a width
    expect(width(mount(<Harness />))).toBe("320px");
  });

  // The feedback pass's open item: a width remembered on a wide window is clamped at render on a
  // narrow one, and the drag and the arrows were still measured from the REMEMBERED number — the
  // edge ignored the first few hundred pixels and then jumped; the first key presses did nothing.
  describe("render-clamped on a narrow window", () => {
    const proto = window.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const originalRect = proto.getBoundingClientRect;
    beforeEach(() => {
      // the room is 1000px wide: the drawer may take half of it
      Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "room" ? 1000 : 0; } });
      proto.getBoundingClientRect = function (this: HTMLElement) {
        return (this.dataset.testid === "room" ? { left: 0, right: 1000, top: 0, bottom: 600, width: 1000, height: 600, x: 0, y: 0, toJSON() {} } : originalRect.call(this)) as DOMRect;
      };
      localStorage.setItem("howdah.test.drawer.width", "900");
    });
    afterEach(() => {
      if (original) Object.defineProperty(proto, "clientWidth", original); else delete (proto as unknown as Record<string, unknown>).clientWidth;
      proto.getBoundingClientRect = originalRect;
    });

    test("the first arrow press moves it from where it IS", () => {
      const el = mount(<Harness />);
      expect(width(el)).toBe("500px"); // 900 remembered, half the room shown
      press("ArrowRight", {}, sep(el));
      expect(width(el)).toBe("476px");
    });

    test("a drag follows the pointer from the first pixel", () => {
      const el = mount(<Harness />);
      const s = sep(el);
      s.setPointerCapture = () => {};
      s.releasePointerCapture = () => {};
      const pointer = (type: string, clientX: number) => act(() => { s.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }) as unknown as Event); });
      pointer("pointerdown", 500); // on the edge: the drawer is 500 of 1000
      pointer("pointermove", 540);
      expect(width(el)).toBe("460px"); // it was still 500 here, until the pointer had gone 400px
      pointer("pointermove", 620);
      expect(width(el)).toBe("380px");
      pointer("pointerup", 620);
      expect(localStorage.getItem("howdah.test.drawer.width")).toBe("380");
    });
  });

  test("a drawer that was not asked to resize has no separator and stays the width it was given", () => {
    const el = mount(<Harness fixed />);
    expect(sep(el)).toBeNull();
    expect(width(el)).toBe("320px");
  });

  test("the run's Details drawer is the resizable one, and its width has its own key", async () => {
    const el = await open(polling(2));
    press("ArrowLeft", {}, sep(el));
    expect(localStorage.getItem("howdah.run.details.width")).toBe("344");
    // Escape on the separator still closes the drawer: it is inside it
    press("Escape", {}, sep(el));
    await settle(10);
    expect(drawer(el)).toBeNull();
  });
});

describe("a link that leaves the viewer opens in the operator's browser", () => {
  test("the shell routes in-app only links with no target and no download", () => {
    // the report's Open (`target=_blank`) and Download, and an evidence file, all start with `/`
    // — and were swallowed by the shell's client-side router, which showed a blank screen
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    expect(main).toContain(`closest("a[href^='/']:not([target]):not([download])")`);
  });

  test("every external link written in the viewer is a new tab that is handed nothing", () => {
    const { Glob } = Bun;
    const offenders: string[] = [];
    for (const file of new Glob("**/*.tsx").scanSync({ cwd: new URL(".", import.meta.url).pathname })) {
      if (file.endsWith(".test.tsx")) continue;
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const m of src.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) if (!/rel="[^"]*(noopener|noreferrer)/.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
