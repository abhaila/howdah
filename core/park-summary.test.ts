/**
 * HOW-68: the one sentence a parked run is summarised by. Derived from the park's code or its
 * ask kind, never by parsing the reason — so these tests feed it no reason at all.
 */
import { describe, expect, test } from "bun:test";
import { parkSummary } from "./park-summary";

describe("parkSummary", () => {
  test("a known code reads as what happened and names the step", () => {
    const s = parkSummary({ code: "attempt-failed", node: "implementation.plan" });
    expect(s.label).toBe("Step failed");
    expect(s.title).toBe("implementation.plan failed.");
    expect(s.hint).toContain("Reply");
  });

  test("the acceptance park is a question about publishing, not five sentences and a CLI command", () => {
    const s = parkSummary({ code: "acceptance-unmet", node: "delivery.publish" });
    expect(s.title).toBe("Some acceptance criteria are not proven.");
    expect(s.title.length + (s.hint?.length ?? 0)).toBeLessThan(160);
    expect(s.hint).not.toContain("howdah waive");
  });

  test("a question is summarised by the question itself", () => {
    const ask = { kind: "user-question", questions: [{ question: "Cursor or offset pagination?" }] };
    expect(parkSummary({ ask })).toEqual({ label: "Question", title: "Cursor or offset pagination?", hint: null });
    expect(parkSummary({ ask: { kind: "user-question", questions: [] } }).title).toBe("The agent has a question.");
  });

  test("cards with their own controls carry no hint", () => {
    expect(parkSummary({ code: "ambiguous-effect" }).hint).toBeNull();
    expect(parkSummary({ code: "awaiting-approval" }).hint).toBeNull();
  });

  test("an unknown code or a malformed ask degrades to a plain sentence and never throws", () => {
    expect(parkSummary({ code: "from-the-future", node: "x" })).toEqual({ label: "Needs you", title: "x is waiting on you.", hint: null });
    expect(parkSummary({ ask: "nonsense" }).label).toBe("Needs you");
    expect(parkSummary({ ask: { kind: 7 } }).label).toBe("Needs you");
    expect(parkSummary({}).title).toBe("The step is waiting on you.");
    expect(parkSummary({ ask: { kind: "mcp-elicitation" } }).label).toBe("Connect");
    expect(parkSummary({ ask: { kind: "permission" } }).label).toBe("Permission");
    // HOW-68: a permission ask names the tool it is about, and says what the two answers are
    expect(parkSummary({ ask: { kind: "can_use_tool", tool_name: "Bash" } })).toEqual({ label: "Permission", title: "The agent is asking to use Bash.", hint: "Allow it, or say why not." });
    expect(parkSummary({ ask: { kind: "can_use_tool", tool_name: 7 } }).title).toBe("The agent is asking permission to do something.");
  });

  test("every summary is short enough for a list row and ends its sentence", () => {
    for (const code of ["attempt-failed", "harness-unauthenticated", "context-exhausted", "stuck", "turn-timeout", "tools-unsupported", "executor-threw", "max-visits", "no-edge", "max-steps", "ambiguous-effect", "awaiting-approval", "approval-missing", "stale-base", "paused-by-operator", "acceptance-unmet", "no-progress", "repair-stalled"]) {
      const s = parkSummary({ code, node: "delivery.address_reviews" });
      expect(s.label.length, code).toBeLessThanOrEqual(22);
      expect(s.title.endsWith("."), code).toBe(true);
      expect(s.title.length, code).toBeLessThanOrEqual(100);
    }
  });
});
