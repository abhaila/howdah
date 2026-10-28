/**
 * Saving a graph the builder made (HOW-22) — the server half of core/graph-spec.ts.
 *
 * The artifact does not change: a builder graph is a `.ts` file in `$HOWDAH_HOME/graphs`,
 * loaded, validated and prompt-checked by `graphs/local.ts` exactly like a hand-written one.
 * What changes is the BODY — a JSON literal and one `buildGraph()` call instead of prose
 * TypeScript — which is what makes re-opening it in the builder an exact round trip rather
 * than a parse.
 *
 * Four rules this file exists to keep:
 *
 *   WHAT IS ON DISK IS ALWAYS RUNNABLE. `saveLocalSource` already restores the graph file
 *   when the gate refuses. A builder save also writes PROMPT files, and a refused save that
 *   left new prompt bodies behind would break the same promise one level down — so the
 *   prompts are snapshotted and restored too, and the whole save is one transaction.
 *
 *   WHAT AN AGENT IS GIVEN IS WHAT ITS PROMPT ASKS FOR. A node's `reads` is never taken from
 *   the client: it is recomputed here with `derivedReads()` over the body being written — the
 *   body's template refs plus what the engine consumes for the step (HOW-74: `acceptance` on a
 *   `requiresAcceptance` step) — so the declaration, the text and validate() cannot disagree.
 *   (The builder computes the same thing live with the same function.)
 *
 *   A GRAPH WRITES ONLY ITS OWN PROMPTS. Every local prompt lives in one directory, so the
 *   `<graph>.<step>` prefix is all that keeps two graphs' instructions apart. The loop below
 *   asks four questions of every prompt id it is handed — is it a usable id, does a step of
 *   THIS spec name it, does the repo already ship one, and is it this graph's to write — and it
 *   must be able to answer the last one alone, without reasoning through the spec, because a
 *   create naming another graph's id rewrote that graph's prompt and returned ok.
 *
 *   A CREATE NEVER DESTROYS. The save declares whether it is a create or an update, and a
 *   create that lands on a name a graph already owns is refused before any write. Sibling
 *   `POST /api/graphs` has kept that guarantee since day one (`cli/new-graph.ts` throws on an
 *   existing path); this route became the PRIMARY authoring path without it, so a new draft
 *   that happened to reuse a name silently replaced that graph and its prompts.
 *
 *   A COPY IS WRITTEN OUT, NOT LINKED (HOW-63). A drafted step may name its instructions as
 *   `{ copyOf: <prompt id> }`. Save turns that into an ordinary `<graph>.<step>` file holding
 *   the text a run would PIN for the original — includes expanded by the same `pinnableText`
 *   `Engine.pinPrompts()` runs (prompts/pin.ts) — because a local prompt may not include
 *   (specProblems refuses `{{>`), and because what the operator reviewed must be what a run
 *   pins, not whatever the original says after its next accepted revision. The copy is
 *   resolved BEFORE the verdict, so `reads` are derived from the copied text and every body
 *   check sees it; a copy of a prompt Howdah does not have is refused before any write. The
 *   copied-FROM id is only ever read: the id that is written is still the key, and still has
 *   to pass every rule below.
 *
 *   ONE VERDICT, NOT TWO. The refusal below runs the same `specProblems()` the browser runs
 *   on every keystroke, over the spec that is about to be WRITTEN. Before that, the browser
 *   could call a draft clean while this file refused it — and the message the operator got
 *   back was `validate()`'s own, naming a node id and a "writer-free path". Every blocking
 *   defect in the HOW-22 review was one instance of that gap. HOW-26 splits that verdict by
 *   SEVERITY, and the refusal here reads the BLOCKING half only: advice describes a graph
 *   that runs and is not what was meant, which is the operator's call and not a gate.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derivedReads, isBlocking, nameTakenProblem, promptIdFor, specProblems, SPEC_PROMPT_ID, unknownCopyProblem, type DraftBody, type GraphSpec, type NodeSpec, type SpecProblem } from "../core/graph-spec";
import { frontMatterField, IncludeError, splitFrontMatter } from "../core/template";
import { pinnableText, promptReader } from "../prompts/pin";
import { ensureLocalDirs, findPromptFile, LOCAL_NAME, loadLocalGraph, localGraphPath, localPromptsDir, promptSearchPath } from "./local";
import type { Graph } from "../core/graph";

// promptIdFor lives in core/graph-spec.ts (the builder needs it in the browser too) and is
// re-exported here, where every other caller already looks for it.
export { promptIdFor };

/** The prompt file a builder graph's step owns, or null when it has none yet. */
export function readLocalPrompt(home: string, id: string): string | null {
  if (!SPEC_PROMPT_ID.test(id)) return null;
  const p = join(localPromptsDir(home), `${id}.md`);
  // trailing whitespace is stripped on write, so it is stripped on read too: otherwise
  // every builder round trip would add a blank line to the textarea
  return existsSync(p) ? splitFrontMatter(readFileSync(p, "utf8")).body.replace(/\s*$/, "") : null;
}

/** `---\nid: …\nversion: N\n---\nbody`. An existing file's version is KEPT: a local prompt is
 *  not in the revision lifecycle, so a bump would be a number that means nothing. */
function promptFile(id: string, body: string, previous: string | null): string {
  const version = (previous && frontMatterField(splitFrontMatter(previous).frontmatter, "version")) ?? "1";
  return `---\nid: ${id}\nversion: ${version}\n---\n${body.replace(/\s*$/, "")}\n`;
}

/**
 * The module text. The spec is embedded with `JSON.stringify`, never by string-building the
 * values: the spec came off the network, and JSON is the one serialisation that cannot turn
 * an operator's description into code.
 *
 * The import is ABSOLUTE for the same reason `cli/new-graph.ts` scaffolds one — a local graph
 * is imported from a fresh temp directory (graphs/local.ts), so a relative import would not
 * resolve. Moving the Howdah checkout therefore breaks builder graphs exactly as it already
 * breaks scaffolded ones; re-saving from the builder rewrites the path.
 */
export function renderSpecModule(spec: GraphSpec, repoRoot: string): string {
  const specModule = join(repoRoot, "core", "graph-spec");
  return `/**
 * ${spec.name} — built with the Howdah graph builder (HOW-22).
 *
 * The spec below IS the graph: \`buildGraph\` compiles it into the same \`Graph\` a
 * hand-written \`defineGraph\` produces, and hangs the spec back on \`def.spec\` so the
 * builder can re-open exactly this. Edit it at /graphs/${spec.name}/build.
 *
 * Hand-editing is allowed — it is a normal local graph and \`validate()\` still gates it —
 * but anything the builder cannot read back turns the builder off for this graph and leaves
 * you the source editor. It never guesses a spec out of TypeScript.
 */
import { buildGraph, type GraphSpec } from ${JSON.stringify(specModule)};

export const spec: GraphSpec = ${JSON.stringify(spec, null, 2)};

export const graph = buildGraph(spec);
`;
}

/** Every prompt id the spec's agent steps name, in step order. */
export function promptIdsOf(spec: GraphSpec): string[] {
  return spec.nodes.filter((n): n is Extract<NodeSpec, { kind: "agent" }> => n.kind === "agent").map((n) => n.prompt);
}

export type SaveResult =
  | { ok: true; created: boolean; graph: Graph<any> }
  /** `code` lets the route pick a status without re-deciding the refusal: "exists" is a create
   *  that landed on a graph, "missing" an update of one that is not there. */
  | { ok: false; error: string; code?: "exists" | "missing" };

interface Snapshot {
  path: string;
  previous: string | null;
}

function restore(files: Snapshot[]): void {
  for (const f of files) {
    if (f.previous === null) { if (existsSync(f.path)) unlinkSync(f.path); }
    else writeFileSync(f.path, f.previous);
  }
}

/**
 * Every body as the text that will be written: a string as given, a `{ copyOf }` as the BODY a
 * run would pin for that prompt (prompts/pin.ts), found on the run's own search path — local
 * first, then the repo's. Reads only; a refusal names the first body that cannot be resolved.
 */
export function materialiseBodies(
  home: string,
  repoRoot: string,
  prompts: Readonly<Record<string, DraftBody>>,
): { ok: true; texts: Record<string, string> } | { ok: false; error: string } {
  const dirs = promptSearchPath(home, repoRoot);
  const rawOf = promptReader(dirs);
  const texts: Record<string, string> = {};
  for (const [id, body] of Object.entries(prompts)) {
    if (typeof body === "string") {
      texts[id] = body;
      continue;
    }
    // the id becomes a path: one that is not prompt-shaped is not a prompt Howdah has
    if (!SPEC_PROMPT_ID.test(body.copyOf) || findPromptFile(body.copyOf, dirs) === null)
      return { ok: false, error: unknownCopyProblem(id, body.copyOf).message };
    try {
      texts[id] = splitFrontMatter(pinnableText(body.copyOf, rawOf).pinned).body;
    } catch (err) {
      if (!(err instanceof IncludeError)) throw err;
      return { ok: false, error: `The instructions for \`${id}\` are a copy of \`${body.copyOf}\`, which cannot be read in full: ${err.message}` };
    }
  }
  return { ok: true, texts };
}

/**
 * The spec a save would write, and every BLOCKING problem with it — split out of
 * saveBuilderGraph so a test can hold it against the browser's draftProblems() (HOW-60).
 *
 * Reads are DERIVED, never trusted: from the body being written, or the one already on disk.
 * The bodies the verdict sees are the same: for each prompt a step names, the payload's body or
 * else the file on disk — so a hand-edited prompt with an include blocks an update here exactly
 * as it does in the browser, which loaded the same text.
 *
 * specProblems() is node-free precisely so both sides can run it; running it here too is what
 * makes "Ready to save" and a 422 unable to disagree, and it answers a refusal in the
 * operator's words instead of `validate()`'s. The server stays strictly STRONGER — the path
 * checks in saveBuilderGraph need the filesystem, and loadLocalGraph still runs the real gate —
 * but it never refuses something the browser called clean for a reason the browser could have
 * known. It runs on the DERIVED spec, because that is what is about to be written.
 *
 * BLOCKING only (HOW-26). specProblems() also returns ADVICE — a graph that will load, validate
 * and run and still not do what was meant. Advice is the operator's call, not this file's:
 * refusing on one would make the builder's own nagging into a gate nobody asked for.
 */
export function saveVerdict(opts: { home: string; spec: GraphSpec; prompts: Record<string, string> }): { spec: GraphSpec; problems: SpecProblem[] } {
  const bodyOf = (id: string): string | null =>
    opts.prompts[id] !== undefined ? opts.prompts[id]! : readLocalPrompt(opts.home, id);
  const spec: GraphSpec = {
    ...opts.spec,
    nodes: opts.spec.nodes.map((n) => {
      if (n.kind !== "agent") return n;
      const body = bodyOf(n.prompt);
      return body === null ? n : { ...n, reads: derivedReads(n, body) };
    }),
  };
  const bodies: Record<string, string> = {};
  for (const id of promptIdsOf(spec)) {
    const body = bodyOf(id);
    if (body !== null) bodies[id] = body;
  }
  return { spec, problems: specProblems(spec, { bodies }).filter(isBlocking) };
}

/**
 * Write a builder graph and its prompts, or change nothing.
 *
 * `prompts` maps prompt id → body — text, or a `{ copyOf }` that is written out as the copied
 * prompt's pinned text (see materialiseBodies) — and only ids the spec's own agent steps name are accepted:
 * the id becomes a file path, so an id from the network that no step asked for has no reason
 * to exist. An id the REPO already ships is refused too — `promptSearchPath` puts local
 * first (graphs/local.ts), so writing one would silently shadow a shipped prompt for every
 * graph, not just this one.
 */
export async function saveBuilderGraph(opts: {
  home: string;
  repoRoot: string;
  spec: GraphSpec;
  prompts: Record<string, DraftBody>;
  /**
   * REQUIRED: a create that lands on an existing graph is REFUSED, never merged over it
   * (HOW-22 review, finding 2 — a brand-new draft reusing a name replaced that graph's module
   * and every one of its prompt files). Optional-defaulting-to-update would be a flag a caller
   * forgets, and forgetting reproduces exactly that bug, so `tsc` is made to name every site.
   */
  intent: "create" | "update";
}): Promise<SaveResult> {
  const { home, repoRoot, prompts } = opts;
  if (!LOCAL_NAME.test(opts.spec.name)) return { ok: false, error: `graph name must be kebab-case: "${opts.spec.name}"` };

  const declaredIds = new Set(promptIdsOf(opts.spec));
  for (const id of Object.keys(prompts)) {
    if (!SPEC_PROMPT_ID.test(id)) return { ok: false, error: `"${id}" is not a usable prompt name` };
    if (!declaredIds.has(id)) return { ok: false, error: `no step names the prompt "${id}"` };
    if (!id.startsWith(`${opts.spec.name}.`))
      return { ok: false, error: `"${id}" is another graph's prompt — a graph may only write the ones called "${opts.spec.name}.<step>".` };
    if (existsSync(join(repoRoot, "prompts", `${id}.md`)))
      return { ok: false, error: `"${id}" is one of Howdah's own prompts — a local one would shadow it everywhere. Rename the step.` };
  }

  // BEFORE ensureLocalDirs, so a refusal touches nothing at all. The list holds one name
  // because the only name whose existence matters to this save is its own.
  const existing = existsSync(localGraphPath(home, opts.spec.name));
  if (opts.intent === "create") {
    const taken = nameTakenProblem(opts.spec.name, existing ? [opts.spec.name] : []);
    if (taken) return { ok: false, error: taken.message, code: "exists" };
  } else if (!existing) {
    return { ok: false, error: `there is no graph called "${opts.spec.name}" to update`, code: "missing" };
  }

  // copies are resolved BEFORE the verdict, so it judges (and derives reads from) the text that
  // will actually be written — and BEFORE ensureLocalDirs, so an unknown copy writes nothing
  const materialised = materialiseBodies(home, repoRoot, prompts);
  if (!materialised.ok) return { ok: false, error: materialised.error };
  const { texts } = materialised;

  // THE SAME VERDICT THE BROWSER SHOWED, and BEFORE ensureLocalDirs, so a refusal (an include
  // in a body, say) writes nothing at all. See saveVerdict.
  const { spec, problems: blocking } = saveVerdict({ home, spec: opts.spec, prompts: texts });
  if (blocking.length) return { ok: false, error: blocking[0]!.message };

  ensureLocalDirs(home);
  const graphPath = localGraphPath(home, opts.spec.name);
  const files: Snapshot[] = [];
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

  try {

    // the writes live INSIDE the try so restore() covers an IO failure (EACCES, ENOSPC) and
    // not only a refusal: each snapshot is taken BEFORE its write, so a throw half way
    // through the loop puts back exactly the files that had already moved
    for (const [id, body] of Object.entries(texts)) {
      const path = join(localPromptsDir(home), `${id}.md`);
      const previous = read(path);
      files.push({ path, previous });
      writeFileSync(path, promptFile(id, body, previous));
    }
    files.push({ path: graphPath, previous: read(graphPath) });
    writeFileSync(graphPath, renderSpecModule(spec, repoRoot));

    const graph = await loadLocalGraph(home, spec.name, repoRoot);
    // the gate ran on what was imported; prove the spec survived the round trip too, so a
    // graph can never be listed as builder-editable while the builder cannot read it back
    if (graph.def.spec === undefined) throw new Error("the saved module does not carry its spec");
    return { ok: true, created: opts.intent === "create", graph };
  } catch (err) {
    restore(files);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
