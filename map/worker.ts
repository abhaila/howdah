/**
 * Parse worker — system-map 1b, eng review D13/12A. Driven by `pool.ts`.
 *
 * Holds one `FileParser` (WASM runtime + grammars loaded once) and parses one file per message.
 * A thrown error becomes a per-file `worker error` outcome; a hard crash, a hang, or a failed
 * start is handled by the pool (the file is marked `not-checked (worker error)`).
 *
 * `faults` is a fault-injection hook for the pool's tests: content containing `crashMarker`
 * kills the worker with an uncaught error, content containing `hangMarker` never answers, and
 * `failInit` makes the worker die before it is ready.
 */

import { FileParser, type ParseOutcome } from "./facts";
import type { GrammarOverrides } from "./languages";
import type { Language } from "./types";

declare const self: Worker;

export interface WorkerFaults {
  crashMarker?: string;
  hangMarker?: string;
  failInit?: boolean;
}

export type WorkerIn =
  | { type: "init"; grammarOverrides?: GrammarOverrides; faults?: WorkerFaults }
  | { type: "parse"; id: number; language: Language; content: string };

export type WorkerOut = { type: "ready" } | { type: "result"; id: number; outcome: ParseOutcome };

let parser: Promise<FileParser> | undefined;
let faults: WorkerFaults = {};

function die(why: string): void {
  setTimeout(() => {
    throw new Error(why);
  }, 0);
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    faults = msg.faults ?? {};
    if (faults.failInit === true) return die("injected startup failure");
    parser = FileParser.create(msg.grammarOverrides);
    await parser;
    self.postMessage({ type: "ready" } satisfies WorkerOut);
    return;
  }
  if (faults.crashMarker !== undefined && msg.content.includes(faults.crashMarker)) return die("injected worker crash");
  if (faults.hangMarker !== undefined && msg.content.includes(faults.hangMarker)) return;
  let outcome: ParseOutcome;
  try {
    if (parser === undefined) throw new Error("worker not initialised");
    outcome = await (await parser).parse(msg.content, msg.language);
  } catch (e) {
    outcome = { ok: false, reason: `worker error: ${e instanceof Error ? e.message : String(e)}` };
  }
  self.postMessage({ type: "result", id: msg.id, outcome } satisfies WorkerOut);
};
