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
    expect(newReviewActivity(null, PR, T0)).toEqual({ items: [], skipped: { bot: 0, howdah: 0 } });
    expect(newReviewActivity({ reviews: null, comments: { nodes: null } }, PR, null).items).toEqual([]);
  });
});

test("parsePrUrl reads any GitHub host, and refuses what names no PR", () => {
  expect(parsePrUrl("https://github.com/a/b/pull/12")).toEqual({ host: "github.com", owner: "a", name: "b", number: 12 });
  expect(parsePrUrl("https://ghe.corp/x/y/pull/3/files")).toEqual({ host: "ghe.corp", owner: "x", name: "y", number: 3 });
  expect(parsePrUrl("howdah/run-1")).toBeNull();
});
