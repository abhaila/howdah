/**
 * Chat citations — split out of web/derive.ts (system-map 1d) because the React app imports it
 * as a VALUE: everything this module imports lands in the browser bundle, and derive.ts reads
 * engine/ and map/ modules that belong on the server. Keep this file dependency-free.
 *
 * The rule (T24, story 12): an answer is UNTRUSTED model output: a node@visit becomes
 * a clickable citation only when this run actually has that step, and every part is rendered
 * as text, never as markup.
 */
export interface CitePart {
  text: string;
  cite: boolean;
}

export function citeParts(answer: string, known: Set<string>): CitePart[] {
  const out: CitePart[] = [];
  const re = /([a-z_][\w.]*@\d+)/gi;
  let last = 0;
  for (const m of answer.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: answer.slice(last, at), cite: false });
    out.push({ text: m[1]!, cite: known.has(m[1]!) });
    last = at + m[1]!.length;
  }
  if (last < answer.length) out.push({ text: answer.slice(last), cite: false });
  return out;
}

