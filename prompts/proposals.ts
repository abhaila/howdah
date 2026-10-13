#!/usr/bin/env bun
/**
 * Proposal lifecycle over reviser output files (eng review D7 + OV-3).
 *
 *   bun prompts/proposals.ts accept reviser/proposals/<id>.vN.proposal.md
 *   bun prompts/proposals.ts reject reviser/proposals/<id>.vN.proposal.md "reason"
 *
 * accept() delegates the guards to PromptStore.accept (stale base — the prompt OR anything it
 * includes moved —, a changed include set without `fork: true`, template reads) and, on
 * success, stamps the proposal file `status: accepted`. reject() stamps
 * `status: rejected` + the reason — the reviser reads rejections as feedback for the
 * next reflection round, so the reason is part of the loop, not just bookkeeping.
 *
 * Includes (system-map 1c review): a proposal records `base_includes` — the versions of the
 * prompts its prompt `{{> id }}`-included when it was drafted (JSON in the front-matter). The
 * review view shows the INDIRECT consumers accepting it affects: graph nodes whose prompt
 * includes this one.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptStore, PromptStoreError } from "./store";
import type { Graph } from "../core/graph";
import { frontMatterField, splitFrontMatter } from "../core/template";
import { consumersOf, readFeedback, repoRoot, type Consumer, type FeedbackEntry } from "./library";
import { GRAPHS } from "../graphs/index";

export interface Proposal {
  id: string;
  base_version: number;
  /** the included prompts' versions when drafted; undefined on proposals that predate it */
  base_includes: Record<string, number> | undefined;
  /** the revision deliberately changes its `{{> id }}` lines */
  fork: boolean;
  proposed_version: number;
  status: "pending" | "accepted" | "rejected";
  body: string;
  frontmatter: string;
  path: string;
}

const FM = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function loadProposal(path: string): Proposal {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(FM);
  if (!m || m[1] === undefined || m[2] === undefined) throw new PromptStoreError(`${path}: missing front-matter`);
  const fm = m[1];
  const field = (name: string): string => {
    const fmm = fm.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    if (!fmm || fmm[1] === undefined) throw new PromptStoreError(`${path}: missing ${name}`);
    return fmm[1].trim();
  };
  const opt = (name: string): string | undefined => fm.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  let baseIncludes: Record<string, number> | undefined;
  const rawIncludes = opt("base_includes");
  if (rawIncludes !== undefined) {
    try {
      baseIncludes = JSON.parse(rawIncludes) as Record<string, number>;
    } catch {
      throw new PromptStoreError(`${path}: base_includes is not JSON`);
    }
  }
  return {
    id: field("id"),
    base_version: Number(field("base_version")),
    base_includes: baseIncludes,
    fork: opt("fork") === "true",
    proposed_version: Number(field("proposed_version")),
    status: field("status") as Proposal["status"],
    body: m[2],
    frontmatter: fm,
    path,
  };
}

function stamp(p: Proposal, lines: string): void {
  const fm = p.frontmatter.replace(/^status:.*$/m, lines);
  writeFileSync(p.path, `---\n${fm}\n---\n${p.body}`);
}

export function acceptProposal(path: string, graphs: Graph<any>[], store = new PromptStore()): number {
  const p = loadProposal(path);
  if (p.status !== "pending") throw new PromptStoreError(`${p.id} proposal is already ${p.status}`);
  const v = store.accept(
    { id: p.id, base_version: p.base_version, base_includes: p.base_includes, fork: p.fork, body: p.body, provenance: `proposal ${path}` },
    graphs,
  );
  stamp(p, `status: accepted\naccepted_at: ${new Date().toISOString()}`);
  return v;
}

export function rejectProposal(path: string, reason: string): void {
  const p = loadProposal(path);
  if (p.status !== "pending") throw new PromptStoreError(`${p.id} proposal is already ${p.status}`);
  stamp(p, `status: rejected\nrejected_at: ${new Date().toISOString()}\nrejection_reason: ${reason.replace(/\n/g, " ")}`);
}

// ---- the review surface (T21) -----------------------------------------------------

/**
 * A proposal as the review screen needs it: the revision, the diff that shows what
 * changed, the reviser's own reasoning, the feedback it was drafted from, the eval result
 * if a case has been run — and, load-bearing, whether its base is still current.
 *
 * `stale` is D7 in a boolean: the prompt — or a prompt it includes — moved since this was
 * drafted, so accepting would silently drop whatever moved it. Accept refuses; the screen
 * offers a re-draft instead. `stale_reason` says which.
 */
export interface ProposalView extends Proposal {
  file: string;
  created: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  diff: string | null;
  /** the reviser's stated reasoning for this revision (written alongside the proposal) */
  reflection: string | null;
  /** the prompt's version right now — null if the prompt no longer exists */
  current_version: number | null;
  stale: boolean;
  /** why it is stale (the prompt, or an included prompt, moved), when it is */
  stale_reason: string | null;
  /** graph nodes that run this prompt through an include — accepting changes them too */
  indirect_consumers: Consumer[];
  /** A3.3: per-prompt eval case, authored lazily; absent for most prompts */
  eval: { case: string | null; score: string | null; verdict: string | null; report: string | null };
  /** A2.1 evidence: the feedback this revision answers */
  feedback: FeedbackEntry[];
}

export function proposalsDir(root = repoRoot()): string {
  return join(root, "reviser", "proposals");
}

/** `delivery.publish` → `reviser/eval/delivery-publish.eval.ts`, when one has been authored. */
export function evalCaseFor(id: string, root = repoRoot()): string | null {
  const rel = join("reviser", "eval", `${id.replace(/\./g, "-")}.eval.ts`);
  return existsSync(join(root, rel)) ? rel : null;
}

function sidecar(dir: string, file: string, ext: string): string | null {
  const p = join(dir, file.replace(/\.proposal\.md$/, ext));
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function viewProposal(dir: string, file: string, store = new PromptStore(), root = repoRoot(), graphs: Graph<any>[] = Object.values(GRAPHS)): ProposalView {
  const p = loadProposal(join(dir, file));
  const { frontmatter } = splitFrontMatter(readFileSync(p.path, "utf8"));
  let current: number | null = null;
  let staleReason: string | null = null;
  try {
    current = store.load(p.id).version;
  } catch {
    current = null; // the prompt was renamed or removed out from under the proposal
  }
  // staleness is a question about accepting, so only a PENDING proposal can be stale:
  // an accepted one has necessarily moved the prompt past its own base
  if (current !== null && p.status === "pending") {
    try {
      staleReason = store.staleness(p.id, p.base_version, p.base_includes);
    } catch (err) {
      staleReason = `cannot check what ${p.id} includes: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    ...p,
    file,
    created: frontMatterField(frontmatter, "created"),
    accepted_at: frontMatterField(frontmatter, "accepted_at"),
    rejected_at: frontMatterField(frontmatter, "rejected_at"),
    rejection_reason: frontMatterField(frontmatter, "rejection_reason"),
    diff: sidecar(dir, file, ".diff"),
    reflection: sidecar(dir, file, ".reflection.md"),
    current_version: current,
    stale: staleReason !== null,
    stale_reason: staleReason,
    indirect_consumers: current === null ? [] : consumersOf(graphs, p.id, store).filter((c) => c.via !== undefined),
    eval: {
      case: evalCaseFor(p.id, root),
      score: frontMatterField(frontmatter, "eval_score"),
      verdict: frontMatterField(frontmatter, "eval_verdict"),
      report: frontMatterField(frontmatter, "eval_report"),
    },
    feedback: readFeedback(join(root, "feedback"), p.id),
  };
}

/** Every proposal, pending first, then newest — the queue you actually work through. */
export function listProposals(dir = proposalsDir(), store = new PromptStore(), root = repoRoot(), graphs: Graph<any>[] = Object.values(GRAPHS)): ProposalView[] {
  if (!existsSync(dir)) return [];
  const views: ProposalView[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".proposal.md")) continue;
    try {
      views.push(viewProposal(dir, file, store, root, graphs));
    } catch {
      /* a malformed proposal file must not hide the rest of the queue */
    }
  }
  return views.sort((a, b) => {
    if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return (b.created ?? "").localeCompare(a.created ?? "");
  });
}

/**
 * Stamp an eval result onto a pending proposal (A3.3's accept gate, made visible). HOW-42:
 * `report` is the path of the full A/B report (paired table, cost, trajectory deltas), so the
 * accept/reject screen can point at the evidence and not only the one-line score.
 */
export function stampEval(path: string, score: string, verdict: string, report?: string): void {
  const p = loadProposal(path);
  const fm = p.frontmatter
    .replace(/^eval_score:.*$\n?/m, "")
    .replace(/^eval_verdict:.*$\n?/m, "")
    .replace(/^eval_report:.*$\n?/m, "");
  writeFileSync(
    path,
    `---\n${fm.trimEnd()}\neval_score: ${score}\neval_verdict: ${verdict.replace(/\n/g, " ")}${report ? `\neval_report: ${report}` : ""}\n---\n${p.body}`,
  );
}

if (import.meta.main) {
  const [cmd, path, reason] = process.argv.slice(2);
  if (cmd === "accept" && path) {
    // EVERY registered graph: validateTemplateReads only checks the graphs it is handed, so
    // a hand-maintained subset here would silently skip the OV-3 guard for the rest
    const v = acceptProposal(path, Object.values(GRAPHS));
    console.log(`accepted → v${v}`);
  } else if (cmd === "reject" && path && reason) {
    rejectProposal(path, reason);
    console.log("rejected");
  } else {
    console.error("usage: proposals.ts accept <path> | reject <path> <reason>");
    process.exit(1);
  }
}
