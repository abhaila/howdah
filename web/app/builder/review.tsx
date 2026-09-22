/**
 * Step 5 of the builder (HOW-22): the verdict, and Save.
 *
 * Nothing is discovered here. Every problem has already been printed on the pane that fixes
 * it and counted in the rail — this pane exists so that "is it ready?" has ONE answer in one
 * place, and so the operator can see what saving will actually write to disk before it does.
 * A builder that only tells you at the end is the thing this ticket was filed against.
 *
 * Save is allowed even with problems outstanding, and that is deliberate: the server runs
 * the real gate (`loadLocalGraph` → `validate()` → every prompt file exists) and restores
 * the previous bytes of the graph AND its prompts when it refuses, so a bad save cannot
 * break what is on disk. Blocking the button here would only mean trusting the browser's
 * copy of the check more than the server's.
 */
import { CheckCircle2, Save } from "lucide-react";
import type { SpecProblem } from "../../../core/graph-spec";
import { promptIdFor } from "../../../core/graph-spec";
import type { Draft } from "@/lib/spec-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ReviewPane({ draft, problems, saving, error, onSave }: {
  draft: Draft;
  /** ALL of them, from every pane — this is the one place that does not filter */
  problems: SpecProblem[];
  saving: boolean;
  error: string | null;
  onSave: () => void;
}) {
  const { spec } = draft;
  const agents = spec.nodes.filter((n) => n.kind === "agent");
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>{problems.length === 0 ? "Ready to save" : `${problems.length} thing${problems.length === 1 ? "" : "s"} to sort out`}</CardTitle>
          <CardDescription>
            {problems.length === 0
              ? "Every step is reachable, every field a step reads is written before it gets there, and every branch goes somewhere."
              : "Each one is also printed on the pane that fixes it. Saving is still allowed — the server checks again and keeps the last good version if it refuses."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {problems.length === 0 ? (
            <div className="builder-verdict"><CheckCircle2 size={15} /> Nothing outstanding.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {problems.map((p, i) => (
                <div key={i} className="field-error builder-problem">
                  <Badge variant="outline">{p.where}</Badge> {p.message}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What saving writes</CardTitle>
          <CardDescription>Under <code>$HOWDAH_HOME</code> — never in the Howdah repo, so updating Howdah leaves it alone.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1">
            <div className="font-mono text-sm">graphs/{spec.name || "…"}.ts</div>
            {agents.map((n) => (
              <div key={n.id} className="font-mono text-sm">prompts/{n.kind === "agent" ? n.prompt : promptIdFor(spec.name, n.id)}.md</div>
            ))}
          </div>
          <div className="actions">
            <Button onClick={onSave} disabled={saving}><Save />{saving ? "Saving…" : draft.saved ? "Save changes" : "Save and add to the catalog"}</Button>
          </div>
          {error && <div className="field-error wrap-pre">{error}</div>}
          <div className="field-hint">
            Removing a step leaves its instructions file behind. That is harmless — a graph only
            fails on a prompt that is MISSING, never on a spare one — and it means an undo costs
            you nothing.
          </div>
          <div className="field-hint">
            Need a condition this vocabulary cannot say? Save, then edit the file under
            "Advanced — source" on the Graphs screen. Hand-editing it means the builder can no
            longer re-open it, and it says so rather than guessing.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
