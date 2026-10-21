/**
 * HOW-66: what a draft-graph run is launched with — from New run (D-1B) and from a draft's Ask
 * for changes (D-5A) — through the one argv builder both launch paths use.
 */
import { describe, expect, test } from "bun:test";
import { launchArgs } from "./launch-args";
import { draftLaunchRequest, redraftIntent, redraftLaunchRequest, REDRAFT_MARKER, requestsOf, startFrom } from "./draft-launch";

const draft = { spec: { name: "quick-review", nodes: [] }, prompts: { "quick-review.work": { copyOf: "quick-task.work" } }, based_on: "quick-task" };

describe("draftLaunchRequest (New run → Draft a graph)", () => {
  test("the bare intent, no workspace: just the graph and its one input", () => {
    expect(launchArgs(draftLaunchRequest({ intent: "  like quick-task with a review  " }), "R")).toEqual(
      ["run", "draft-graph", "--id", "R", "-i", "intent=like quick-task with a review"],
    );
  });

  test("a base adds the start-from sentence; a workspace, name and overrides are forwarded", () => {
    const args = launchArgs(draftLaunchRequest({ intent: "add a review", base: "quick-task", workspace: "howdah", name: "My draft", overrides: { harness: "codex" } }), "R");
    expect(args).toEqual([
      "run", "draft-graph", "--id", "R", "-i", `intent=add a review\n\n${startFrom("quick-task")}`,
      "--workspace", "howdah", "--name", "My draft", "--harness", "codex",
    ]);
    expect(startFrom("quick-task")).toBe("Start from the graph `quick-task`.");
  });

  test("empty overrides and an empty base are not sent", () => {
    expect(draftLaunchRequest({ intent: "x", base: "", overrides: {} })).toEqual({ graph: "draft-graph", inputs: { intent: "x" } });
  });
});

describe("redraftLaunchRequest (Ask for changes)", () => {
  test("carries the parent, the original request, the change, the marker and the draft — keeping its based_on", () => {
    const req = redraftLaunchRequest({ parent: "draft-graph-p1", parentIntent: "like quick-task with a review", change: " make the review read-only ", draft, workspace: "howdah" });
    const args = launchArgs(req, "C");
    expect(args.slice(0, 4)).toEqual(["run", "draft-graph", "--id", "C"]);
    expect(args).toContain("--parent");
    expect(args[args.indexOf("--parent") + 1]).toBe("draft-graph-p1");
    expect(args[args.indexOf("--workspace") + 1]).toBe("howdah");
    const intent = req.inputs!.intent!;
    expect(intent).toStartWith("like quick-task with a review\n\nChange requested: make the review read-only\n\n" + REDRAFT_MARKER);
    expect(intent).toContain("Keep `based_on` as `quick-task`");
    const json = JSON.parse(intent.slice(intent.indexOf("{")));
    expect(json).toEqual(draft);
  });

  test("a draft from nothing keeps based_on null; no workspace means no flag", () => {
    const req = redraftLaunchRequest({ parent: "p", parentIntent: "x", change: "y", draft: { ...draft, based_on: null } });
    expect(req.inputs!.intent).toContain("Keep `based_on` null");
    expect(launchArgs(req, "C")).not.toContain("--workspace");
  });

  test("a redraft of a redraft keeps every request and only the latest draft", () => {
    const first = redraftIntent({ parentIntent: "original ask", change: "first change", draft });
    const second = redraftIntent({ parentIntent: first, change: "second change", draft: { ...draft, spec: { name: "v2" } } });
    expect(requestsOf(second)).toBe("original ask\n\nChange requested: first change\n\nChange requested: second change");
    expect(second.split(REDRAFT_MARKER)).toHaveLength(2);
    expect(second).toContain('"name": "v2"');
    expect(second).not.toContain('"name": "quick-review"');
  });

  test("requestsOf: an intent with no marker is the whole (trimmed) intent", () => {
    expect(requestsOf("  just this \n")).toBe("just this");
  });
});
