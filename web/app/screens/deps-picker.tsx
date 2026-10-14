/**
 * HOW-57: the `deps` of a stacked run started from New run, as choices rather than JSON. Each
 * row is one run this one waits for and how far it must get. The form sends only those two
 * facts per row (`[{ run_id, until }]`); the launch route fills in the slice and workspace from
 * the picked run's own log and refuses a bad pick (web/deps-input.ts), so nothing here guesses
 * a workspace from a list in the browser.
 *
 * Offered: runs of the two graphs that deliver a PR (implement-ticket, implement-stacked) that
 * have not failed or been aborted — a run that ended without its PR can never be waited for.
 */
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { RunBoardRow } from "../../board";
import { DEP_UNTIL, type DepUntil } from "../../../core/stack";
import { getJSON } from "../lib/net";
import { runLabel } from "../lib/format";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export interface PickedDep { run_id: string; until: DepUntil }


const DELIVERS = new Set(["implement-ticket", "implement-stacked"]);

/** what the form puts in `inputs.deps`: "" while a row is unfinished, so Launch stays disabled */
export function depsValue(rows: readonly PickedDep[]): string {
  return rows.length > 0 && rows.every((r) => r.run_id) ? JSON.stringify(rows) : "";
}

export function DepsPicker({ onChange }: { onChange: (value: string) => void }) {
  const [runs, setRuns] = useState<RunBoardRow[]>([]);
  const [rows, setRows] = useState<PickedDep[]>([{ run_id: "", until: "merged" }]);
  useEffect(() => { getJSON<RunBoardRow[]>("/api/runs").then(setRuns).catch(() => {}); }, []);
  const candidates = runs.filter((r) => DELIVERS.has(r.graph) && r.outcome !== "failed" && r.outcome !== "aborted");

  const set = (next: PickedDep[]) => { setRows(next); onChange(depsValue(next)); };
  const update = (i: number, patch: Partial<PickedDep>) => set(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="deps-picker">
      {rows.map((r, i) => (
        <div key={i} className="deps-row">
          <Select aria-label={`dependency ${i + 1}: the run to wait for`} value={r.run_id} onChange={(e) => update(i, { run_id: e.target.value })}>
            <option value="">{candidates.length ? "choose a run…" : "no implement-ticket runs to wait for"}</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id} disabled={rows.some((o, j) => j !== i && o.run_id === c.id)}>
                {runLabel(c)} — {c.id}
              </option>
            ))}
          </Select>
          <Select aria-label={`dependency ${i + 1}: wait until`} value={r.until} onChange={(e) => update(i, { until: e.target.value as DepUntil })}>
            {DEP_UNTIL.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
          {rows.length > 1 && (
            <Button variant="ghost" size="sm" aria-label={`remove dependency ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))}><X /></Button>
          )}
        </div>
      ))}
      <Button variant="ghost" size="sm" className="deps-add" onClick={() => set([...rows, { run_id: "", until: "merged" }])}><Plus />add another dependency</Button>
      <div className="field-hint">
        <b>published</b>: branch on top of its open PR (at most one, in this run's repo) · <b>merged</b>: start once it
        has merged · <b>package</b>: merged, and its API package is out
      </div>
    </div>
  );
}
