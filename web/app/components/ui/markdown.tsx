/**
 * Markdown — agent prose and published documents drawn as documents (HOW-29).
 *
 * Every agent in this system writes markdown: its prose between tool calls, and the long-form
 * values it publishes (`implementation_plan`, `review_findings`, a design doc). The viewer drew
 * all of it as `white-space: pre-wrap` text, so a plan arrived as literal `**`, `##` and `- `,
 * and a plan inside the outputs object arrived as one line of `\n` escapes. HOW-29 asked for a
 * document viewer; a document viewer is first a thing that can READ markdown.
 *
 * Hand-written, not a dependency, on the CLAUDE.md test for the three that were admitted:
 * `react-markdown` is remark + micromark + unified + mdast/hast — some sixty packages — to draw
 * the subset agents actually emit. This is that subset: ATX headings, paragraphs, bullet and
 * numbered lists (nested by indentation), fenced code, block quotes, pipe tables and rules;
 * inline code, bold, italic and links. Anything outside it renders as the text it is, which is
 * exactly what it rendered as before.
 *
 * Model output is UNTRUSTED INPUT (chat.tsx's rule). Nothing here produces markup from a
 * string: every node is a React element whose text React escapes, and a link becomes an
 * anchor only when its target is http(s) or mailto — anything else, `javascript:` included,
 * is drawn as its text.
 *
 * `parseMarkdown` is pure and exported, so the grammar is tested without a DOM.
 */
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "table"; align: Array<"left" | "center" | "right" | null>; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const MARKER = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (l: string) => l.length - l.trimStart().length;
const blank = (l: string | undefined) => l === undefined || l.trim() === "";
const isTableStart = (lines: string[], i: number) =>
  lines[i]!.includes("|") && lines[i + 1] !== undefined && lines[i + 1]!.includes("-") && TABLE_SEP.test(lines[i + 1]!);

/** the lines that end a paragraph without a blank line between */
function interrupts(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || (MARKER.test(l) && indentOf(l) < 4) || isTableStart(lines, i);
}

export function parseMarkdown(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      const closes = (l: string) => { const t = l.trim(); return t.length >= mark.length && [...t].every((c) => c === mark[0]); };
      while (i < lines.length && !closes(lines[i]!)) body.push(lines[i++]!);
      i++; // the closing fence, or past the end of an unclosed one
      out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "heading", level: heading[1]!.length, c: inline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        const q = QUOTE.exec(lines[i]!);
        body.push(q ? q[1]! : lines[i]!);
        i++;
      }
      out.push({ t: "quote", c: blocks(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
      const align = cells(lines[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" as const : c.endsWith(":") ? "right" as const : c.startsWith(":") ? "left" as const : null,
      );
      const head = cells(line).map(inline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i]!.includes("|")) rows.push(cells(lines[i++]!).map(inline));
      out.push({ t: "table", align, head, rows });
      continue;
    }

    const marker = MARKER.exec(line);
    if (marker && indentOf(line) < 4) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) para.push(lines[i++]!.trim());
    out.push({ t: "p", c: inline(para.join("\n")) });
  }
  return out;
}

/**
 * One list, from its first marker. An item owns every following line that is indented past its
 * own marker (nested lists and continued paragraphs), plus lazy continuation lines; a marker at
 * the list's own depth starts the next item. Agents are loose about indentation — a nested
 * bullet under `1.` often sits at two spaces, not three — so "past the marker" is the test,
 * not "at the content column".
 */
function parseList(lines: string[], from: number): [Block, number] {
  const first = MARKER.exec(lines[from]!)!;
  const ordered = /\d/.test(first[2]!);
  const base = first[1]!.length;
  const items: Block[][] = [];
  let i = from;
  while (i < lines.length) {
    const m = MARKER.exec(lines[i]!);
    if (!m || m[1]!.length > base + 1 || m[1]!.length < base || /\d/.test(m[2]!) !== ordered) break;
    const content = m[1]!.length + m[2]!.length + Math.max(1, m[3]!.length);
    const body: string[] = [m[4]!];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (blank(l)) {
        // a blank line stays inside the item only if the item carries on after it
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]!) > base) { body.push(...lines.slice(i, j).map(() => "")); i = j; continue; }
        break;
      }
      if (indentOf(l) > base) { body.push(l.slice(Math.min(indentOf(l), content))); i++; continue; }
      if (!interrupts(lines, i) && !blank(body.at(-1))) { body.push(l.trim()); i++; continue; } // lazy continuation
      break;
    }
    items.push(blocks(body));
    // blank lines between siblings do not end the list
    let j = i;
    while (j < lines.length && blank(lines[j])) j++;
    const sib = j < lines.length ? MARKER.exec(lines[j]!) : null;
    if (j !== i && sib && sib[1]!.length >= base && sib[1]!.length <= base + 1 && /\d/.test(sib[2]!) === ordered) i = j;
  }
  return [{ t: "list", ordered, start: ordered ? parseInt(first[2]!, 10) || 1 : 1, items }, i];
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function inline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && /[!-/:-@[-`{-~]/.test(src[i + 1]!)) { text += src[i + 1]; i += 2; continue; }
    if (ch === "\n") { flush(); out.push({ t: "br" }); i++; continue; }
    if (ch === "`") {
      let n = 0;
      while (src[i + n] === "`") n++;
      const tick = "`".repeat(n);
      const close = src.indexOf(tick, i + n);
      if (close > 0) {
        const v = src.slice(i + n, close);
        flush();
        out.push({ t: "code", v: v.length > 1 && v.startsWith(" ") && v.endsWith(" ") ? v.slice(1, -1) : v });
        i = close + n;
        continue;
      }
      text += tick; i += n; continue;
    }
    if ((ch === "*" || ch === "_") && src[i + 1] === ch && !/\s/.test(src[i + 2] ?? " ")) {
      const close = src.indexOf(ch + ch, i + 2);
      if (close > i + 2 && !/\s/.test(src[close - 1]!)) {
        flush();
        out.push({ t: "strong", c: inline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] !== ch && !/\s/.test(src[i + 1] ?? " ") && (ch === "*" || !/\w/.test(src[i - 1] ?? ""))) {
      let close = -1;
      for (let k = i + 2; k < src.length && close < 0; k++) {
        if (src[k] !== ch) continue;
        if (src[k + 1] === ch) { k++; continue; } // one half of a nested strong, not our close
        if (/\s/.test(src[k - 1]!) || (ch === "_" && /\w/.test(src[k + 1] ?? ""))) continue;
        close = k;
      }
      if (close > 0) {
        flush();
        out.push({ t: "em", c: inline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m) {
        flush();
        const label = inline(m[1]!);
        out.push(SAFE_HREF.test(m[2]!) ? { t: "link", href: m[2]!, c: label } : { t: "text", v: m[0] });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function renderInline(nodes: Inline[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return n.v;
      case "br": return <br key={i} />;
      case "code": return <code key={i}>{n.v}</code>;
      case "strong": return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em": return <em key={i}>{renderInline(n.c)}</em>;
      case "link": return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">{renderInline(n.c)}</a>;
    }
  });
}

function renderBlocks(bs: Block[]): React.ReactNode[] {
  return bs.map((b, i) => {
    switch (b.t) {
      case "heading": {
        const H = `h${Math.min(6, b.level)}` as "h1";
        return <H key={i}>{renderInline(b.c)}</H>;
      }
      case "p": return <p key={i}>{renderInline(b.c)}</p>;
      case "code": return <pre key={i} data-lang={b.lang || undefined}><code>{b.v}</code></pre>;
      case "quote": return <blockquote key={i}>{renderBlocks(b.c)}</blockquote>;
      case "hr": return <hr key={i} />;
      case "list": {
        // a tight item is one paragraph: draw its text without the paragraph box around it
        const item = (c: Block[], j: number) => (
          <li key={j}>{c.length >= 1 && c[0]!.t === "p" ? [renderInline(c[0]!.c), ...renderBlocks(c.slice(1))] : renderBlocks(c)}</li>
        );
        return b.ordered
          ? <ol key={i} start={b.start === 1 ? undefined : b.start}>{b.items.map(item)}</ol>
          : <ul key={i}>{b.items.map(item)}</ul>;
      }
      case "table":
        return (
          <div key={i} className="md-table">
            <table>
              <thead><tr>{b.head.map((c, j) => <th key={j} align={b.align[j] ?? undefined}>{renderInline(c)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, k) => <tr key={k}>{b.head.map((_, j) => <td key={j} align={b.align[j] ?? undefined}>{renderInline(r[j] ?? [])}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** memoised on the text: the transcript re-renders on every SSE tick, and plans are long */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const tree = useMemo(() => renderBlocks(parseMarkdown(text)), [text]);
  return <div className={cn("md", className)}>{tree}</div>;
});
