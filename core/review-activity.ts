/**
 * HOW-70: what counts as NEW review activity on a PR — the rule probe:pr routes
 * CHANGES_REQUIRED on beside GitHub's `reviewDecision`. Node-free and pure: the probe feeds it
 * gh's GraphQL answer and the run's own log, and the graphs share its constants.
 *
 * Why the decision alone was not enough: GitHub refuses to let a PR's author request changes on
 * their own PR, and every Howdah PR is opened as the operator, so `reviewDecision` never said
 * CHANGES_REQUESTED for anything the operator wrote and delivery.address_reviews never ran.
 * Now three kinds of item count — a review submitted COMMENTED or CHANGES_REQUESTED with a body,
 * a plain PR (issue) comment, and an UNRESOLVED inline thread — when created after the cutoff.
 *
 * Loop safety — what stops "the agent replied, so there is new activity, so reply again":
 *   1. THE CUTOFF MOVES, and it is read from the LOG, never a stored cursor (`reviewCutoff`):
 *      the latest `node-started` of address_reviews, else the FIRST publish's — the first, so a
 *      comment posted before a fix_ci re-publish is still new when nothing has addressed it.
 *      `node-started` rather than `node-finished`, so a comment the operator posts WHILE the
 *      repair runs is picked up by the next probe instead of silently falling behind it.
 *   2. THE MARKER: Howdah's replies are posted from the operator's own account, so they cannot
 *      be told apart by author. delivery.address_reviews (v3) ends every reply with
 *      `REVIEW_REPLY_MARKER`, an invisible HTML comment, and anything carrying it is skipped.
 *   3. BOTS NEVER COUNT: an author whose `__typename` is `Bot`, or whose login ends `[bot]`
 *      (github-actions, dependabot, CI reporters). A bot's verdict reaches delivery through the
 *      checks (CI_FAILED), not through prose, and prose from a bot re-posted on every push would
 *      be a repair loop by construction.
 *   4. A THREAD WE ANSWERED WAITS ON THE REVIEWER (HOW-75): an unresolved thread whose latest
 *      human comment is OURS — it carries the marker, or its author is the PR's author or the gh
 *      identity the probe runs as — after some comment by somebody else, is not activity at all,
 *      whatever the cutoff. It is the reviewer's turn; counting it sent the run back to
 *      address_reviews on every probe with nothing to do, and the repair's correct "no change"
 *      then parked `no-progress`. Such threads are returned as `awaiting`, so a park can name
 *      them. A thread made only of our own comments still counts (a self-review, HOW-70).
 *   5. The backstop is HOW-75's `repair-stalled` (core/repair-stall.ts): a repair that changed
 *      nothing, then a probe demanding the same repair with nothing new on the PR, parks there.
 * Known limit: a reply WITHOUT the marker (a run pinned to the v2 prompt) by an account that is
 * neither the PR's author nor the probe's gh identity can buy one extra pass at most, because
 * the cutoff moves past it as soon as that pass starts.
 */

/** ends every comment Howdah posts on a PR; invisible when GitHub renders the markdown */
export const REVIEW_REPLY_MARKER = "<!-- howdah -->";
/** the node that is handed review activity, and the publish that opened the PR */
export const ADDRESS_REVIEWS_NODE = "delivery.address_reviews";
export const PUBLISH_NODE = "delivery.publish";
/** per-item body clip: activity goes into a prompt, and one pasted log must not crowd it out */
export const REVIEW_BODY_CLIP = 2000;

export interface ReviewItem {
  /** the PR's url — a stack hands every PR's items to one repair */
  pr: string;
  kind: "review" | "comment" | "thread";
  author: string;
  at: string;
  url: string;
  body: string;
  path?: string;
  line?: number;
}

/** why an item after the cutoff was not counted — the probe names these so a quiet probe is legible */
export interface ReviewSkips {
  bot: number;
  howdah: number;
  /** HOW-75: unresolved threads we answered last, waiting on the reviewer (any age) */
  awaiting?: number;
}

/** HOW-75: an unresolved thread whose latest comment is ours — the reviewer's turn, not ours */
export interface AwaitingThread {
  pr: string;
  /** the latest comment's url, else the PR's */
  url: string;
  path?: string;
  line?: number;
  /** who the thread waits on: the latest commenter who is not us */
  reviewer: string;
}

/** HOW-75: who "we" are on a PR — the PR's author and the gh identity the probe runs as */
export interface OurIdentity {
  logins: readonly string[];
}

/** the minimal event shape the cutoff reads — engine logs satisfy it */
type CutoffEvent = { type: string; ts: string; node?: string };

/**
 * The instant after which review activity is new, from the run's log: the latest start of
 * address_reviews, else the first start of publish, else null (everything counts).
 */
export function reviewCutoff(events: readonly CutoffEvent[]): string | null {
  const started = events.filter((e) => e.type === "node-started");
  return started.findLast((e) => e.node === ADDRESS_REVIEWS_NODE)?.ts ?? started.find((e) => e.node === PUBLISH_NODE)?.ts ?? null;
}

type Author = { __typename?: string | null; login?: string | null } | null | undefined;
type RawComment = { author?: Author; body?: string | null; createdAt?: string | null; url?: string | null };
type RawReview = { author?: Author; state?: string | null; body?: string | null; submittedAt?: string | null; url?: string | null };
type RawThread = { isResolved?: boolean | null; path?: string | null; line?: number | null; comments?: { nodes?: (RawComment | null)[] | null } | null };
/** `data.repository.pullRequest` of the probe's GraphQL query (REVIEW_ACTIVITY_QUERY) */
export interface RawReviewActivity {
  /** HOW-75: the PR's author — Howdah opens every PR as the operator, so their replies are ours */
  author?: { login?: string | null } | null;
  reviews?: { nodes?: (RawReview | null)[] | null } | null;
  comments?: { nodes?: (RawComment | null)[] | null } | null;
  reviewThreads?: { nodes?: (RawThread | null)[] | null } | null;
}

/** one GraphQL call for all three kinds; `last: 100` is the window a probe looks back over */
export const REVIEW_ACTIVITY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login }
      reviews(last: 100) { nodes { author { __typename login } state body submittedAt url } }
      comments(last: 100) { nodes { author { __typename login } body createdAt url } }
      reviewThreads(last: 100) { nodes { isResolved path line comments(last: 20) { nodes { author { __typename login } body createdAt url } } } }
    }
  }
  viewer { login }
}`;

export const isBotAuthor = (a: Author): boolean => a?.__typename === "Bot" || (a?.login ?? "").endsWith("[bot]");
const isHowdahReply = (body: string | null | undefined): boolean => (body ?? "").includes(REVIEW_REPLY_MARKER);
const newer = (at: string | null | undefined, since: string | null): at is string =>
  typeof at === "string" && at !== "" && (since === null || Date.parse(at) > Date.parse(since));
const clip = (s: string): string => (s.length > REVIEW_BODY_CLIP ? `${s.slice(0, REVIEW_BODY_CLIP)}…` : s);
const nodes = <T>(c: { nodes?: (T | null)[] | null } | null | undefined): T[] => (c?.nodes ?? []).filter((n): n is T => n != null);

/** what one PR's review activity amounts to (newReviewActivity) */
export interface ReviewActivity {
  items: ReviewItem[];
  skipped: ReviewSkips;
  /** HOW-75: threads answered by us and waiting on the reviewer — never items */
  awaiting: AwaitingThread[];
  /** HOW-75: when somebody other than us and not a bot last submitted a review, of any state */
  lastReviewAt: string | null;
}

/**
 * The review activity on one PR created after `since`, oldest first, and what was skipped.
 * `ours` (HOW-75) names the logins whose comments are ours; absent, only the marker says so.
 */
export function newReviewActivity(raw: RawReviewActivity | null | undefined, pr: string, since: string | null, ours?: OurIdentity): ReviewActivity {
  const items: ReviewItem[] = [];
  const skipped: ReviewSkips = { bot: 0, howdah: 0 };
  const awaiting: AwaitingThread[] = [];
  const mine = new Set((ours?.logins ?? []).filter((l) => l !== "").map((l) => l.toLowerCase()));
  const isOurs = (author: Author, body: string | null | undefined): boolean =>
    isHowdahReply(body) || (typeof author?.login === "string" && mine.has(author.login.toLowerCase()));
  /** after the cutoff and by a human reviewer — counting why the rest were left out */
  const counts = (author: Author, body: string | null | undefined, at: string | null | undefined): at is string => {
    if (!newer(at, since)) return false;
    if (isBotAuthor(author)) { skipped.bot++; return false; }
    if (isHowdahReply(body)) { skipped.howdah++; return false; }
    return true;
  };
  const login = (a: Author) => a?.login ?? "ghost";
  let lastReviewAt: string | null = null;
  for (const r of nodes(raw?.reviews)) {
    if (!isBotAuthor(r.author) && !isOurs(r.author, r.body) && typeof r.submittedAt === "string" && r.submittedAt !== ""
      && (lastReviewAt === null || Date.parse(r.submittedAt) > Date.parse(lastReviewAt))) lastReviewAt = r.submittedAt;
    // an empty COMMENTED review is only the envelope of its inline comments — counted as threads
    if ((r.state !== "COMMENTED" && r.state !== "CHANGES_REQUESTED") || !(r.body ?? "").trim()) continue;
    if (counts(r.author, r.body, r.submittedAt)) items.push({ pr, kind: "review", author: login(r.author), at: r.submittedAt, url: r.url ?? pr, body: clip(r.body ?? "") });
  }
  for (const c of nodes(raw?.comments))
    if (counts(c.author, c.body, c.createdAt)) items.push({ pr, kind: "comment", author: login(c.author), at: c.createdAt, url: c.url ?? pr, body: clip(c.body ?? "") });
  for (const t of nodes(raw?.reviewThreads)) {
    if (t.isResolved) continue;
    const where = { ...(t.path ? { path: t.path } : {}), ...(typeof t.line === "number" ? { line: t.line } : {}) };
    // HOW-75: answered by us last, after somebody else spoke — the reviewer's turn, whatever its age
    const human = nodes(t.comments).filter((c) => !isBotAuthor(c.author));
    const last = human.at(-1);
    const reviewer = human.findLast((c) => !isOurs(c.author, c.body));
    if (last !== undefined && reviewer !== undefined && isOurs(last.author, last.body)) {
      skipped.awaiting = (skipped.awaiting ?? 0) + 1;
      awaiting.push({ pr, url: last.url ?? pr, ...where, reviewer: login(reviewer.author) });
      continue;
    }
    // the thread is new when its newest human comment is; that comment is what is handed over
    const fresh = nodes(t.comments).filter((c) => counts(c.author, c.body, c.createdAt));
    const latest = fresh.at(-1);
    if (latest === undefined) continue;
    items.push({ pr, kind: "thread", author: login(latest.author), at: latest.createdAt as string, url: latest.url ?? pr, body: clip(latest.body ?? ""), ...where });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { items, skipped, awaiting, lastReviewAt };
}

/** owner / name / number of a PR url (any GitHub host), or null when it names no PR */
export function parsePrUrl(url: string): { host: string; owner: string; name: string; number: number } | null {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) return null;
  return { host: m[1], owner: m[2], name: m[3], number: Number(m[4]) };
}
