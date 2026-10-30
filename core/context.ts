/**
 * Howdah context store — the single store a run reads and writes (shaping A0.3).
 *
 * Three rules, all from the eng review:
 *   D3    — strict typing: a node declares what it writes; undeclared writes are rejected;
 *           reads of never-written keys throw. Key names are compile-checked via keyof C.
 *   OV-4  — visit scoping is explicit per output. "A value may exist because visit 1 wrote
 *           it" is never ambiguous again.
 *   A5.1  — every read and write is recorded with provenance {node, visit, at}, feeding
 *           PromptRendered.context_read and PromptOutcome.
 *
 * Publish-on-success: writes during an attempt land in a buffer; only endAttempt("succeeded")
 * publishes them. A failed attempt publishes nothing (OV-1's transactional instinct, applied
 * to context).
 *
 * Scope semantics (per output declaration):
 *
 *              visit N succeeds        writer re-enters (visit N+1)      N+1 fails      N+1 succeeds
 *   sticky     value published    ──▶  old value STILL VISIBLE      ──▶  still visible  replaced
 *   cleared    value published    ──▶  old value HIDDEN (veiled)    ──▶  old RESTORED   replaced
 *   per-visit  value published    ──▶  old value INVALIDATED        ──▶  absent         replaced
 *                                        (permanently)
 *
 *   sticky:    trust the last good value until a newer one lands.
 *   cleared:   a new attempt means "the old answer is being redone" — hide it while the
 *              attempt runs, but a failed attempt restores it (the old answer still stands).
 *   per-visit: the act of re-entering the writer invalidates the old value forever —
 *              freshness is part of the value's meaning (e.g. a probe result).
 *
 * Concurrent attempts (HOW-73): the branches of a parallel step run at once, so attempts are
 * kept PER STEP. Opening a second attempt on the SAME step is still refused. `set` and
 * `endAttempt` keep their one-attempt meaning and throw unless exactly one attempt is open, so
 * every sequential caller behaves as before; a branch uses `setFor` / `endAttemptOf`. Branch
 * writes are disjoint (Graph.validate), so their buffers never collide.
 */

export type Scope = "sticky" | "cleared" | "per-visit";

export interface OutputDecl<T = unknown> {
  scope: Scope;
  /** documentation only for now; the type lives in C */
  description?: string;
  /** phantom field so C[K] flows through declarations; never set at runtime */
  __type?: T;
}

/** Per-key provenance recorded on every publish. */
export interface Provenance {
  node: string;
  visit: number;
  at: string; // ISO timestamp
}

export interface ReadRecord {
  key: string;
  by: string; // reading node
  visit: number; // reader's visit
  found: boolean;
  provenance?: Provenance;
}

interface Cell {
  value: unknown;
  scope: Scope;
  provenance: Provenance;
  /** cleared-scope only: veiled while the writer is mid-attempt */
  veiled: boolean;
  /** per-visit only: set when the writer re-enters; a dead cell never comes back */
  invalidated: boolean;
}

export class ContextError extends Error {}

export class ContextStore<C extends object> {
  private cells = new Map<keyof C & string, Cell>();
  private declarations: Map<keyof C & string, { scope: Scope; writers: string[] }>;
  /** open attempts by step, each with its own write buffer (HOW-73) */
  private attempts = new Map<string, { visit: number; buffer: Map<keyof C & string, unknown> }>();
  private readLog: ReadRecord[] = [];

  /**
   * `declared` maps each context key to its scope and its writing node(s).
   * Multiple writers are legal and common (plan and plan_review both write
   * implementation_plan); scope effects fire when ANY declared writer re-enters,
   * because the key is being redone regardless of who redoes it.
   */
  constructor(declared: { [K in keyof C & string]: { scope: Scope; writer: string | string[] } }) {
    this.declarations = new Map(
      (Object.entries(declared) as [keyof C & string, { scope: Scope; writer: string | string[] }][]).map(
        ([k, d]) => [k, { scope: d.scope, writers: Array.isArray(d.writer) ? d.writer : [d.writer] }],
      ),
    );
  }

  /**
   * A node begins an attempt (visit). Scope effects happen HERE, not at write time:
   * re-entering a writer veils its `cleared` outputs and permanently invalidates its
   * `per-visit` outputs.
   */
  beginAttempt(node: string, visit: number): void {
    const open = this.attempts.get(node);
    if (open) throw new ContextError(`attempt already open: ${node}@${open.visit}`);
    this.attempts.set(node, { visit, buffer: new Map() });
    for (const [key, decl] of this.declarations) {
      if (!decl.writers.includes(node)) continue;
      const cell = this.cells.get(key);
      if (!cell) continue;
      if (cell.scope === "cleared") cell.veiled = true;
      if (cell.scope === "per-visit") cell.invalidated = true;
    }
  }

  /** the one open attempt — what `set` / `endAttempt` act on; refused when none or several are open */
  private sole(what: string): string {
    if (this.attempts.size === 0) throw new ContextError(`${what} outside an attempt`);
    if (this.attempts.size > 1)
      throw new ContextError(`${what} is ambiguous: ${this.attempts.size} attempts are open (${[...this.attempts.keys()].join(", ")}) — name the step`);
    return [...this.attempts.keys()][0]!;
  }

  /** Write during the open attempt. Only declared keys, only by their declared writer. */
  set<K extends keyof C & string>(key: K, value: C[K]): void {
    this.setFor(this.sole(`set(${key})`), key, value);
  }

  /** HOW-73: write during `node`'s open attempt — the form a concurrent branch uses */
  setFor<K extends keyof C & string>(node: string, key: K, value: C[K]): void {
    const attempt = this.attempts.get(node);
    if (!attempt) throw new ContextError(`set(${key}) outside an attempt of ${node}`);
    const decl = this.declarations.get(key);
    if (!decl) throw new ContextError(`undeclared context key written: ${key} (by ${node})`);
    if (!decl.writers.includes(node))
      throw new ContextError(
        `${node} is not a declared writer of ${key} (writers: ${decl.writers.join(", ")})`,
      );
    attempt.buffer.set(key, value);
  }

  /**
   * Close the attempt. "succeeded" publishes the buffer (and lifts veils it replaces);
   * "failed" publishes nothing and un-veils `cleared` cells (the old answer stands).
   */
  endAttempt(outcome: "succeeded" | "failed"): void {
    if (this.attempts.size === 0) throw new ContextError("endAttempt without beginAttempt");
    this.endAttemptOf(this.sole("endAttempt"), outcome);
  }

  /** HOW-73: close `node`'s open attempt — the form a concurrent branch uses */
  endAttemptOf(node: string, outcome: "succeeded" | "failed"): void {
    const attempt = this.attempts.get(node);
    if (!attempt) throw new ContextError(`endAttempt without beginAttempt (${node})`);
    const { visit, buffer } = attempt;
    if (outcome === "succeeded") {
      const at = new Date().toISOString();
      for (const [key, value] of buffer) {
        const decl = this.declarations.get(key)!;
        this.cells.set(key, {
          value,
          scope: decl.scope,
          provenance: { node, visit, at },
          veiled: false,
          invalidated: false,
        });
      }
    } else {
      // failed: restore visibility of cleared cells this writer had veiled
      for (const [key, decl] of this.declarations) {
        if (!decl.writers.includes(node)) continue;
        const cell = this.cells.get(key);
        if (cell && cell.scope === "cleared") cell.veiled = false;
        // per-visit cells stay invalidated: a new visit permanently outdates them
      }
    }
    this.attempts.delete(node);
  }

  /** Is the key currently readable? (scope-aware) */
  has<K extends keyof C & string>(key: K): boolean {
    const cell = this.cells.get(key);
    return !!cell && !cell.veiled && !cell.invalidated;
  }

  /**
   * Read a value for a node. Throws on unreadable keys — the validator proves this cannot
   * happen on any legal path, so a throw here means an engine bug, not a graph bug.
   * Every read is recorded for PromptRendered.context_read.
   */
  get<K extends keyof C & string>(key: K, reader: { node: string; visit: number }): C[K] {
    const cell = this.cells.get(key);
    const readable = !!cell && !cell.veiled && !cell.invalidated;
    this.readLog.push({
      key,
      by: reader.node,
      visit: reader.visit,
      found: readable,
      provenance: cell?.provenance,
    });
    if (!readable) {
      const why = !cell ? "never written" : cell.veiled ? "veiled (writer mid-attempt)" : "invalidated (writer re-entered)";
      throw new ContextError(`context read failed: ${key} is ${why} (read by ${reader.node}@${reader.visit})`);
    }
    return cell.value as C[K];
  }

  /** Reads recorded since the given index — the engine snapshots this per turn. */
  drainReads(since = 0): ReadRecord[] {
    return this.readLog.slice(since);
  }

  get readCount(): number {
    return this.readLog.length;
  }

  /** Provenance of a readable value, for conditions that need freshness (`pr.state@visit`). */
  provenanceOf<K extends keyof C & string>(key: K): Provenance | undefined {
    const cell = this.cells.get(key);
    return cell && !cell.veiled && !cell.invalidated ? cell.provenance : undefined;
  }
}
