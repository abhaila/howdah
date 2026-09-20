/**
 * Prompt store (shaping A1) — prompts are files; git is the history; this module is the API.
 *
 * Proposal lifecycle (A3.2, eng review D7 + OV-3):
 *
 *   draft ──▶ pending ──accept()──▶ prompt file bumped to vN+1, proposal marked accepted
 *                    └──reject()──▶ proposal marked rejected with the reason (reviser input)
 *
 *   accept() refuses when:
 *     - base_version != current version (stale base: the prompt moved since drafting)
 *     - the revised template reads a context key some consuming node does not declare
 *       (template-read validation: a revision must never introduce an undeclared read)
 *     - system-map 1c review, includes: an INCLUDED prompt's version moved since drafting
 *       (base_includes — the text the reviser saw is no longer what runs), or the revision
 *       changes the prompt's `{{> id }}` lines without being marked a fork
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Graph } from "../core/graph";
import { expandIncludes, includeRefs, templateReads } from "../core/template";

export interface PromptFile {
  id: string;
  version: number;
  body: string;
  frontmatter: string;
}

export class PromptStoreError extends Error {}

const FM = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export class PromptStore {
  constructor(readonly dir: string = join(dirname(dirname(new URL(import.meta.url).pathname)), "prompts")) {}

  path(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  load(id: string): PromptFile {
    const p = this.path(id);
    if (!existsSync(p)) throw new PromptStoreError(`unknown prompt: ${id}`);
    const raw = readFileSync(p, "utf8");
    const m = raw.match(FM);
    if (!m || m[1] === undefined || m[2] === undefined) throw new PromptStoreError(`${id}: missing front-matter`);
    const vm = m[1].match(/^version:\s*(\d+)\s*$/m);
    if (!vm || vm[1] === undefined) throw new PromptStoreError(`${id}: missing version`);
    return { id, version: Number(vm[1]), body: m[2], frontmatter: m[1] };
  }

  list(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  }

  /** `{{ context.X }}` and `{{ inputs.X }}` refs in a template (ignoring filters and internal.*). */
  static templateReads(body: string): string[] {
    return templateReads(body);
  }

  /**
   * Template-read validation (OV-3): every context/inputs key the revised template reads
   * must be declared (reads or inputs) by EVERY node that uses this prompt, in every graph.
   * PromptId checks names; this checks the reads a revision may have introduced.
   *
   * Through includes (system-map 1c review): reads are taken from the EXPANDED body, exactly as
   * a run pins it (core/template.ts expandIncludes), and a node "uses" this prompt when its own
   * prompt includes it, transitively — revising a partial is checked against every includer.
   * An include the revision breaks (unknown id, cycle) is itself a problem.
   */
  validateTemplateReads(promptId: string, body: string, graphs: Graph<never>[] | Graph<any>[]): string[] {
    const problems: string[] = [];
    const bodyOf = (id: string) => (id === promptId ? body : this.load(id).body);
    for (const g of graphs) {
      for (const [nodeId, node] of Object.entries(g.def.nodes)) {
        if (node.kind !== "agent") continue;
        let expanded: { text: string; included: string[] };
        try {
          expanded = expandIncludes(bodyOf(node.prompt), bodyOf, [node.prompt]);
        } catch (err) {
          // report it when THIS revision broke the includes (they expand with the stored bodies)
          let brokeIt = node.prompt === promptId;
          if (!brokeIt)
            try {
              brokeIt = expandIncludes(this.load(node.prompt).body, (id) => this.load(id).body, [node.prompt]).included.includes(promptId);
            } catch {
              brokeIt = false; // already broken before this revision: not this revision's problem
            }
          if (brokeIt) problems.push(`${g.def.name}/${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (node.prompt !== promptId && !expanded.included.includes(promptId)) continue;
        const declared = new Set<string>([...(node.reads ?? []), ...g.def.inputs]);
        for (const key of PromptStore.templateReads(expanded.text)) {
          if (!declared.has(key))
            problems.push(`${g.def.name}/${nodeId}: template reads "${key}" but the node does not declare it`);
        }
      }
    }
    return problems;
  }

  /**
   * The include closure of a prompt as it stands now: every prompt it `{{> id }}`-includes
   * (transitively), with its current version, in first-use order.
   */
  includeClosure(id: string, body = this.load(id).body): Record<string, number> {
    const { included } = expandIncludes(body, (i) => this.load(i).body, [id]);
    return Object.fromEntries(included.map((i) => [i, this.load(i).version]));
  }

  /**
   * Why a proposal drafted against `base_version` + `base_includes` is stale now, or null. An
   * absent base_includes on a prompt that has includes is stale: the draft never recorded which
   * included text it saw.
   */
  staleness(id: string, baseVersion: number, baseIncludes: Record<string, number> | undefined): string | null {
    const current = this.load(id);
    if (current.version !== baseVersion)
      return `stale base: proposal for ${id} was drafted against v${baseVersion} but the prompt is now v${current.version} — re-draft`;
    const now = this.includeClosure(id, current.body);
    if (baseIncludes === undefined)
      return Object.keys(now).length ? `stale base: proposal for ${id} did not record the versions of the prompts it includes (${Object.keys(now).join(", ")}) — re-draft` : null;
    const moved = [...new Set([...Object.keys(now), ...Object.keys(baseIncludes)])].filter((i) => now[i] !== baseIncludes[i]);
    if (!moved.length) return null;
    return `stale base: included prompt${moved.length > 1 ? "s" : ""} moved since ${id} was drafted (${moved.map((i) => `${i} v${baseIncludes[i] ?? "—"} → v${now[i] ?? "—"}`).join(", ")}) — re-draft`;
  }

  /**
   * Accept a proposal: refuse stale bases (the prompt or anything it includes moved), refuse a
   * changed include set unless the proposal is a fork, refuse undeclared template reads, then
   * bump the prompt file to the proposed version with provenance. Returns the new version.
   */
  accept(
    proposal: { id: string; base_version: number; body: string; provenance?: string; base_includes?: Record<string, number>; fork?: boolean },
    consumingGraphs: Graph<any>[],
  ): number {
    const current = this.load(proposal.id);
    const stale = this.staleness(proposal.id, proposal.base_version, proposal.base_includes);
    if (stale) throw new PromptStoreError(stale);
    const was = [...new Set(includeRefs(current.body))].sort();
    const now = [...new Set(includeRefs(proposal.body))].sort();
    if (!proposal.fork && was.join("\n") !== now.join("\n"))
      throw new PromptStoreError(
        `the revision changes ${proposal.id}'s includes (${was.join(", ") || "none"} → ${now.join(", ") || "none"}) — ` +
          `keep every \`{{> id }}\` line, or mark the proposal \`fork: true\` to take over the included text deliberately`,
      );
    const readProblems = this.validateTemplateReads(proposal.id, proposal.body, consumingGraphs);
    if (readProblems.length)
      throw new PromptStoreError(`revision introduces undeclared reads:\n` + readProblems.join("\n"));

    const newVersion = current.version + 1;
    const fm = current.frontmatter
      .replace(/^version:\s*\d+\s*$/m, `version: ${newVersion}`)
      .replace(/^accepted:.*$\n?/m, "")
      .replace(/^provenance:.*$\n?/m, "");
    const stamp = `accepted: ${new Date().toISOString()}\nprovenance: ${proposal.provenance ?? "reviser proposal"}`;
    writeFileSync(this.path(proposal.id), `---\n${fm.trimEnd()}\n${stamp}\n---\n${proposal.body}`);
    return newVersion;
  }
}
