/**
 * Multi-process fixture for the locked-append tests (system-map 0.5). Run as a separate OS
 * process so the test exercises real cross-process contention on one run.jsonl, not two
 * EventLog instances sharing a JS thread.
 *
 *   bun log/fixtures/appender.ts <path> append <count> <startAtMs>
 *   bun log/fixtures/appender.ts <path> decide <count> <startAtMs>
 *
 * Both processes spin until <startAtMs> so their first writes collide. `decide` appends a
 * chunk then tries "append the decision only if none exists"; the build callback sleeps to
 * widen the check-then-append window, so without the lock two decisions would land.
 */
import { EventLog } from "../write";

const [path, mode, countArg, startArg] = process.argv.slice(2);
if (path === undefined || (mode !== "append" && mode !== "decide")) {
  throw new Error("usage: appender.ts <path> append|decide <count> <startAtMs>");
}
const count = Number(countArg ?? "200");
const startAt = Number(startArg ?? "0");
while (Date.now() < startAt) { /* start barrier */ }

const log = new EventLog(path);
for (let i = 0; i < count; i++) {
  if (mode === "append") {
    log.append({ type: "chunk", node: `p${process.pid}`, visit: 1, turn: 1, index: i, kind: "text", content: "x" });
    continue;
  }
  log.appendIf((events) => {
    if (events.some((e) => e.type === "operator-jump")) return null;
    Bun.sleepSync(2);
    return { type: "operator-jump", to: "decided", message: String(process.pid) };
  });
  log.append({ type: "chunk", node: `p${process.pid}`, visit: 1, turn: 1, index: i, kind: "text", content: "x" });
}
