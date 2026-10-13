/**
 * HOW-49 — the live progress panel: shown only while the newest step's turn is live, drawing
 * the agent's own plan, what landed in the worktree, and how long the agent has been quiet.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import type { LiveGit } from "../live-git";
import { PROGRESS_COLLAPSED_KEY, ProgressPanel } from "./run/progress";

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => localStorage.clear());
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
});

function building(harness = "claude"): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} });
  log.add({ type: "node-started", node: "build", visit: 1, attempt_id: "build#1" });
  log.add({ type: "prompt-rendered", node: "build", visit: 1, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness: harness as any });
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 0, kind: "text", content: "on it" });
  return log;
}

const GIT: LiveGit = {
  node: "build", visit: 1, commit_count: 2, uncommitted: 3, base: "abc", probed_at: new Date().toISOString(),
  last_commit_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  commits: [
    { sha: "b2", subject: "feat: the panel", at: new Date(Date.now() - 4 * 60_000).toISOString() },
    { sha: "a1", subject: "feat: the derivation", at: new Date(Date.now() - 9 * 60_000).toISOString() },
  ],
};

function render(log: FakeLog, runnerAlive: boolean, liveGit: LiveGit | null = null, variant: "pinned" | "rail" = "pinned"): HTMLElement {
  const detail = deriveDetail("r", log.events, {}, { runnerAlive });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ProgressPanel detail={detail} liveGit={liveGit} variant={variant} />));
  return host;
}

function planned(): FakeLog {
  const log = building();
  log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 1, kind: "tool_call", tool_id: "t", tool_name: "TodoWrite",
    content: JSON.stringify({ todos: [{ content: "Read", status: "completed" }, { content: "Build", status: "in_progress" }, { content: "Ship", status: "pending" }] }) });
  return log;
}

const toggleOf = (el: HTMLElement) => el.querySelector(".pp-toggle") as HTMLButtonElement | null;
const click = (b: HTMLElement) => act(() => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const remount = () => { act(() => root!.unmount()); host?.remove(); root = host = null; };

describe("ProgressPanel", () => {
  test("draws the latest TodoWrite as a checklist, with each item's state", () => {
    const log = building();
    log.add({ type: "chunk", node: "build", visit: 1, turn: 1, index: 1, kind: "tool_call", tool_id: "t", tool_name: "TodoWrite",
      content: JSON.stringify({ todos: [{ content: "Read", status: "completed" }, { content: "Build", status: "in_progress" }, { content: "Ship", status: "pending" }] }) });
    const el = render(log, true);
    const items = [...el.querySelectorAll(".pp-item")];
    expect(items.map((i) => i.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
    expect(el.textContent).toContain("1 of 3 done");
  });

  test("with no plan: 'not yet' for claude, 'not reported by this harness' for one that has no channel", () => {
    expect(render(building(), true).querySelector(".pp-empty")!.textContent).toBe("no plan reported yet");
    act(() => root!.unmount());
    expect(render(building("codex"), true).textContent).toContain("no plan reported by this harness");
  });

  test("commits and dirty files from the live probe; an earlier step's probe is ignored", () => {
    const el = render(building(), true, GIT);
    expect(el.textContent).toContain("2 commits this step");
    expect(el.textContent).toContain("3 uncommitted files");
    expect(el.textContent).toContain("last commit 4m ago");
    expect([...el.querySelectorAll(".pp-subject")].map((s) => s.textContent)).toEqual(["feat: the panel", "feat: the derivation"]);
    act(() => root!.unmount());
    const stale = render(building(), true, { ...GIT, node: "plan" });
    expect(stale.textContent).toContain("worktree not probed yet");
  });

  test("liveness turns amber once the agent has been quiet past the threshold", () => {
    const log = building();
    // FakeLog stamps 2026-09-19: the last chunk is weeks old, which is well past QUIET_MS
    const el = render(log, true);
    expect(el.querySelector(".pp-live")!.getAttribute("data-quiet")).toBe("true");
  });

  test("nothing at all unless the newest step's turn is live", () => {
    expect(render(building(), false).querySelector(".progress-panel")).toBeNull();
  });
});

// HOW-58: pinned above the transcript, the full panel pushed the stream itself down the column
describe("ProgressPanel collapse (pinned only)", () => {
  test("expanded by default: a disclosure that controls the body, with plan and worktree showing", () => {
    const el = render(planned(), true, GIT);
    const t = toggleOf(el)!;
    expect(t.tagName).toBe("BUTTON");
    expect(t.getAttribute("aria-expanded")).toBe("true");
    expect(t.getAttribute("aria-label")).toBe("Collapse live progress for build@1");
    expect(el.querySelector(`#${CSS.escape(t.getAttribute("aria-controls")!)}`)).not.toBeNull();
    expect(el.querySelectorAll(".pp-item")).toHaveLength(3);
    expect(el.textContent).toContain("2 commits this step");
    expect(el.querySelector(".pp-summary")).toBeNull();
  });

  test("collapsed: one line — step, liveness and a summary — and no plan, evidence or worktree blocks", () => {
    const el = render(planned(), true, GIT);
    click(toggleOf(el)!);
    const t = toggleOf(el)!;
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(t.getAttribute("aria-label")).toBe("Expand live progress for build@1");
    expect(t.hasAttribute("aria-controls")).toBe(false); // never point at an element that is not there
    expect(el.querySelector(".progress-panel")!.getAttribute("data-collapsed")).toBe("true");
    expect(el.querySelector(".pp-body")).toBeNull();
    expect(el.querySelectorAll(".pp-block")).toHaveLength(0);
    expect(el.querySelector(".pp-step")!.textContent).toBe("build@1");
    expect(el.querySelector(".pp-summary")!.textContent).toBe("plan 1 of 3 done · 2 commits");
    // still says whether the agent is moving, amber included
    const live = el.querySelector(".pp-live")!;
    expect(live.textContent).toContain("working · last activity");
    expect(live.getAttribute("data-quiet")).toBe("true");
  });

  test("the summary names only the facts there are: no plan and no probe is no summary at all", () => {
    const el = render(building(), true);
    click(toggleOf(el)!);
    expect(el.querySelector(".pp-summary")).toBeNull();
    remount();
    const one = render(building(), true, { ...GIT, commit_count: 1 });
    expect(one.querySelector(".pp-summary")!.textContent).toBe("1 commit");
  });

  test("expanding again restores the whole panel", () => {
    const el = render(planned(), true, GIT);
    click(toggleOf(el)!);
    click(toggleOf(el)!);
    expect(toggleOf(el)!.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelectorAll(".pp-item")).toHaveLength(3);
    expect(el.querySelector(".pp-summary")).toBeNull();
  });

  test("the choice is remembered: a fresh panel starts collapsed, and expanding is remembered too", () => {
    const el = render(planned(), true, GIT);
    click(toggleOf(el)!);
    expect(localStorage.getItem(PROGRESS_COLLAPSED_KEY)).toBe("true");
    remount();
    const again = render(planned(), true, GIT);
    expect(toggleOf(again)!.getAttribute("aria-expanded")).toBe("false");
    click(toggleOf(again)!);
    expect(localStorage.getItem(PROGRESS_COLLAPSED_KEY)).toBe("false");
  });

  test("a junk stored value falls back to expanded", () => {
    localStorage.setItem(PROGRESS_COLLAPSED_KEY, "maybe");
    expect(toggleOf(render(planned(), true))!.getAttribute("aria-expanded")).toBe("true");
  });

  test("storage that throws still renders an expanded panel that toggles", () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    try {
      const el = render(planned(), true);
      expect(toggleOf(el)!.getAttribute("aria-expanded")).toBe("true");
      click(toggleOf(el)!);
      expect(toggleOf(el)!.getAttribute("aria-expanded")).toBe("false");
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });

  test("the rail copy has no toggle and stays expanded even when the pinned one is collapsed", () => {
    localStorage.setItem(PROGRESS_COLLAPSED_KEY, "true");
    const el = render(planned(), true, GIT, "rail");
    expect(toggleOf(el)).toBeNull();
    expect(el.querySelector(".progress-panel")!.getAttribute("data-collapsed")).toBe("false");
    expect(el.querySelectorAll(".pp-item")).toHaveLength(3);
    expect(el.querySelector(".pp-step")!.textContent).toBe("build@1");
  });

  test("a collapsed preference does not make a finished step draw anything", () => {
    localStorage.setItem(PROGRESS_COLLAPSED_KEY, "true");
    expect(render(building(), false).querySelector(".progress-panel")).toBeNull();
  });
});
