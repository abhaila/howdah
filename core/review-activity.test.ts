/**
 * HOW-70 — the rule for NEW review activity, and the cutoff it is measured from. The executor
 * tests (engine/executors/worktree.test.ts) drive it through a stubbed gh; these pin the edges.
 */
import { describe, expect, test } from "bun:test";
import { newReviewActivity, parsePrUrl, REVIEW_BODY_CLIP, REVIEW_REPLY_MARKER, reviewCutoff } from "./review-activity";

const PR = "https://github.com/a/b/pull/3";
const me = { __typename: "User", login: "areeb" };
const T0 = "2026-10-20T10:00:00Z";
const BEFORE = "2026-10-20T09:00:00Z";
const AFTER = "2026-10-20T11:00:00Z";
const LATER = "2026-10-20T12:00:00Z";

describe("reviewCutoff", () => {
  const started = (node: string, ts: string) => ({ type: "node-started", node, ts });
  test("the latest address_reviews start wins; else the FIRST publish; else null", () => {
    expect(reviewCutoff([])).toBeNull();
    expect(reviewCutoff([started("delivery.probe_pr", T0)])).toBeNull();
    // a fix_ci re-publish does not hide a comment nothing has addressed yet
    expect(reviewCutoff([started("delivery.publish", T0), started("delivery.publish", LATER)])).toBe(T0);
    expect(reviewCutoff([
      started("delivery.publish", T0),
      started("delivery.address_reviews", AFTER),
      started("delivery.publish", LATER),
      started("delivery.address_reviews", LATER),
    ])).toBe(LATER);
    // only node-started is read: a node-finished is not a start
    expect(reviewCutoff([{ type: "node-finished", node: "delivery.address_reviews", ts: LATER }, started("delivery.publish", T0)])).toBe(T0);
  });
});

describe("newReviewActivity", () => {
  test("kinds that count, and kinds that never do", () => {
    const { items } = newReviewActivity({
      reviews: { nodes: [
        { author: me, state: "COMMENTED", body: "", submittedAt: AFTER, url: "r-empty" }, // the envelope of inline comments
        { author: me, state: "APPROVED", body: "lgtm", submittedAt: AFTER, url: "r-ok" },
        { author: me, state: "DISMISSED", body: "old", submittedAt: AFTER, url: "r-dis" },
        { author: me, state: "PENDING", body: "draft", submittedAt: AFTER, url: "r-pend" },
        { author: me, state: "CHANGES_REQUESTED", body: "no", submittedAt: AFTER, url: "r-cr" },
      ] },
      comments: { nodes: [null, { author: null, body: "from a deleted account", createdAt: AFTER, url: "c1" }] },
      reviewThreads: { nodes: [{ isResolved: false, path: null, line: null, comments: { nodes: [] } }] },
    }, PR, T0);
    expect(items.map((i) => [i.kind, i.url, i.author])).toEqual([["review", "r-cr", "areeb"], ["comment", "c1", "ghost"]]);
  });

  test("nothing at or before the cutoff counts; a null cutoff counts everything", () => {
    const raw = { comments: { nodes: [{ author: me, body: "x", createdAt: BEFORE, url: "c0" }, { author: me, body: "y", createdAt: T0, url: "c1" }] } };
    expect(newReviewActivity(raw, PR, T0).items).toEqual([]);
    expect(newReviewActivity(raw, PR, null).items.map((i) => i.url)).toEqual(["c0", "c1"]);
  });

  test("a thread is new when its newest HUMAN comment is, and that comment is what is handed over", () => {
    const { items, skipped } = newReviewActivity({
      reviewThreads: { nodes: [{
        isResolved: false, path: "x.ts", line: 4,
        comments: { nodes: [
          { author: me, body: "rename", createdAt: BEFORE, url: "t1" },
          { author: me, body: `done ${REVIEW_REPLY_MARKER}`, createdAt: AFTER, url: "t2" },
          { author: me, body: "not quite — also the test", createdAt: LATER, url: "t3" },
        ] },
      }] },
    }, PR, T0);
    expect(items).toEqual([{ pr: PR, kind: "thread", author: "areeb", at: LATER, url: "t3", body: "not quite — also the test", path: "x.ts", line: 4 }]);
    expect(skipped).toEqual({ bot: 0, howdah: 1 });
  });

  test("a thread whose only new comment is Howdah's reply is not new", () => {
    const { items } = newReviewActivity({
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [
        { author: me, body: "rename", createdAt: BEFORE, url: "t1" },
        { author: me, body: `done\n${REVIEW_REPLY_MARKER}`, createdAt: AFTER, url: "t2" },
      ] } }] },
    }, PR, T0);
    expect(items).toEqual([]);
  });

  test("bots by __typename or by a [bot] login; items sorted oldest first; bodies clipped", () => {
    const long = "z".repeat(REVIEW_BODY_CLIP + 50);
    const { items, skipped } = newReviewActivity({
      comments: { nodes: [
        { author: me, body: long, createdAt: LATER, url: "late" },
        { author: { __typename: "Bot", login: "codecov" }, body: "cov", createdAt: AFTER, url: "b1" },
        { author: { login: "dependabot[bot]" }, body: "bump", createdAt: AFTER, url: "b2" },
        { author: me, body: "early", createdAt: AFTER, url: "early" },
      ] },
    }, PR, T0);
    expect(items.map((i) => i.url)).toEqual(["early", "late"]);
    expect(items[1]!.body.length).toBe(REVIEW_BODY_CLIP + 1);
    expect(skipped).toEqual({ bot: 2, howdah: 0 });
  });

  test("an absent or empty payload is no activity, never a throw", () => {
    expect(newReviewActivity(null, PR, T0)).toEqual({ items: [], skipped: { bot: 0, howdah: 0 }, awaiting: [], lastReviewAt: null });
    expect(newReviewActivity({ reviews: null, comments: { nodes: null } }, PR, null).items).toEqual([]);
  });
});

test("parsePrUrl reads any GitHub host, and refuses what names no PR", () => {
  expect(parsePrUrl("https://github.com/a/b/pull/12")).toEqual({ host: "github.com", owner: "a", name: "b", number: 12 });
  expect(parsePrUrl("https://ghe.corp/x/y/pull/3/files")).toEqual({ host: "ghe.corp", owner: "x", name: "y", number: 3 });
  expect(parsePrUrl("howdah/run-1")).toBeNull();
});

describe("HOW-75: a thread we answered waits on the reviewer", () => {
  const reviewer = { __typename: "User", login: "rita" };
  const operator = { __typename: "User", login: "areeb" };
  const ours = { logins: ["areeb", "howdah-bot-account"] };
  const thread = (comments: Array<{ author: typeof reviewer; body: string; createdAt: string; url: string }>, extra: { path?: string; line?: number } = {}) =>
    ({ isResolved: false, path: extra.path ?? "src/x.ts", line: extra.line ?? 7, comments: { nodes: comments } });
  const ask = { author: reviewer, body: "release or reverse?", createdAt: BEFORE, url: "q" };

  test("our reply last — marked, an unmarked PR-author reply, or the gh viewer's — is not activity and is named as awaiting", () => {
    for (const reply of [
      { author: operator, body: `it is "release" — see the ADR ${REVIEW_REPLY_MARKER}`, createdAt: AFTER, url: "a" },
      { author: operator, body: "it is release, kept on purpose", createdAt: AFTER, url: "a" },
      { author: { __typename: "User", login: "Howdah-Bot-Account" }, body: "answered", createdAt: AFTER, url: "a" },
    ]) {
      const r = newReviewActivity({ reviewThreads: { nodes: [thread([ask, reply])] } }, PR, T0, ours);
      expect(r.items).toEqual([]);
      expect(r.skipped.awaiting).toBe(1);
      expect(r.awaiting).toEqual([{ pr: PR, url: "a", path: "src/x.ts", line: 7, reviewer: "rita" }]);
    }
  });

  test("whatever the cutoff: an answered thread older than it, or with no cutoff at all, still waits", () => {
    const reply = { author: operator, body: "done", createdAt: AFTER, url: "a" };
    expect(newReviewActivity({ reviewThreads: { nodes: [thread([ask, reply])] } }, PR, null, ours).items).toEqual([]);
    expect(newReviewActivity({ reviewThreads: { nodes: [thread([ask, reply])] } }, PR, LATER, ours).awaiting).toHaveLength(1);
  });

  test("the reviewer replying after ours is new activity again, and it is the reviewer's comment handed over", () => {
    const r = newReviewActivity({ reviewThreads: { nodes: [thread([
      ask,
      { author: operator, body: `done ${REVIEW_REPLY_MARKER}`, createdAt: AFTER, url: "a" },
      { author: reviewer, body: "still reads as reverse to me", createdAt: LATER, url: "b" },
    ])] } }, PR, T0, ours);
    expect(r.items.map((i) => [i.kind, i.url, i.author])).toEqual([["thread", "b", "rita"]]);
    expect(r.awaiting).toEqual([]);
  });

  test("a mix: only the thread the reviewer spoke last on counts; the answered one is listed as awaiting", () => {
    const r = newReviewActivity({ reviewThreads: { nodes: [
      thread([ask, { author: operator, body: "answered", createdAt: AFTER, url: "a1" }], { path: "a.ts", line: 1 }),
      thread([
        { author: reviewer, body: "nit", createdAt: BEFORE, url: "n0" },
        { author: operator, body: "fixed", createdAt: AFTER, url: "n1" },
        { author: reviewer, body: "not fixed", createdAt: LATER, url: "n2" },
      ], { path: "b.ts", line: 2 }),
    ] } }, PR, T0, ours);
    expect(r.items.map((i) => i.url)).toEqual(["n2"]);
    expect(r.awaiting.map((a) => a.url)).toEqual(["a1"]);
    expect(r.skipped.awaiting).toBe(1);
  });

  test("a bot speaking last does not hand the turn back: the thread still waits on the human reviewer", () => {
    const r = newReviewActivity({ reviewThreads: { nodes: [thread([
      ask,
      { author: operator, body: "answered", createdAt: AFTER, url: "a" },
      { author: { __typename: "Bot", login: "linter" } as typeof reviewer, body: "beep", createdAt: LATER, url: "bot" },
    ])] } }, PR, T0, ours);
    expect(r.items).toEqual([]);
    expect(r.awaiting.map((a) => a.url)).toEqual(["a"]);
  });

  test("a thread made only of our own comments is still activity (a self-review, HOW-70)", () => {
    const r = newReviewActivity({ reviewThreads: { nodes: [thread([{ author: operator, body: "TODO: rename this", createdAt: AFTER, url: "self" }])] } }, PR, T0, ours);
    expect(r.items.map((i) => i.url)).toEqual(["self"]);
    expect(r.awaiting).toEqual([]);
  });

  test("without `ours`, only the marker makes a comment ours — an unmarked reply is the HOW-70 rule unchanged", () => {
    const r = newReviewActivity({ reviewThreads: { nodes: [thread([ask, { author: operator, body: "answered", createdAt: AFTER, url: "a" }])] } }, PR, T0);
    expect(r.items.map((i) => i.url)).toEqual(["a"]);
  });

  test("lastReviewAt: the newest review by somebody who is neither us nor a bot, of any state", () => {
    const r = newReviewActivity({ reviews: { nodes: [
      { author: reviewer, state: "CHANGES_REQUESTED", body: "", submittedAt: BEFORE, url: "r0" },
      { author: reviewer, state: "APPROVED", body: "", submittedAt: AFTER, url: "r1" },
      { author: operator, state: "COMMENTED", body: "self", submittedAt: LATER, url: "r2" },
      { author: { __typename: "Bot", login: "ci" }, state: "COMMENTED", body: "x", submittedAt: LATER, url: "r3" },
    ] } }, PR, T0, ours);
    expect(r.lastReviewAt).toBe(AFTER);
  });
});
