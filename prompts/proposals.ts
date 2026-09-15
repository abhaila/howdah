#!/usr/bin/env bun
/**
 * Proposal lifecycle over reviser output files (eng review D7 + OV-3).
 *
 *   bun prompts/proposals.ts accept reviser/proposals/<id>.vN.proposal.md
 *   bun prompts/proposals.ts reject reviser/proposals/<id>.vN.proposal.md "reason"
 *
 * accept() delegates the guards to PromptStore.accept (stale base, template reads) and,
 * on success, stamps the proposal file `status: accepted`. reject() stamps
 * `status: rejected` + the reason — the reviser reads rejections as feedback for the
 * next reflection round, so the reason is part of the loop, not just bookkeeping.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptStore, PromptStoreError } from "./store";
import type { Graph } from "../core/graph";
import { frontMatterField, splitFrontMatter } from "../core/template";
import { readFeedback, repoRoot, type FeedbackEntry } from "./library";

export interface Proposal {
  id: string;
  base_version: number;
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
  return {
    id: field("id"),
    base_version: Number(field("base_version")),
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
    { id: p.id, base_version: p.base_version, body: p.body, provenance: `proposal ${path}` },
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
 * `stale` is D7 in a boolean: the prompt moved since this was drafted, so accepting would
 * silently drop whatever moved it. Accept refuses; the screen offers a re-draft instead.
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
  /** A3.3: per-prompt eval case, authored lazily; absent for most prompts */
  eval: { case: string | null; score: string | null; verdict: string | null };
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

export function viewProposal(dir: string, file: string, store = new PromptStore(), root = repoRoot()): ProposalView {
  const p = loadProposal(join(dir, file));
  const { frontmatter } = splitFrontMatter(readFileSync(p.path, "utf8"));
  let current: number | null = null;
  try {
    current = store.load(p.id).version;
  } catch {
    current = null; // the prompt was renamed or removed out from under the proposal
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
    // staleness is a question about accepting, so only a PENDING proposal can be stale:
    // an accepted one has necessarily moved the prompt past its own base
    stale: p.status === "pending" && current !== null && current !== p.base_version,
    eval: {
      case: evalCaseFor(p.id, root),
      score: frontMatterField(frontmatter, "eval_score"),
      verdict: frontMatterField(frontmatter, "eval_verdict"),
    },
    feedback: readFeedback(join(root, "feedback"), p.id),
  };
}

/** Every proposal, pending first, then newest — the queue you actually work through. */
export function listProposals(dir = proposalsDir(), store = new PromptStore(), root = repoRoot()): ProposalView[] {
  if (!existsSync(dir)) return [];
  const views: ProposalView[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".proposal.md")) continue;
    try {
      views.push(viewProposal(dir, file, store, root));
    } catch {
      /* a malformed proposal file must not hide the rest of the queue */
    }
  }
  return views.sort((a, b) => {
    if ((a.status === "pending") !== (b.status === "pending")) return a.status === "pending" ? -1 : 1;
    return (b.created ?? "").localeCompare(a.created ?? "");
  });
}

/** Stamp an eval result onto a pending proposal (A3.3's accept gate, made visible). */
export function stampEval(path: string, score: string, verdict: string): void {
  const p = loadProposal(path);
  const fm = p.frontmatter
    .replace(/^eval_score:.*$\n?/m, "")
    .replace(/^eval_verdict:.*$\n?/m, "");
  writeFileSync(
    path,
    `---\n${fm.trimEnd()}\neval_score: ${score}\neval_verdict: ${verdict.replace(/\n/g, " ")}\n---\n${p.body}`,
  );
}

if (import.meta.main) {
  const [cmd, path, reason] = process.argv.slice(2);
  if (cmd === "accept" && path) {
    // EVERY registered graph: validateTemplateReads only checks the graphs it is handed, so
    // a hand-maintained subset here would silently skip the OV-3 guard for the rest
    const { GRAPHS } = await import("../graphs/index");
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
