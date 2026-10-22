/**
 * What a draft-graph launch carries (HOW-66; HOW-56 D-1B, D-5A) — the New run form's one intent
 * box, and a finished draft's "Ask for changes", both reduced to a `LaunchRequest` that
 * core/launch-args.ts turns into argv. Two callers, one builder: the form (browser) and the
 * redraft route (server) must not disagree about what a draft run is told.
 *
 * The draft-graph spec has ONE input, `intent` (graphs/draft-graph.ts: run inputs are all
 * required, so a base is not an input). Everything else travels IN the intent, as text the
 * drafter's prompt already honours ("If the request names a graph to start from, use that
 * one"):
 *
 *   - a chosen base is one fixed sentence at the end, `startFrom()`;
 *   - a redraft is the earlier requests, then "Change requested: …", then `REDRAFT_MARKER`,
 *     then the previous draft as JSON. `based_on` must name a CATALOG graph and a previous
 *     draft is not one, so the drafter is told to start from the draft's content and keep its
 *     `based_on` — the diff then still compares against a real graph.
 *
 * `requestsOf()` cuts at the marker, so a redraft of a redraft carries every request the
 * operator made and only the LATEST draft — the old drafts are superseded, not accumulated.
 *
 * Node-free: the launch form bundles it.
 */
import { DRAFT_GRAPH } from "./catalog";
import type { LaunchRequest } from "./launch-args";

/** where the operator's words end and the previous draft begins, in a redraft's intent */
export const REDRAFT_MARKER = "--- The previous draft (start from this, not from scratch) ---";

/** the sentence a picked base adds to the intent */
export const startFrom = (base: string) => `Start from the graph \`${base}\`.`;

type Overrides = LaunchRequest["overrides"];

/** New run → Draft a graph (D-1B): one intent, an optional base and workspace. */
export function draftLaunchRequest(o: { intent: string; base?: string; workspace?: string; name?: string; overrides?: Overrides }): LaunchRequest {
  const intent = o.intent.trim();
  const base = o.base?.trim();
  return {
    graph: DRAFT_GRAPH,
    inputs: { intent: base ? `${intent}\n\n${startFrom(base)}` : intent },
    ...(o.workspace ? { workspace: o.workspace } : {}),
    ...(o.name ? { name: o.name } : {}),
    ...(o.overrides && Object.keys(o.overrides).length ? { overrides: o.overrides } : {}),
  };
}

/** the operator's requests in an intent — everything above the marker, trimmed */
export function requestsOf(intent: string): string {
  const at = intent.indexOf(REDRAFT_MARKER);
  return (at === -1 ? intent : intent.slice(0, at)).trim();
}

export interface PreviousDraft {
  spec: unknown;
  prompts: unknown;
  based_on: string | null;
}

/** The intent a redraft is launched with (D-5A). Pure, so its size can be judged before a spawn. */
export function redraftIntent(o: { parentIntent: string; change: string; draft: PreviousDraft }): string {
  const keep = o.draft.based_on
    ? `Keep \`based_on\` as \`${o.draft.based_on}\`: start from the previous draft below, not from \`${o.draft.based_on}\` itself.`
    : "Keep `based_on` null: start from the previous draft below.";
  return [
    requestsOf(o.parentIntent),
    `Change requested: ${o.change.trim()}`,
    REDRAFT_MARKER,
    keep,
    JSON.stringify({ spec: o.draft.spec, prompts: o.draft.prompts, based_on: o.draft.based_on }, null, 2),
  ].join("\n\n");
}

/** Ask for changes → a new draft-graph run whose parent is the draft it changes. */
export function redraftLaunchRequest(o: { parent: string; parentIntent: string; change: string; draft: PreviousDraft; workspace?: string }): LaunchRequest {
  return {
    graph: DRAFT_GRAPH,
    inputs: { intent: redraftIntent(o) },
    parent: o.parent,
    ...(o.workspace ? { workspace: o.workspace } : {}),
  };
}
