/**
 * HOW-52: the screenshot-evidence contract — what `evidence:screenshot` publishes, as DATA a
 * graph, the builder, the executor and the viewer share. Node-free, like core/verify.ts, for
 * the same reason: core/graph-spec.ts (bundled into the browser) gates a step on EVIDENCE_PRODUCES.
 *
 * Why it exists: HOW-12's behavioural evidence is the test suite, and for UI work that is the
 * wrong evidence. The run of UI tickets before this one shipped through a reviewer that never
 * looked at a screen, and HOW-46's "died" label was visible in one screenshot and invisible to
 * every test. cwc's evidence is screenshots; this is that, captured by the HARNESS from the
 * worktree's own preview, so the reviewer reads pixels rather than the builder's account.
 *
 * Three outcomes, never two, as with verify:
 *   captured     the preview came up and every path was rendered; `items` lists the PNGs
 *   failed       the preview was configured but did not come up, or a capture broke — the
 *                attempt still SUCCEEDS: a preview that will not start is evidence for the
 *                reviewer (NEEDS_WORK), not a park
 *   not-checked  no preview contract, or no headless browser on this machine — with a reason
 *                saying how to fix it. Never a silent pass.
 *
 * Files live in the RUN DIR (`evidence/<node>@<visit>/`), not the worktree: they are the run's
 * record, the agent must not be able to edit them, and they must not end up committed.
 */

export const EVIDENCE_BUILTIN = "evidence:screenshot";

/** the context key the built-in publishes — and the only one */
export const EVIDENCE_KEY = "evidence.items";
export const EVIDENCE_PRODUCES = [EVIDENCE_KEY] as const;

/** at most this many paths are captured per step: screenshots live in the run dir */
export const EVIDENCE_MAX_PATHS = 8;
/** the viewport every capture is taken at */
export const EVIDENCE_VIEWPORT = { width: 1600, height: 1000 } as const;

export type EvidenceOutcome = "captured" | "failed" | "not-checked";

export interface EvidenceItem {
  /** the requested path, e.g. "/" or "/run/fixture-1" */
  path: string;
  /** the URL it was captured from (a free port on loopback) */
  url: string;
  /** the PNG, RELATIVE to the run dir: `evidence/<node>@<visit>/<name>.png` — what the viewer serves */
  file: string;
  /** the same PNG, absolute — what the reviewer agent opens with its Read tool */
  abs_path: string;
  captured_at: string;
  /** console errors and uncaught exceptions while the page rendered */
  console_errors: number;
  /** the first few of them, verbatim — the full list is in console.txt */
  console_sample: string[];
}

export interface EvidenceResult {
  outcome: EvidenceOutcome;
  items: EvidenceItem[];
  /** console.txt (or preview.log when the preview never came up), relative to the run dir */
  console_file?: string;
  /** the same file, absolute, for the reviewer */
  console_abs_path?: string;
  /** the preview command that ran (absent when nothing did) */
  command?: string;
  /** HEAD of the worktree the preview ran from */
  commit?: string | null;
  dirty?: boolean;
  /** why the outcome is what it is — always set for `failed` and `not-checked` */
  reason?: string;
}

/** a workspace's preview contract (config.json `repos.<name>.preview`) */
export interface PreviewContract {
  /** run in the worktree; `{port}` is replaced by the free port, which is also $PORT and $HOWDAH_PORT */
  command: string;
  /** the paths to capture, in order (capped at EVIDENCE_MAX_PATHS) */
  paths: string[];
  /** polled until it answers below 500 (default "/") */
  readyPath?: string;
  /**
   * a JavaScript expression evaluated in each page, polled until it is truthy before the
   * capture — for an app that draws something first (a splash, a loading state) and the real
   * screen after. Howdah's own viewer needs `!document.querySelector('.splash')`. Polling stops
   * at the load timeout and the capture goes ahead, so a wrong expression costs time, not a run.
   */
  readyWhen?: string;
  /** the fixed pause after DOM-ready (and `readyWhen`) before a capture; default 1500ms */
  renderWaitMs?: number;
}

/** a file name for a captured path: "/" → "index", "/run/x?y" → "run-x-y" */
export function evidenceFileName(path: string, index: number): string {
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${String(index + 1).padStart(2, "0")}-${slug || "index"}`;
}

/** Is `rel` a path inside the run dir's evidence/ folder? The viewer serves nothing else. */
export function isEvidencePath(rel: string): boolean {
  if (!rel.startsWith("evidence/")) return false;
  const parts = rel.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..") && /\.(png|txt|log)$/.test(rel);
}

/** the evidence result a context value holds, or null — context is untrusted to the viewer */
export function asEvidenceResult(v: unknown): EvidenceResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.outcome !== "captured" && o.outcome !== "failed" && o.outcome !== "not-checked") return null;
  if (!Array.isArray(o.items)) return null;
  const items = o.items.filter((i): i is EvidenceItem => !!i && typeof i === "object" && typeof (i as EvidenceItem).file === "string" && isEvidencePath((i as EvidenceItem).file));
  return { ...(o as unknown as EvidenceResult), items };
}
