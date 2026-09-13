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
import { readFileSync, writeFileSync } from "node:fs";
import { PromptStore, PromptStoreError } from "./store";
import type { Graph } from "../core/graph";

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

if (import.meta.main) {
  const [cmd, path, reason] = process.argv.slice(2);
  if (cmd === "accept" && path) {
    // all graphs that could consume the prompt — keep this list in step with graphs/
    const { implementTicket } = await import("../graphs/implement-ticket");
    const { improveCodebase } = await import("../graphs/improve-codebase");
    const { reviewTeammatePr } = await import("../graphs/review-teammate-pr");
    const v = acceptProposal(path, [implementTicket, improveCodebase, reviewTeammatePr]);
    console.log(`accepted → v${v}`);
  } else if (cmd === "reject" && path && reason) {
    rejectProposal(path, reason);
    console.log("rejected");
  } else {
    console.error("usage: proposals.ts accept <path> | reject <path> <reason>");
    process.exit(1);
  }
}
