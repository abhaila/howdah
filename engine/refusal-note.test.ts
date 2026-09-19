/**
 * Refusal notes (system-map 1c review): a refused proposal's reason reaches the proposer's next
 * attempt and stays pending until a proposal is ACCEPTED (a successful finish). Replay is
 * pinned on hand-built logs; reconstruction verifies a render that carried a refusal AND an
 * operator reply.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayState } from "./replay";
import type { LoggedEvent, RunEvent } from "../log/events";
import { EventLog } from "../log/write";
import { SUFFIX_VERSION, assemblePrompt, renderedHash } from "../core/template";
import { reconstructRender } from "../prompts/library";

const stamp = (events: RunEvent[]): LoggedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: new Date(0).toISOString() }) as LoggedEvent);
const started: RunEvent = { type: "run-started", graph: "g", inputs: {}, pinned_prompts: {} };
const attempt = (visit: number): RunEvent => ({ type: "node-started", node: "propose", visit, attempt_id: `propose#${visit}` });
const refused = (visit: number, reason: string): RunEvent => ({ type: "node-finished", node: "propose", visit, status: "failed", writes: {}, refused: reason });
const failed = (visit: number): RunEvent => ({ type: "node-finished", node: "propose", visit, status: "failed", writes: {} });
const succeeded = (visit: number): RunEvent => ({ type: "node-finished", node: "propose", visit, status: "succeeded", writes: { ghosts: {} } });

describe("replay: the refusal note's lifecycle", () => {
  test("a refused attempt leaves the note for the node's next attempt", () => {
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids")])).refusalNote).toEqual({ node: "propose", message: "bad ids" });
  });

  test("an attempt that died mid-flight gets the note back for its re-attempt", () => {
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids"), attempt(2)])).refusalNote).toEqual({ node: "propose", message: "bad ids" });
  });

  test("a retry that failed for another reason (threw) keeps the note pending", () => {
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids"), attempt(2), failed(2)])).refusalNote).toEqual({ node: "propose", message: "bad ids" });
  });

  test("an accepted proposal (successful finish) consumes it; a newer refusal replaces it", () => {
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids"), attempt(2), succeeded(2)])).refusalNote).toBeNull();
    expect(replayState(stamp([started, attempt(1), refused(1, "old"), attempt(2), refused(2, "new")])).refusalNote).toEqual({ node: "propose", message: "new" });
  });

  test("an operator jump drops it (a redesign restarts the design conversation)", () => {
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids"), { type: "operator-jump", to: "extract", reset_budgets: true }])).refusalNote).toBeNull();
    expect(replayState(stamp([started, attempt(1), refused(1, "bad ids"), attempt(2), { type: "operator-jump", to: "extract" }])).refusalNote).toBeNull();
  });
});

describe("reconstructRender: a retry carrying a refusal and an operator reply verifies", () => {
  test("body → reply → refusal, rebuilt from node-finished.refused and the resolved park", () => {
    const runDir = mkdtempSync(join(tmpdir(), "howdah-refusal-"));
    mkdirSync(join(runDir, "prompts"));
    writeFileSync(join(runDir, "prompts", "discover.md"), "---\nid: discover\nversion: 1\n---\nPropose for {{ context.goal }}.\n");
    const text = assemblePrompt({ body: "Propose for ship.\n", replyMessage: "use real keys", refusalMessage: "entities[0]: unknown id", skills: [], outputKeys: ["ghosts"], suffixVersion: SUFFIX_VERSION });
    const log = new EventLog(join(runDir, "run.jsonl"));
    for (const e of [
      started,
      attempt(1),
      refused(1, "entities[0]: unknown id"),
      { type: "attention-raised", node: "propose", visit: 1, reason: "proposal refused", code: "attempt-failed" },
      { type: "attention-resolved", node: "propose", visit: 1, reply: "use real keys", source: "operator" },
      attempt(2),
      {
        type: "prompt-rendered", node: "propose", visit: 2, prompt: "discover", prompt_version: 1, rendered_hash: renderedHash(text),
        context_read: { goal: "ship" }, skills: [], output_keys: ["ghosts"], suffix_version: SUFFIX_VERSION,
      },
    ] satisfies RunEvent[])
      log.append(e);
    expect(reconstructRender(runDir, renderedHash(text))).toMatchObject({ verified: true, text });
  });
});
