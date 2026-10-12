/**
 * HOW-49 — the live progress panel: shown only while the newest step's turn is live, drawing
 * the agent's own plan, what landed in the worktree, and how long the agent has been quiet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import type { LiveGit } from "../live-git";
import { ProgressPanel } from "./run/progress";

let root: Root | null = null;
let host: HTMLElement | null = null;
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

function render(log: FakeLog, runnerAlive: boolean, liveGit: LiveGit | null = null): HTMLElement {
  const detail = deriveDetail("r", log.events, {}, { runnerAlive });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ProgressPanel detail={detail} liveGit={liveGit} />));
  return host;
}

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
