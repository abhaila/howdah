/**
 * Context (T24, stories 9 + 10) — the run's whole context in one table. Out of main.tsx.
 *
 * Nothing in the research showed this: trace tools show a span's input and output, and
 * Orbital's tab was per-step and usually empty (CUR5). Keys no step has reached yet stay
 * listed, because their absence is exactly what made the old tab useless.
 *
 * HOW-68: the list and the detail are the shared `SplitView` + `DetailPanel`. A row is a grid
 * (`.ctx-row`, howdah.css) of key · value preview · scope · last writer, every cell a
 * `Truncate` so nothing ends in an ellipsis that cannot be read; the value is previewed on ONE
 * line and shown whole in the detail. Scope is a WORD in a neutral label — it was a pill told
 * apart by hue (gold for `cleared`, the accent for `per-visit`), which said nothing to anyone
 * who had not learned the colours. At 1024px the list used to be squeezed to 8px (§3.1.4);
 * under 1100px the detail now replaces the list.
 */
import { useState } from "react";
import type { RunDetail } from "../../derive";
import { fmtValue } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Row } from "@/components/ui/row";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollPane } from "@/components/ui/scroll-pane";
import { SectionLabel } from "@/components/ui/section-label";
import { Truncate } from "@/components/ui/truncate";
import { CodeBlock } from "@/components/ui/markdown";
import { DetailPanel, SplitView, useListKeys, useSplit } from "@/components/ui/panel";
import { OutputDoc, isDocument } from "./document";

export const SCOPE_MEANS: Record<string, string> = {
  sticky: "the last good value stays visible when a writer re-enters, until a newer one lands",
  cleared: "hidden while its writer re-runs; if that attempt fails, the old answer is restored",
  "per-visit": "invalidated the moment its writer re-enters — freshness is part of its meaning",
};

type Entry = RunDetail["context"][number];
const NOTE = "m-0 text-sm leading-[1.5] text-muted-foreground";

/** the one-line reading of a value, for the list: whitespace folded so a document is a line */
function preview(e: Entry): { text: string; quiet: boolean } {
  if (e.veiled) return { text: "Veiled — its writer is mid-attempt", quiet: true };
  if (!e.written) return { text: "Not written yet", quiet: true };
  return { text: fmtValue(e.value).replace(/\s+/g, " ").slice(0, 400), quiet: false };
}

export function RunContext({ entries }: { entries: RunDetail["context"] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (entries.length === 0)
    return <EmptyState title="No context">This graph declares no context keys, so its steps pass nothing to each other.</EmptyState>;
  const selected = entries.find((e) => e.key === picked) ?? entries.find((e) => e.written) ?? entries[0]!;
  return (
    <SplitView
      storageKey="howdah.context"
      min={320}
      def={440}
      minList={440}
      label="the context detail"
      listLabel="Context"
      list={<ContextList entries={entries} selected={selected.key} onPick={setPicked} />}
      detail={<ContextDetail entry={selected} />}
    />
  );
}

function ContextList({ entries, selected, onPick }: { entries: RunDetail["context"]; selected: string; onPick: (key: string) => void }) {
  const split = useSplit();
  const keys = useListKeys({ ids: entries.map((e) => e.key), selected, onSelect: onPick, name: "key" });
  return (
    <>
      <div className="ctx-row ctx-head border-b border-border text-xs font-semibold text-muted-foreground" aria-hidden>
        <span>Key</span>
        <span>Value</span>
        <span className="ctx-scope">Scope</span>
        <span className="ctx-writer">Written by</span>
      </div>
      <ScrollPane label="Context keys">
        <div ref={keys.ref} onKeyDown={keys.onKeyDown}>
          {entries.map((e) => {
            const last = e.writes.at(-1);
            const value = preview(e);
            // an input no step has written since is the operator's: said in words, not as a step id
            const given = !last && e.input === true;
            const writer = last ? `${last.node}@${last.visit}` : e.declared_writers.join(", ");
            return (
              <Row
                key={e.key}
                className="ctx-row"
                selected={selected === e.key}
                onClick={() => { onPick(e.key); split.open(); }}
                aria-label={`context key ${e.key}${e.written ? "" : ", not written yet"}`}
              >
                <Truncate mono middle={10} className={e.written ? "text-sm text-foreground" : "text-sm text-faint"}>{e.key}</Truncate>
                <Truncate className={value.quiet ? "text-sm text-faint" : "text-sm text-muted-foreground"}>{value.text}</Truncate>
                <span className="ctx-scope text-xs text-muted-foreground">{e.scope ?? ""}</span>
                <span className="ctx-writer flex min-w-0">
                  {given ? <span className="text-xs text-muted-foreground">you, at launch</span>
                    : writer ? <Truncate mono middle={8} className="text-xs text-muted-foreground">{writer}</Truncate> : <span className="text-xs text-faint">—</span>}
                </span>
              </Row>
            );
          })}
        </div>
      </ScrollPane>
    </>
  );
}

/** Story 10: one key — its value, who wrote it in what order, and which prompts read it. */
export function ContextDetail({ entry }: { entry: Entry }) {
  const given = entry.input === true && entry.writes.length === 0;
  const writes = given ? "given at launch" : entry.written ? `${entry.writes.length} write${entry.writes.length === 1 ? "" : "s"}` : "not written";
  return (
    <DetailPanel
      label={`Context key ${entry.key}`}
      head={
        <div className="flex flex-col gap-1.5 pb-3">
          <h2 className="m-0 flex min-w-0 text-md font-semibold"><Truncate mono middle={16}>{entry.key}</Truncate></h2>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {entry.scope && <Badge variant="outline">{entry.scope}</Badge>}
            <span>{writes}</span>
            {entry.declared_writers.length > 1 && <><span aria-hidden>·</span><span>{entry.declared_writers.length} steps may write it</span></>}
          </div>
          {entry.scope && SCOPE_MEANS[entry.scope] && <p className={NOTE}>{SCOPE_MEANS[entry.scope]}</p>}
        </div>
      }
      bodyClassName="flex flex-col gap-2"
    >
      <SectionLabel as="h3">Current value</SectionLabel>
      {entry.veiled ? (
        <p className={NOTE}>Veiled: its writer is mid-attempt, so the old value must not be read as current.</p>
      ) : entry.written ? (
        isDocument(entry.value)
          ? <OutputDoc name={entry.key} text={entry.value} />
          : <CodeBlock wrap>{fmtValue(entry.value)}</CodeBlock>
      ) : (
        <p className={NOTE}>Nothing has written this yet — <span className="font-mono">{entry.declared_writers.join(", ") || "no declared writer"}</span> would.</p>
      )}

      <SectionLabel as="h3" className="mt-2">Write history</SectionLabel>
      {entry.writes.length === 0
        ? <p className={NOTE}>{given ? "You gave this when the run was launched. No step has written it since." : "No writes yet."}</p>
        : (
          <ul className="m-0 flex list-none flex-col p-0">
            {entry.writes.map((w, i) => (
              <li key={i} className="flex min-h-7 items-baseline gap-3 border-b border-border py-1 text-sm last:border-b-0">
                <span className="shrink-0 font-mono text-xs text-faint">{w.at.slice(11, 19)}</span>
                <span className="min-w-0 flex-1 font-mono text-code text-foreground [overflow-wrap:anywhere]">{w.node}@{w.visit}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{w.replaced ? "replaced" : "first write"}</span>
              </li>
            ))}
          </ul>
        )}

      <SectionLabel as="h3" className="mt-2">Read by</SectionLabel>
      {entry.read_by.length === 0
        ? <p className={NOTE}>No prompt has read this yet.</p>
        : <div className="flex flex-wrap gap-1.5">{entry.read_by.map((r) => <Badge key={r} variant="id">{r}</Badge>)}</div>}
    </DetailPanel>
  );
}
