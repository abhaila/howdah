/**
 * HOW-64 (HOW-56 T5) test fixtures, shared by the pure check (core/graph-spec.test.ts), the
 * outputs dispatch and the fake-claude run (engine/executors/draft-graph.test.ts), so all three
 * judge the same catalog and the same drafts. Not imported by anything that ships.
 */
import type { GraphsCatalog } from "../catalog";
import { FIELD_KINDS, NODE_KINDS, type DraftBody, type GraphSpec, type MaterialiseBodies } from "../graph-spec";
import { spec as quickTaskSpec } from "../../graphs/quick-task";

/** a base whose one step is read-only — what a copy must keep */
export const LOOK_ONLY: GraphSpec = {
  version: 1,
  name: "look-only",
  description: "a read-only review",
  entry: "look-only.review",
  inputs: ["goal"],
  fields: [
    { key: "goal", kind: "text", scope: "sticky" },
    { key: "verdict", kind: "text", scope: "sticky" },
  ],
  nodes: [
    { id: "look-only.review", kind: "agent", prompt: "look-only.review", reads: ["goal"], writes: ["verdict"], readOnly: true },
    { id: "done", kind: "terminal", outcome: "success" },
  ],
  edges: [{ from: "look-only.review", to: "done" }],
};

export const CATALOG: GraphsCatalog = {
  nodeKinds: [...NODE_KINDS],
  fieldKinds: [...FIELD_KINDS],
  commandBuiltins: [],
  graphs: [
    { name: "look-only", spec: LOOK_ONLY, promptIds: ["look-only.review"] },
    { name: "quick-task", spec: quickTaskSpec, promptIds: ["quick-task.work"] },
  ],
  takenNames: ["draft-graph", "look-only", "quick-task"],
  broken: [],
};

/** the pinned text of each catalog prompt — what the CLI's materialiseBodies would read */
export const CATALOG_TEXTS: Record<string, string> = {
  "quick-task.work": "Do the work. Goal: {{ context.goal }}\n\nReturn a summary of what you did.\n",
  "look-only.review": "Review {{ context.goal }} and give a verdict.\n",
};

export const materialiseFake: MaterialiseBodies = (bodies: Readonly<Record<string, DraftBody>>) => {
  const texts: Record<string, string> = {};
  for (const [id, body] of Object.entries(bodies)) {
    if (typeof body === "string") texts[id] = body;
    else if (body.copyOf in CATALOG_TEXTS) texts[id] = CATALOG_TEXTS[body.copyOf]!;
    else return { ok: false, error: `cannot read ${body.copyOf}` };
  }
  return { ok: true, texts };
};

/** "like quick-task but with a review step": one copy, one new read-only body */
export function cleanDraft(): { spec: GraphSpec; prompts: Record<string, DraftBody>; based_on: string | null; notes: string } {
  return {
    spec: {
      version: 1,
      name: "quick-review",
      description: "quick-task, then a read-only review of its summary",
      defaults: { permissionMode: "auto" },
      entry: "quick-review.work",
      inputs: ["goal"],
      fields: [
        { key: "goal", kind: "text", scope: "sticky" },
        { key: "summary", kind: "text", scope: "sticky" },
        { key: "verdict", kind: "text", scope: "sticky" },
      ],
      nodes: [
        { id: "quick-review.work", kind: "agent", prompt: "quick-review.work", reads: ["goal"], writes: ["summary"] },
        { id: "quick-review.review", kind: "agent", prompt: "quick-review.review", reads: ["summary"], writes: ["verdict"], readOnly: true },
        { id: "done", kind: "terminal", outcome: "success" },
      ],
      edges: [
        { from: "quick-review.work", to: "quick-review.review" },
        { from: "quick-review.review", to: "done" },
      ],
    },
    prompts: {
      "quick-review.work": { copyOf: "quick-task.work" },
      "quick-review.review": "Check this summary and give a verdict: {{ context.summary }}\n",
    },
    based_on: "quick-task",
    notes: "Adds a read-only review after quick-task's work step.",
  };
}

export type Draft = ReturnType<typeof cleanDraft>;

/** the clean draft under another name — every step id and prompt id moves with it */
export function renamed(name: string): Draft {
  return JSON.parse(JSON.stringify(cleanDraft()).replaceAll("quick-review", name)) as Draft;
}

/** the clean draft with its review step's instructions filed under `quick-task`'s name */
export function borrowedPrompt(): Draft {
  const d = cleanDraft();
  const review = d.spec.nodes.find((n) => n.id === "quick-review.review");
  if (review?.kind === "agent") review.prompt = "quick-task.review";
  d.prompts = { "quick-review.work": d.prompts["quick-review.work"]!, "quick-task.review": d.prompts["quick-review.review"]! };
  return d;
}

/**
 * Each edge case → the draft that triggers it (or the raw value, for a malformed one) and the
 * sentence the check must say, word for word. Invalid JSON quotes the parser's own error after
 * the colon, which is the runtime's wording, so only the sentence up to it is pinned.
 */
export const EDGE_CASES: Record<string, { draft: () => unknown; says: string }> = {
  "name taken": {
    draft: () => renamed("quick-task"),
    says: "There is already a graph called `quick-task`. Pick another name.",
  },
  "a prompt filed under another graph's name": {
    draft: borrowedPrompt,
    says: `**quick-review.review**'s instructions are filed under "quick-task.review", which belongs to another graph. A graph owns the prompts called \`quick-review.<step>\` and no others — rename the step, or give it its own instructions.`,
  },
  "missing body": {
    draft: () => {
      const d = cleanDraft();
      delete d.prompts["quick-review.review"];
      return d;
    },
    says: `**quick-review.review** names the prompt "quick-review.review", which has no file yet. Write its instructions.`,
  },
  "orphan body": {
    draft: () => {
      const d = cleanDraft();
      d.prompts["quick-review.extra"] = "Nobody runs this.\n";
      return d;
    },
    says: `Instructions are filed under "quick-review.extra", but no step uses them. Remove them, or give a step that prompt.`,
  },
  "unknown copyOf": {
    draft: () => {
      const d = cleanDraft();
      d.prompts["quick-review.work"] = { copyOf: "nope.prompt" };
      return d;
    },
    says: "The instructions for `quick-review.work` are a copy of `nope.prompt`, which is not a prompt Howdah has. Copy one that exists, or write the instructions out.",
  },
  "invalid JSON": {
    draft: () => '{"spec": {not json',
    says: "graph.draft is not valid JSON: ",
  },
};
