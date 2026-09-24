/**
 * The user-question model (HOW-25) — the ONE place a harness's ask-the-human payload is read,
 * and the ONE place an answer is written back out. Node-free and dependency-free for the same
 * reason `core/harnesses.ts` is: the browser bundle imports it (the question card).
 *
 * Why this file exists. A skill that calls AskUserQuestion used to freeze a run: the executor
 * raised a generic "AskUserQuestion needs permission" park, the card rendered a free-text box
 * that never showed the question or its options, and `executors/reply.ts` collapsed whatever
 * was typed to allow/deny — so "Option B" reached the model as `permission denied: Option B`.
 * Nothing here parses harness JSON twice, and nothing outside here parses it at all.
 *
 * The transport is the permission channel, not a dialog channel — see adapter/claude.ts for
 * the captured evidence. That is a fact about the wire; this file is about the MEANING, so it
 * holds for any harness that can be taught to ask.
 *
 * Every parser returns `null` rather than throwing. A harness that changes its payload shape
 * must degrade to the free-text reply path, never crash a run or a render.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  /** stable within one ask — the key an answer joins on, so two identical question texts
   *  stay distinct (the harness keys its own answers by text and cannot tell them apart) */
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  /** may be empty: a question with no options is answerable only as free text */
  options: AskOption[];
}

/** one question's answer. `selected` holds option LABELS; anything typed lands in `other`. */
export interface AskAnswer {
  id: string;
  selected: string[];
  other?: string;
}

/** a payload with more than this many questions is not a question set, it is a bug */
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 40;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * Read a harness's ask payload into questions, or `null` if it is not one.
 *
 * The shape is claude's AskUserQuestion tool input, captured in
 * adapter/fixtures/claude-ask-user-question.jsonl:
 *   { questions: [ { question, header, multiSelect, options: [ { label, description } ] } ] }
 *
 * `header` and `multiSelect` are defaulted rather than required — they are presentation, and
 * losing the whole question because a harness omitted a label would be the freeze this ticket
 * is about. `question` is required: a question with no text cannot be asked.
 */
export function normalizeAskPayload(payload: unknown): UserQuestion[] | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null;

  const out: UserQuestion[] = [];
  for (const [i, entry] of raw.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const question = str(e.question);
    if (question === null) return null;
    const rawOptions = Array.isArray(e.options) ? e.options : [];
    if (rawOptions.length > MAX_OPTIONS) return null;
    const options: AskOption[] = [];
    for (const o of rawOptions) {
      if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
      const label = str((o as Record<string, unknown>).label);
      if (label === null) return null;
      const description = str((o as Record<string, unknown>).description);
      options.push(description === null ? { label } : { label, description });
    }
    // duplicate labels would make an answer ambiguous on the way back
    if (new Set(options.map((o) => o.label)).size !== options.length) return null;
    out.push({
      id: `q${i}`,
      header: str(e.header) ?? "Question",
      question,
      multiSelect: e.multiSelect === true,
      options,
    });
  }
  return out;
}

/**
 * Validate an answer set arriving from the web card or an API caller. Returns `null` for
 * anything malformed, so the route answers 400 with a named reason instead of a 500 from deep
 * inside a renderer — the standard the rest of web/server.ts already holds to.
 *
 * A label that is not one of the question's own options is REFUSED rather than coerced: the
 * card only ever sends real labels, and free text has its own field. An empty submission is
 * refused too — "I answered nothing" is not an answer, it is a mis-click.
 */
export function validateAnswers(questions: readonly UserQuestion[], value: unknown): AskAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > questions.length) return null;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const out: AskAnswer[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    if (id === null) return null;
    const q = byId.get(id);
    if (!q || seen.has(id)) return null; // unknown or repeated question
    seen.add(id);

    const rawSelected = e.selected === undefined ? [] : e.selected;
    if (!Array.isArray(rawSelected)) return null;
    const labels = new Set(q.options.map((o) => o.label));
    const selected: string[] = [];
    for (const s of rawSelected) {
      if (typeof s !== "string" || !labels.has(s) || selected.includes(s)) return null;
      selected.push(s);
    }
    if (!q.multiSelect && selected.length > 1) return null;

    const other = e.other === undefined ? undefined : typeof e.other === "string" ? e.other : null;
    if (other === null) return null;
    const trimmed = other?.trim() ? other.trim() : undefined;
    if (selected.length === 0 && trimmed === undefined) continue; // an untouched question is skipped
    out.push(trimmed === undefined ? { id, selected } : { id, selected, other: trimmed });
  }
  return out.length > 0 ? out : null;
}

/**
 * Read a free-text reply as an answer — what keeps `howdah reply <run> "Approach B"` and the
 * plain composer first-class. The CLI is never second-class here: the same words reach the
 * model whether they were clicked or typed.
 *
 * Exact label match first, then case-insensitive, against the first question that has options
 * and is not already answered. Anything else is carried whole as `other` on the first
 * unanswered question, because a reply the operator meant is worth more than a parse.
 */
export function parseFreeTextAnswer(questions: readonly UserQuestion[], text: string): AskAnswer[] {
  const trimmed = text.trim();
  if (questions.length === 0) return [];
  if (trimmed === "") return [];

  for (const q of questions) {
    const exact = q.options.find((o) => o.label === trimmed);
    if (exact) return [{ id: q.id, selected: [exact.label] }];
  }
  const lower = trimmed.toLowerCase();
  for (const q of questions) {
    const ci = q.options.find((o) => o.label.toLowerCase() === lower);
    if (ci) return [{ id: q.id, selected: [ci.label] }];
  }
  return [{ id: questions[0]!.id, selected: [], other: trimmed }];
}

/**
 * The canonical prose recorded as `attention-resolved.reply` and shown in the thread. Every
 * existing reader of `reply` (rendersReply, runDigest, deriveLogRows, the CLI) keeps working
 * unchanged — which is why `answers` is additive rather than a replacement.
 */
export function answersToReplyText(questions: readonly UserQuestion[], answers: readonly AskAnswer[]): string {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines: string[] = [];
  for (const a of answers) {
    const q = byId.get(a.id);
    if (!q) continue;
    const parts: string[] = [];
    if (a.selected.length) parts.push(a.selected.join(", "));
    if (a.other) parts.push(a.other);
    if (parts.length === 0) continue;
    lines.push(`${q.header}: ${parts.join(" — ")}`);
  }
  return lines.join("\n");
}

/**
 * The harness-facing answer.
 *
 * The permission channel carries text in exactly one direction — a deny `message` (the
 * response schema is `{behavior:"allow", updatedInput?}` or `{behavior:"deny", message}`, with
 * no result field), so this string IS the tool result the model reads. Answering `allow`
 * instead loses the answer completely: the tool then runs headlessly with no one to ask and
 * returns "The user did not answer the questions." That was verified against claude 2.1.278,
 * both ways, and is why the wording below matters more than it looks.
 *
 * The phrasing is the CLI's OWN sentence for an answered AskUserQuestion, lifted verbatim so
 * the model reads a familiar tool result rather than a denial it has to reinterpret.
 */
export function askResultMessage(questions: readonly UserQuestion[], answers: readonly AskAnswer[]): string {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const parts: string[] = [];
  for (const a of answers) {
    const q = byId.get(a.id);
    if (!q) continue;
    const chosen = a.selected.length ? a.selected.map((s) => `"${s}"`).join(", ") : "(no option selected)";
    parts.push(`"${q.question}"=${chosen}${a.other ? ` notes: ${a.other}` : ""}`);
  }
  if (parts.length === 0) return "The user did not answer the questions.";
  return (
    `The user answered: ${parts.join(", ")}. Read the answers carefully — they may request ` +
    `clarification, changes, or that you not proceed — and follow what they actually say.`
  );
}

/**
 * The questions a park is asking, or null for every other kind of park — the ONE reader of an
 * `attention-raised.ask`, so the executor that writes it, the read model that exposes it and
 * the rule that validates an answer all agree on what a question park looks like.
 */
export function askQuestions(ask: { ask?: unknown } | null | undefined): UserQuestion[] | null {
  const payload = ask?.ask;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const a = payload as Record<string, unknown>;
  if (a.kind !== "user-question") return null;
  return normalizeAskPayload({ questions: a.questions });
}

/** the park reason: what is being asked, so the banner and the notification say it */
export function askReason(questions: readonly UserQuestion[]): string {
  const first = questions[0];
  if (!first) return "the agent is asking you a question";
  return questions.length > 1 ? `${first.question} (+${questions.length - 1} more)` : first.question;
}
