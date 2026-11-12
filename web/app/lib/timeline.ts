/**
 * The timeline, with a POLL folded into one row (HOW-68 feedback: the drawer was "dozens of
 * repeated `delivery.probe_pr@N` / `delivery.wait@N` rows").
 *
 * The rule is generic — it knows nothing of delivery: three or more consecutive visits of ONE
 * step, or four or more of the SAME TWO steps alternating, are the same thing happening again. All
 * of it but the LATEST visit folds into one row that says what repeated, how many times and for
 * how long; the latest stays a row of its own (it is where the run is), and the fold opens to
 * show every visit. A visit that did not succeed ends a run: a failure is never folded away.
 */
export type TimelineItem<T> = { kind: "row"; row: T } | { kind: "fold"; key: string; rows: T[]; nodes: string[]; times: number; duration_ms: number };
export function foldTimeline<T extends { node: string; visit: number; status: string; duration_ms: number | null }>(rows: readonly T[]): TimelineItem<T>[] {
  const out: TimelineItem<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    const first = rows[i]!;
    // how far the pattern of `period` steps starting here repeats, stopping after a visit that did not succeed
    const extent = (period: 1 | 2) => {
      const second = rows[i + 1];
      if (period === 2 && (!second || second.node === first.node)) return 0;
      let j = i;
      while (j < rows.length && rows[j]!.node === rows[i + ((j - i) % period)]!.node) {
        j++;
        if (rows[j - 1]!.status !== "succeeded") break;
      }
      return j - i;
    };
    const one = extent(1), two = extent(2);
    // three of one step; or four of a pair — "probe, wait, probe" is one poll and a half, and a
    // fold that says ×1 hides two rows to tell the operator nothing repeated
    const period = one >= 3 && one >= two ? 1 : 2;
    const length = period === 1 ? one : two;
    if (length < (period === 1 ? 3 : 4)) { out.push({ kind: "row", row: first }); i++; continue; }
    const folded = rows.slice(i, i + length - 1);
    out.push({
      kind: "fold", key: `${first.node}@${first.visit}`, rows: folded,
      nodes: period === 1 ? [first.node] : [first.node, rows[i + 1]!.node],
      times: Math.ceil(folded.length / period),
      duration_ms: folded.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0),
    });
    out.push({ kind: "row", row: rows[i + length - 1]! });
    i += length;
  }
  return out;
}
