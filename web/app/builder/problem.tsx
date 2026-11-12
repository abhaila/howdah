/**
 * One problem, rendered (HOW-26).
 *
 * Every message in core/graph-spec.ts is written in the operator's words with two markers in
 * it: `**the step's title**` and `` `a field key` ``. They were printed raw, so the builder's
 * own sentences arrived on screen as
 *
 *     **Probe the PR** goes this way only when `summary == 'All…'`
 *
 * — asterisks, backticks and all. That is a share of "everything looks weird" that no amount
 * of better wording fixes, and it is why the markers are read HERE rather than removed from
 * the messages: the message strings are the contract the tests assert on, and graphs/builder.ts
 * returns one of them over HTTP as a plain-text error where a `**` is the right thing to see.
 *
 * It is two markers and a split, not a markdown parser. Anything else in the text — including
 * an unmatched marker — is passed through as the characters that were typed, because a
 * sentence that renders half-swallowed is worse than one with a stray asterisk in it.
 *
 * HOW-68: `Problem` is the one way a problem is drawn in the panel — a glyph and the words.
 * What BLOCKS is the failure red with the alert glyph; advice is muted with a lightbulb, so it
 * is visibly the quieter of the two and neither depends on colour to be told apart. Amber is
 * not here at all: it means a RUN is waiting on you, and a draft that will not save is not that.
 */
import type { ReactNode } from "react";
import { CircleAlert, Lightbulb } from "lucide-react";
import { isBlocking, type SpecProblem } from "../../../core/graph-spec";

/** `**x**` → bold, `` `x` `` → code, in one pass, left to right. */
export function problemProse(message: string): ReactNode[] {
  const out: ReactNode[] = [];
  // the alternation is ordered: `**…**` is tried before a bare backtick run, so a title
  // containing a backtick cannot be split out from under it
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(message)) !== null) {
    if (m.index > at) out.push(message.slice(at, m.index));
    if (m[1] !== undefined) out.push(<strong key={m.index}>{m[1]}</strong>);
    else out.push(<code key={m.index}>{m[2]}</code>);
    at = m.index + m[0].length;
  }
  if (at < message.length) out.push(message.slice(at));
  return out;
}

/** The same sentence where nothing can be drawn — a toast, an `aria-label` — with the markers taken out. */
export function plainProblem(message: string): string {
  return message.replace(/\*\*([^*]+)\*\*|`([^`]+)`/g, (_m, bold: string | undefined, code: string | undefined) => bold ?? code ?? "");
}

/** The message of one problem, in the class its severity earns. */
export function ProblemText({ message }: { message: string }) {
  return <>{problemProse(message)}</>;
}

/** the glyph a problem's severity earns — shared with the rows that are buttons (properties.tsx) */
export function ProblemGlyph({ problem }: { problem: SpecProblem }) {
  return isBlocking(problem)
    ? <CircleAlert role="img" aria-label="Blocks the save:" className="mt-0.5 size-3.5 shrink-0 text-destructive" />
    : <Lightbulb role="img" aria-label="Worth a second look:" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

/** One problem in the panel: its glyph, then its sentence in the class its severity earns. */
export function Problem({ problem }: { problem: SpecProblem }) {
  return (
    <div className="flex items-start gap-2">
      <ProblemGlyph problem={problem} />
      <div className={`${isBlocking(problem) ? "field-error" : "field-advice"} min-w-0`}>
        <ProblemText message={problem.message} />
      </div>
    </div>
  );
}
