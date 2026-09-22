/**
 * Step 1 of the builder (HOW-22): what the graph is called, what it is for, and where it
 * starts. The name is the FILE name, so it is checked here — kebab-case, and not a name a
 * built-in already owns — before anything is written; and once the file exists it stops
 * being editable, because renaming it would be making a different graph.
 */
import { PRESETS, type Draft, type DraftAction } from "@/lib/spec-draft";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function BasicsPane({ draft, dispatch, taken, onPreset }: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  /** every name already in the catalog — a collision is answered here, not at save */
  taken: string[];
  onPreset: (presetId: string) => void;
}) {
  const { spec, saved } = draft;
  // an illegal name is reported by specProblems with the rest of this pane's problems; what
  // it cannot know is what ELSE is in the catalog, so that is the one check made here
  const collides = !saved && taken.includes(spec.name);
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>What is it called?</CardTitle>
          <CardDescription>
            The name is the file name under <code>$HOWDAH_HOME/graphs</code>, and it is how you launch a run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label>
            Name
            <Input value={spec.name} disabled={saved} placeholder="my-review" onChange={(e) => dispatch({ type: "set-name", name: e.target.value })} />
          </Label>
          {collides && <div className="field-error">There is already a graph called {spec.name}. Pick another name.</div>}
          {saved && <div className="field-hint">Saved graphs keep their name — the runs that already happened are filed under it.</div>}
          <Label>
            What it does, in one line
            <Textarea rows={2} value={spec.description} placeholder="Draft a document, review it, and revise until the review passes" onChange={(e) => dispatch({ type: "set-description", description: e.target.value })} />
          </Label>
        </CardContent>
      </Card>

      {!saved && (
        <Card>
          <CardHeader>
            <CardTitle>Start from</CardTitle>
            <CardDescription>A starting point, not a cage — every step, field and branch stays editable.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {PRESETS.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <Button variant="outline" size="sm" onClick={() => onPreset(p.id)}>{p.label}</Button>
                  <span className="field-hint">{p.description}</span>
                </div>
              ))}
            </div>
            <div className="field-hint">Picking one replaces the steps and fields you have now.</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Which step runs first?</CardTitle>
          <CardDescription>Everything else is reached from here — a step nothing reaches never runs.</CardDescription>
        </CardHeader>
        <CardContent>
          <Label>
            Starting step
            <Select value={spec.entry} onChange={(e) => dispatch({ type: "set-entry", id: e.target.value })}>
              <option value="">pick a step</option>
              {spec.nodes.filter((n) => n.kind !== "terminal").map((n) => <option key={n.id} value={n.id}>{n.title || n.id}</option>)}
            </Select>
          </Label>
        </CardContent>
      </Card>
    </div>
  );
}
