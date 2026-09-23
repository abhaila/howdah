/**
 * HOW-25: the ask model. Pure and fast — it pins the meaning before any wiring depends on it.
 * The payload cases are the shapes from adapter/fixtures/claude-ask-user-question.jsonl plus
 * the ways a harness can malform them; every malformed case must return null, never throw,
 * because the fallback is the free-text reply path and not a crashed run.
 */
import { describe, expect, test } from "bun:test";
import {
  answersToReplyText,
  askReason,
  askResultMessage,
  normalizeAskPayload,
  parseFreeTextAnswer,
  validateAnswers,
  type UserQuestion,
} from "./ask";

/** the captured claude payload, verbatim */
const CAPTURED = {
  questions: [
    {
      question: "Which approach should I take?",
      header: "Approach",
      options: [
        { label: "Approach A", description: "Take Approach A." },
        { label: "Approach B", description: "Take Approach B." },
      ],
      multiSelect: false,
    },
  ],
};

const two: UserQuestion[] = [
  { id: "q0", header: "Approach", question: "Which approach?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] },
  { id: "q1", header: "Scope", question: "Which files?", multiSelect: true, options: [{ label: "src" }, { label: "tests" }] },
];

describe("normalizeAskPayload", () => {
  test("reads the captured claude payload", () => {
    const qs = normalizeAskPayload(CAPTURED);
    expect(qs).toEqual([
      {
        id: "q0",
        header: "Approach",
        question: "Which approach should I take?",
        multiSelect: false,
        options: [
          { label: "Approach A", description: "Take Approach A." },
          { label: "Approach B", description: "Take Approach B." },
        ],
      },
    ]);
  });

  test("defaults presentation, requires the question text", () => {
    const qs = normalizeAskPayload({ questions: [{ question: "Why?" }] });
    expect(qs).toEqual([{ id: "q0", header: "Question", question: "Why?", multiSelect: false, options: [] }]);
    expect(normalizeAskPayload({ questions: [{ header: "H", options: [] }] })).toBeNull();
    expect(normalizeAskPayload({ questions: [{ question: "   " }] })).toBeNull();
  });

  test("ids stay distinct when two questions share their text", () => {
    const qs = normalizeAskPayload({ questions: [{ question: "Same?" }, { question: "Same?" }] });
    expect(qs?.map((q) => q.id)).toEqual(["q0", "q1"]);
  });

  test("multiSelect is read strictly — a truthy string is not true", () => {
    expect(normalizeAskPayload({ questions: [{ question: "q", multiSelect: "yes" }] })?.[0]?.multiSelect).toBe(false);
    expect(normalizeAskPayload({ questions: [{ question: "q", multiSelect: true }] })?.[0]?.multiSelect).toBe(true);
  });

  test("anything that is not a question set is null, never a throw", () => {
    for (const bad of [
      null, undefined, 42, "questions", [], {},
      { questions: [] },
      { questions: "nope" },
      { questions: [null] },
      { questions: [{ question: "q", options: [{ description: "no label" }] }] },
      { questions: [{ question: "q", options: [{ label: "dup" }, { label: "dup" }] }] },
      { questions: Array.from({ length: 21 }, () => ({ question: "q" })) },
    ])
      expect(normalizeAskPayload(bad)).toBeNull();
  });
});

describe("validateAnswers", () => {
  test("accepts a real single and multi selection", () => {
    expect(validateAnswers(two, [{ id: "q0", selected: ["A"] }])).toEqual([{ id: "q0", selected: ["A"] }]);
    expect(validateAnswers(two, [{ id: "q1", selected: ["src", "tests"] }])).toEqual([{ id: "q1", selected: ["src", "tests"] }]);
  });

  test("free text rides along and is trimmed", () => {
    expect(validateAnswers(two, [{ id: "q0", selected: [], other: "  neither  " }])).toEqual([{ id: "q0", selected: [], other: "neither" }]);
  });

  test("an untouched question is skipped, not invented", () => {
    expect(validateAnswers(two, [{ id: "q0", selected: ["A"] }, { id: "q1", selected: [], other: "  " }]))
      .toEqual([{ id: "q0", selected: ["A"] }]);
  });

  test("refuses what the card could never have sent", () => {
    for (const bad of [
      "nope", [], null, {},
      [{ id: "q9", selected: ["A"] }],                       // unknown question
      [{ id: "q0", selected: ["Z"] }],                       // label not on this question
      [{ id: "q0", selected: ["A", "B"] }],                  // two on a single-select
      [{ id: "q1", selected: ["src", "src"] }],              // repeated label
      [{ id: "q0", selected: ["A"] }, { id: "q0", selected: ["B"] }], // same question twice
      [{ id: "q0", selected: "A" }],                         // selected must be an array
      [{ id: "q0", selected: [], other: 7 }],                // other must be a string
      [{ selected: ["A"] }],                                 // no id
      [{ id: "q0", selected: [] }],                          // nothing answered at all
    ])
      expect(validateAnswers(two, bad)).toBeNull();
  });
});

describe("parseFreeTextAnswer", () => {
  test("an exact label answers that question", () => {
    expect(parseFreeTextAnswer(two, "B")).toEqual([{ id: "q0", selected: ["B"] }]);
    expect(parseFreeTextAnswer(two, "tests")).toEqual([{ id: "q1", selected: ["tests"] }]);
  });

  test("case and surrounding whitespace do not matter", () => {
    expect(parseFreeTextAnswer(two, "  sRc \n")).toEqual([{ id: "q1", selected: ["src"] }]);
  });

  test("anything unrecognised is carried whole rather than dropped", () => {
    expect(parseFreeTextAnswer(two, "do neither, ask me again")).toEqual([
      { id: "q0", selected: [], other: "do neither, ask me again" },
    ]);
  });

  test("an empty reply answers nothing — the executor keeps waiting", () => {
    expect(parseFreeTextAnswer(two, "   ")).toEqual([]);
    expect(parseFreeTextAnswer([], "anything")).toEqual([]);
  });
});

describe("rendering an answer", () => {
  test("the thread prose reads as the operator's own words", () => {
    expect(answersToReplyText(two, [{ id: "q0", selected: ["A"] }, { id: "q1", selected: ["src", "tests"], other: "and the docs" }]))
      .toBe("Approach: A\nScope: src, tests — and the docs");
  });

  test("the harness message uses the CLI's own answered-question phrasing", () => {
    const msg = askResultMessage(two, [{ id: "q0", selected: ["A"] }]);
    expect(msg).toStartWith('The user answered: "Which approach?"="A".');
    expect(msg).toContain("follow what they actually say");
  });

  test("a question answered only in prose still reaches the model", () => {
    expect(askResultMessage(two, [{ id: "q0", selected: [], other: "neither" }]))
      .toContain('"Which approach?"=(no option selected) notes: neither');
  });

  test("answers for questions that are not in the set are ignored by both renderers", () => {
    expect(answersToReplyText(two, [{ id: "q9", selected: ["A"] }])).toBe("");
    expect(askResultMessage(two, [{ id: "q9", selected: ["A"] }])).toBe("The user did not answer the questions.");
  });
});

describe("askReason", () => {
  test("the park reason is the question itself, not the tool's name", () => {
    expect(askReason(two)).toBe("Which approach? (+1 more)");
    expect(askReason([two[0]!])).toBe("Which approach?");
    expect(askReason([])).toBe("the agent is asking you a question");
  });
});
