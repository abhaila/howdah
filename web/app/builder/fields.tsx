/**
 * Step 2 of the builder (HOW-22): the field registry — every value the graph passes between
 * its steps, and how fresh each one has to be.
 *
 * Freshness lives HERE rather than on each producing step, and that is the whole reason this
 * pane exists as its own thing. Two steps declaring different scopes for one key is a
 * GraphError (core/graph.ts declarations()); asking once, per field, in plain language makes
 * that error unreachable instead of merely reported.
 */
import { Plus, Trash2 } from "lucide-react";
import { FIELD_KINDS, SCOPE_CHOICES, type Draft, type DraftAction } from "@/lib/spec-draft";
import type { FieldKind } from "../../../core/graph-spec";
import type { Scope } from "../../../core/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function FieldsPane({ draft, dispatch }: { draft: Draft; dispatch: (a: DraftAction) => void }) {
  const { spec } = draft;
  /** who writes this key — so removing a field can say what it would take with it */
  const writersOf = (key: string) =>
    spec.nodes.filter((n) => ("writes" in n && n.writes.includes(key))).map((n) => n.title || n.id);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <CardTitle>What it works with</CardTitle>
          <CardDescription>
            Every value the steps pass between them. Tick "ask me" for the ones you type in when a run starts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {spec.fields.length === 0 ? (
            <EmptyState>no fields yet</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Freshness</TableHead>
                  <TableHead>Ask me at launch</TableHead>
                  <TableHead>Written by</TableHead>
                  <TableHead>{""}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spec.fields.map((f) => {
                  const writers = writersOf(f.key);
                  return (
                    <TableRow key={f.key}>
                      <TableCell>
                        <Input
                          className="font-mono" value={f.key} aria-label={`the name of the ${f.key} field`}
                          onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { key: e.target.value } })}
                        />
                        {f.kind === "choice" && (
                          <Input
                            value={(f.choices ?? []).join(", ")} placeholder="pass, reject" aria-label={`the choices for ${f.key}`}
                            onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { choices: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        <Select value={f.kind} aria-label={`the kind of ${f.key}`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { kind: e.target.value as FieldKind } })}>
                          {FIELD_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select value={f.scope} aria-label={`how fresh ${f.key} has to be`} onChange={(e) => dispatch({ type: "update-field", key: f.key, patch: { scope: e.target.value as Scope } })}>
                          {SCOPE_CHOICES.map((s) => <option key={s.scope} value={s.scope}>{s.label}</option>)}
                        </Select>
                        <div className="field-hint">{SCOPE_CHOICES.find((s) => s.scope === f.scope)?.help}</div>
                      </TableCell>
                      <TableCell>
                        <Checkbox
                          label="ask me" checked={spec.inputs.includes(f.key)}
                          aria-label={`ask me for ${f.key} when a run starts`}
                          onChange={() => dispatch({ type: "toggle-input", key: f.key })}
                        />
                      </TableCell>
                      <TableCell>{writers.length ? writers.join(", ") : spec.inputs.includes(f.key) ? "you, at launch" : "— nothing yet"}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" aria-label={`remove the ${f.key} field`} onClick={() => dispatch({ type: "remove-field", key: f.key })}>
                          <Trash2 size={13} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <div className="actions">
            <Button variant="outline" size="sm" onClick={() => dispatch({ type: "add-field" })}><Plus />Add a field</Button>
          </div>
          <div className="field-hint">
            Removing a field also removes it from the steps that used it and from any branch that tested it.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
