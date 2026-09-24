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
 */
import type { ReactNode } from "react";

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

/** The message of one problem, in the class its severity earns. */
export function ProblemText({ message }: { message: string }) {
  return <>{problemProse(message)}</>;
}
