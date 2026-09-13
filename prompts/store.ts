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
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Graph } from "../core/graph";

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
    const reads = new Set<string>();
    for (const m of body.matchAll(/\{\{\s*(context|inputs)\.([\w.]+)(?:\s*\|[^}]*)?\s*\}\}/g)) {
      const key = m[2]!;
      if (m[1] === "context" && key.startsWith("internal.")) continue; // engine-provided namespace
      reads.add(key);
    }
    return [...reads].sort();
  }

  /**
   * Template-read validation (OV-3): every context/inputs key the revised template reads
   * must be declared (reads or inputs) by EVERY node that uses this prompt, in every graph.
   * PromptId checks names; this checks the reads a revision may have introduced.
   */
  validateTemplateReads(promptId: string, body: string, graphs: Graph<never>[] | Graph<any>[]): string[] {
    const problems: string[] = [];
    const reads = PromptStore.templateReads(body);
    for (const g of graphs) {
      for (const [nodeId, node] of Object.entries(g.def.nodes)) {
        if (node.kind !== "agent" || node.prompt !== promptId) continue;
        const declared = new Set<string>([...(node.reads ?? []), ...g.def.inputs]);
        for (const key of reads) {
          if (!declared.has(key))
            problems.push(`${g.def.name}/${nodeId}: template reads "${key}" but the node does not declare it`);
        }
      }
    }
    return problems;
  }

  /**
   * Accept a proposal: refuse stale bases, refuse undeclared template reads, then bump the
   * prompt file to the proposed version with provenance. Returns the new version.
   */
  accept(
    proposal: { id: string; base_version: number; body: string; provenance?: string },
    consumingGraphs: Graph<any>[],
  ): number {
    const current = this.load(proposal.id);
    if (current.version !== proposal.base_version)
      throw new PromptStoreError(
        `stale base: proposal for ${proposal.id} was drafted against v${proposal.base_version} but the prompt is now v${current.version} — re-draft`,
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
