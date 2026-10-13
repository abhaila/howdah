/**
 * HOW-55 — the rail says what the newest agent ran WITH, and an older run says "not recorded".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { AgentEnvironment } from "./run/view";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = host = null; });

function render(log: FakeLog): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AgentEnvironment env={deriveDetail("r", log.events).agent_env} />));
  return host;
}
const rows = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll(".kv")].map((r) => [r.querySelector(".k")!.textContent, r.lastElementChild!.textContent]));

describe("agent environment in the rail", () => {
  test("project-only, with what loaded", () => {
    const log = new FakeLog();
    log.add({ type: "agent-environment", node: "do", visit: 1, harness: "claude", setting_sources: "project,local", inherits_user: false, hooks: [],
      skills: ["a", "b"], plugins: [{ name: "p", source: "p@builtin" }], mcp_servers: [], files: [{ path: "/w/CLAUDE.md", scope: "project", sha256: "ab" }, { path: "/w/CLAUDE.local.md", scope: "project", sha256: null }] });
    expect(rows(render(log))).toEqual({
      "agent environment": "claude · project settings only",
      loaded: "2 skills · 1 plugins · 0 MCP",
      "settings files": "1 hashed",
    });
  });

  test("inherited user settings show the hooks that ran and how many injected context", () => {
    const log = new FakeLog();
    log.add({ type: "agent-environment", node: "do", visit: 1, harness: "claude", setting_sources: "user,project,local", inherits_user: true,
      hooks: [{ name: "SessionStart:startup", exit_code: 0, injected: { sha256: "x".repeat(64), chars: 900, text: "MUST invoke skills" } }, { name: "SessionStart:startup", exit_code: 0 }],
      files: [] });
    const r = rows(render(log));
    expect(r["agent environment"]).toBe("claude · your user settings + project");
    expect(r["hooks ran"]).toBe("2 · 1 injected context");
  });

  test("a run recorded before HOW-55 says not recorded — never a guess", () => {
    expect(rows(render(new FakeLog()))).toEqual({ "agent environment": "not recorded" });
  });
});
