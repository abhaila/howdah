/**
 * HOW-34: the usage rollup. What is pinned: missing is unknown (never 0), unpriced is partial
 * (never a plain total), a repair turn counts on its own visit, a fallback visit makes the run
 * partial, and a torn final line does not break the fold.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeCost, describeFigure, rollupRun, usageByVisit } from "./usage";
import { readLog } from "./write";
import type { LoggedEvent, RunEvent } from "./events";

const stamp = (events: RunEvent[]): LoggedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, ts: "2026-10-12T00:00:00.000Z" }) as LoggedEvent);
const rendered = (node: string, visit: number, harness: "claude" | "codex"): RunEvent => ({
  type: "prompt-rendered", node, visit, prompt: "doc.draft", prompt_version: 1, rendered_hash: "h", context_read: {}, harness,
});
const claudeTurn = (node: string, visit: number, turn: number, cost: number): RunEvent => ({
  type: "turn-finalized", node, visit, turn,
  usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5, cost_usd: cost, cost_source: "reported" },
});
const codexTurn = (node: string, visit: number): RunEvent => ({
  type: "turn-finalized", node, visit, turn: 1,
  usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 7, cost_usd: null, cost_source: "unpriced" },
});

describe("usageByVisit", () => {
  test("several visits each get their own row, with the harness they ran on", () => {
    const rows = usageByVisit(stamp([
      rendered("draft", 1, "claude"), claudeTurn("draft", 1, 1, 0.01),
      rendered("draft", 2, "claude"), claudeTurn("draft", 2, 1, 0.02),
    ]));
    expect(rows.map((r) => [r.node, r.visit, r.harness, r.cost_usd, r.partial])).toEqual([
      ["draft", 1, "claude", 0.01, false],
      ["draft", 2, "claude", 0.02, false],
    ]);
  });

  test("a repair turn is turn 2 of the SAME visit and is counted on it", () => {
    const [row] = usageByVisit(stamp([rendered("draft", 1, "claude"), claudeTurn("draft", 1, 1, 0.01), claudeTurn("draft", 1, 2, 0.002)]));
    expect(row).toMatchObject({ turns: 2, priced_turns: 2, cost_usd: 0.012, input_tokens: { total: 20, missing: 0 } });
  });

  test("a fallback visit on codex is unpriced: the visit is partial, and so is the run", () => {
    const events = stamp([
      rendered("implement", 1, "claude"), claudeTurn("implement", 1, 1, 0.5),
      rendered("implement", 2, "codex"), codexTurn("implement", 2),
    ]);
    const [, codex] = usageByVisit(events);
    expect(codex).toMatchObject({ harness: "codex", cost_usd: null, unpriced_turns: 1, partial: true });
    const run = rollupRun(events);
    expect(run).toMatchObject({ turns: 2, priced_turns: 1, unpriced_turns: 1, cost_usd: 0.5, partial: true });
    // never a plain number over a run that is only half priced
    expect(describeCost(run)).toBe("$0.5000 (partial: 1 of 2 turns unpriced)");
    // codex reports no cache writes: unknown for that turn, not 0
    expect(describeFigure(run.cache_creation_input_tokens)).toBe("≥ 20 (1 turn unknown)");
  });
});

describe("rollupRun over old and damaged logs", () => {
  test("a pre-HOW-34 usage shape derives without throwing and reads unknown, not 0", () => {
    const old = stamp([{ type: "turn-finalized", node: "draft", visit: 1, turn: 1, usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01 } }]);
    const run = rollupRun(old);
    expect(run.cache_read_input_tokens).toEqual({ total: null, missing: 1 });
    expect(describeFigure(run.cache_read_input_tokens)).toBe("unknown");
    // an old number with no source WAS claude's report
    expect(run).toMatchObject({ cost_usd: 0.01, partial: false });
  });

  test("a turn with no usage at all is unknown and leaves the cost partial", () => {
    const run = rollupRun(stamp([{ type: "turn-finalized", node: "draft", visit: 1, turn: 1 }]));
    expect(run).toMatchObject({ turns: 1, unknown_turns: 1, cost_usd: null, partial: true });
    expect(describeCost(run)).toBe("unpriced (1 turn)");
  });

  test("a torn final line is tolerated: the rollup covers every whole event", () => {
    const dir = mkdtempSync(join(tmpdir(), "howdah-usage-"));
    const path = join(dir, "run.jsonl");
    const events = stamp([rendered("draft", 1, "claude"), claudeTurn("draft", 1, 1, 0.03)]);
    writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + '\n{"type":"turn-final');
    expect(rollupRun(readLog(path))).toMatchObject({ turns: 1, cost_usd: 0.03, partial: false });
  });

  test("no turns: nothing to say", () => {
    expect(describeCost(rollupRun([]))).toBe("—");
  });
});
