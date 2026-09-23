/**
 * Component tests for the slice UI (system-map 1d, eng review D27): happy-dom (registered by
 * web/app/dom-preload.ts via bunfig.toml) + bun:test, rendered with react-dom and driven with
 * real DOM events. Every view object comes from the real read model (deriveSlice over a
 * fixture log), so these also pin the contract between derive.ts and the components.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveSlice, deriveStatus, snapshotIndex, type SliceView } from "../derive";
import { FakeLog, FIND, HANDLER_EDGE, ROUTE, SNAPSHOT, drift, failApproval, ghostsV1, ghostsV2, pin, planV1, proposeAndPark, proposeRound, started } from "../slice.fixtures";
import { ApprovalCard, DriftView, MapProgressLine, TierGlyph, slicePanes } from "./slice";
import { clockTime as clock } from "../../core/clock-time";
import { StatusBadge } from "./status";

// ---- harness ------------------------------------------------------------------------------

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

function render(el: ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

type Call = { url: string; body: any };
/** Replace fetch with a scripted one; `respond` may return a promise to hold the request open. */
function mockFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const $ = (el: ParentNode, sel: string) => el.querySelector(sel) as HTMLElement | null;
const $$ = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
const button = (el: ParentNode, label: string) => {
  const b = $$(el, "button").find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}" in: ${$$(el, "button").map((x) => x.textContent).join(" | ")}`);
  return b as HTMLButtonElement;
};

/** Type into a React-controlled input/textarea: the native setter, then an input event. */
function type(el: HTMLElement, text: string) {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

/**
 * Deciding a round is two steps now (HOW-16 P1.4): the action opens an AlertDialog and the
 * dialog commits. What is being pinned by going through it here — rather than by exporting a
 * seam that skips it — is that there is NO path from one click to a posted decision.
 */
const CONFIRM: Record<string, string> = { Approve: "Approve the design", "Send feedback": "Send the feedback" };
async function decide(el: ParentNode, label: "Approve" | "Send feedback") {
  await click(button(el, label));
  await click(button(el, CONFIRM[label]!));
}

// ---- fixtures -------------------------------------------------------------------------------

function awaitingSlice(): { slice: SliceView; log: FakeLog; id: number } {
  const log = new FakeLog();
  started(log);
  const id = proposeAndPark(log, ghostsV1());
  return { slice: deriveSlice(log.events, snapshotIndex(SNAPSHOT))!, log, id };
}

const noop = () => {};

// ---- approval card --------------------------------------------------------------------------

describe("ApprovalCard", () => {
  test("renders the round and every ghost grouped block → entities → edges, with op and tier glyphs", () => {
    const { slice, id } = awaitingSlice();
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);
    expect($(el, ".ap-round")!.textContent).toBe(`current round 1 · proposal #${id}`);

    const groups = $$(el, ".ghost-group");
    expect(groups.map((g) => g.dataset.block)).toEqual(["api", "web/src"]);
    const apiIds = $$(groups[0]!, ".ghost-item").map((i) => i.dataset.id);
    expect(apiIds).toEqual(["api", ROUTE, FIND, "com.x.Users.legacy()", HANDLER_EDGE]);

    // every op is a distinct SHAPE, named for assistive tech — no colour taxonomy
    const opOf = (key: string) => $(el, `.ghost-item[data-id="${CSS.escape(key)}"] .op-glyph`)!;
    expect(opOf(ROUTE).dataset.op).toBe("add");
    expect(opOf(FIND).dataset.op).toBe("modify");
    expect(opOf("com.x.Users.legacy()").dataset.op).toBe("remove");
    expect(opOf("web/src").dataset.op).toBe("keep");
    const paths = new Set(["add", "modify", "remove", "keep"].map((op) => $(el, `.op-glyph[data-op="${op}"] path`)!.getAttribute("d")));
    expect(paths.size).toBe(4);
    for (const g of $$(el, ".op-glyph")) expect(g.getAttribute("style")).toBeNull();

    // tier glyphs where the base knows the key; none on an add
    const tierOf = (key: string) => $(el, `.ghost-item[data-id="${CSS.escape(key)}"] .tier-glyph`);
    expect(tierOf(FIND)!.dataset.tier).toBe("syntactic");
    expect(tierOf("web/src/users#load")!.dataset.tier).toBe("resolved");
    expect(tierOf(ROUTE)).toBeNull();

    // edges read from → to; prose is labelled unverified
    expect($(el, `.ghost-item[data-id="${CSS.escape(HANDLER_EDGE)}"] .gr-id`)!.textContent).toBe(`${ROUTE} → ${FIND}`);
    expect($(el, `.ghost-item[data-id="api"] .gr-prose`)!.textContent).toContain("prose, not verified");
    expect($(el, ".ap-trace-steps")!.textContent).toContain(ROUTE);
  });

  test("amber is the needs-you state only: awaiting gets it, a decided round does not", () => {
    const { slice, log, id } = awaitingSlice();
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);
    expect($(el, ".approval-card")!.classList.contains("needs-you")).toBe(true);
    expect($(el, "h3")!.textContent).toBe("Needs you — approve this design");
    act(() => root!.unmount());

    log.add({ type: "slice-approved", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1" });
    const decided = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(decided, ".approval-card")!.classList.contains("needs-you")).toBe(false);
    expect($(decided, "h3")!.textContent).toBe("Proposed design");
  });

  test("pinning a comment posts the ghost's identity key — an edge pins as from→to:kind", async () => {
    const { slice, id } = awaitingSlice();
    const calls = mockFetch(() => json({ ok: true, proposal_id: id, comment_id: "c99" }, 201));
    const changed = mock(() => {});
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={changed} />);

    await click($(el, `button[aria-label="pin a comment on ${HANDLER_EDGE}"]`)!);
    type($(el, `input[aria-label="comment on ${HANDLER_EDGE}"]`)!, "validate the id first");
    await click(button(el, "Pin"));

    expect(calls).toEqual([{ url: "/api/runs/r1/comments", body: { entity_id: HANDLER_EDGE, text: "validate the id first", proposal_id: id } }]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect($(el, ".gr-pin-form")).toBeNull(); // closed after pinning
  });

  test("a refused pin shows the route's text verbatim in the row, and reloads like a refused decision", async () => {
    const { slice } = awaitingSlice();
    const refusal = "proposal #7 was already approved at 14:02; comment on the next proposal";
    mockFetch(() => json({ error: refusal, code: "already-decided" }, 409));
    const changed = mock(() => {});
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={changed} />);
    await click($(el, `button[aria-label="pin a comment on ${FIND}"]`)!);
    type($(el, `input[aria-label="comment on ${FIND}"]`)!, "x");
    await click(button(el, "Pin"));
    expect($(el, `.ghost-item[data-id="${CSS.escape(FIND)}"] [role="alert"]`)!.textContent).toBe(refusal);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  test("pinned comments show under their row", () => {
    const { log, id } = awaitingSlice();
    pin(log, id, FIND, "use the repository");
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    const row = $(el, `.ghost-item[data-id="${CSS.escape(FIND)}"]`)!;
    expect($$(row, ".ap-comment-text").map((c) => c.textContent)).toEqual(["use the repository"]);
  });

  test("Approve is disabled once the round is decided, and says why", () => {
    const { log, id } = awaitingSlice();
    const approved = log.add({ type: "slice-approved", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1" });
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect(button(el, "Approve").disabled).toBe(true);
    expect(button(el, "Send feedback").disabled).toBe(true);
    expect($(el, '[data-testid="ap-block"]')!.textContent).toBe(`approved at ${clock(approved.ts)}`);
    expect($(el, 'button[aria-label^="pin a comment"]')).toBeNull(); // a decided round takes no more comments
  });

  test("after feedback, Approve says feedback was sent and the explanation says the next round supersedes it", () => {
    const { log, id } = awaitingSlice();
    const c = pin(log, id, FIND, "use the repository");
    const sent = log.add({ type: "slice-feedback-sent", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", comment_ids: [c] });
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect(button(el, "Approve").disabled).toBe(true);
    expect($(el, '[data-testid="ap-block"]')!.textContent).toBe(`feedback sent at ${clock(sent.ts)}`);
    expect($(el, '[data-testid="ap-explain"]')!.textContent).toContain("the next round supersedes this one");
  });

  test("double-clicking Approve issues ONE request, then shows the idempotent answer", async () => {
    const { slice, id } = awaitingSlice();
    let release!: (r: Response) => void;
    const calls = mockFetch(() => new Promise<Response>((r) => (release = r)));
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);
    await click(button(el, "Approve"));
    const confirm = button(el, "Approve the design");
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await click(confirm);
    expect(calls).toEqual([{ url: "/api/runs/r1/approval", body: { approved: true, proposal_id: id } }]);
    expect(button(el, "Approving…").disabled).toBe(true);

    await act(async () => release(json({ ok: true, proposal_id: id, idempotent: true })));
    expect($(el, '[role="status"]')!.textContent).toBe("already approved — nothing new was recorded");
    expect(button(el, "Approve").disabled).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("a decision on round 1 does not disable round 2 when the redraw arrives in the same card", async () => {
    const { log, id } = awaitingSlice();
    const c = pin(log, id, FIND, "use the repository");
    mockFetch(() => json({ ok: true, proposal_id: id, idempotent: false }));
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    await decide(el, "Send feedback");
    expect(button(el, "Approve").disabled).toBe(true);

    log.add({ type: "slice-feedback-sent", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", comment_ids: [c] });
    const r2 = proposeAndPark(log, ghostsV2(), 2);
    act(() => root!.render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />));
    expect($(el, ".ap-round")!.textContent).toBe(`current round 2 · proposal #${r2}`);
    expect(button(el, "Approve").disabled).toBe(false);
    expect($(el, '[role="status"]')).toBeNull();
  });

  test("a 409 refusal is rendered verbatim, never a bare 'failed'", async () => {
    const { slice, id } = awaitingSlice();
    const refusal = `proposal #${id} was superseded by #${id + 9}; decide on the current proposal`;
    const changed = mock(() => {});
    mockFetch(() => json({ error: refusal, code: "superseded" }, 409));
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={changed} />);
    await decide(el, "Approve");
    const alert = $(el, '[role="alert"]')!;
    expect(alert.textContent).toBe(refusal);
    expect(el.textContent).not.toMatch(/\bfailed\b/i);
    expect(changed).toHaveBeenCalledTimes(1); // the log moved on: reload to show where
  });

  test("a refusal stays through the reload it triggers, named by its round once a newer round shows", async () => {
    const { log, id } = awaitingSlice();
    const refusal = `proposal #${id} was superseded by #99; decide on the current proposal`;
    mockFetch(() => json({ error: refusal, code: "superseded" }, 409));
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    await decide(el, "Approve");
    const c = pin(log, id, FIND, "x");
    log.add({ type: "slice-feedback-sent", proposal_id: id, proposal_hash: `h${id}`, manifest_hash: "m1", comment_ids: [c] });
    proposeAndPark(log, ghostsV2(), 2);
    act(() => root!.render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />));
    expect($(el, '[role="alert"]')!.textContent).toBe(`proposal #${id}: ${refusal}`);
  });

  test("parked for another reason on the approval step: amber, and the card points to the Ask tab", () => {
    const log = new FakeLog();
    started(log);
    proposeRound(log, ghostsV1());
    failApproval(log, 1, "approval executor threw: base unreadable");
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(el, ".approval-card")!.classList.contains("needs-you")).toBe(true);
    expect($(el, "h3")!.textContent).toBe("Needs you — see the Ask tab");
    expect($(el, '[data-testid="ap-explain"]')!.textContent).toBe(
      "The run parked on slice.approve (attempt-failed): approval executor threw: base unreadable. Answer it in the Ask tab — a reply, not a design decision, moves it on.",
    );
  });

  test("a transport failure names the cause instead of a bare 'failed'", async () => {
    const { slice } = awaitingSlice();
    globalThis.fetch = mock(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);
    await decide(el, "Approve");
    expect($(el, '[role="alert"]')!.textContent).toBe("could not reach the viewer server: connection refused");
  });

  test("Send feedback needs a comment on this round, then posts approved:false", async () => {
    const { log, id } = awaitingSlice();
    const bare = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect(button(bare, "Send feedback").disabled).toBe(true);
    expect(bare.textContent).toContain("pin at least one comment on this round first");
    act(() => root!.unmount());

    pin(log, id, FIND, "use the repository");
    const calls = mockFetch(() => json({ ok: true, proposal_id: id, idempotent: false }));
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    await decide(el, "Send feedback");
    expect(calls).toEqual([{ url: "/api/runs/r1/approval", body: { approved: false, proposal_id: id } }]);
    expect($(el, '[role="status"]')!.textContent).toBe("feedback sent — the proposer redraws");
  });

  test("Redesign opens a message input and posts the message", async () => {
    const { slice } = awaitingSlice();
    const calls = mockFetch(() => json({ ok: true, jumped_to: "map.extract" }, 202));
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);
    expect($(el, 'textarea[aria-label="redesign message"]')).toBeNull();
    expect(button(el, "Redesign").getAttribute("aria-expanded")).toBe("false");
    await click(button(el, "Redesign"));
    expect(button(el, "Redesign").getAttribute("aria-expanded")).toBe("true");
    type($(el, 'textarea[aria-label="redesign message"]')!, "split the handler from the route");
    await click(button(el, "Request redesign"));
    expect(calls).toEqual([{ url: "/api/runs/r1/redesign", body: { message: "split the handler from the route" } }]);
    expect($(el, '[role="status"]')!.textContent).toContain("redesign requested");
  });

  test("orphaned comments are listed separately and labelled", () => {
    const log = new FakeLog();
    started(log);
    const r1 = proposeAndPark(log, ghostsV1());
    const c = pin(log, r1, "com.x.Users.legacy()", "keep legacy for now");
    log.add({ type: "slice-feedback-sent", proposal_id: r1, proposal_hash: `h${r1}`, manifest_hash: "m1", comment_ids: [c] });
    proposeAndPark(log, ghostsV2(), 2);
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    const orphans = $(el, '[data-testid="orphaned"]')!;
    expect($(orphans, ".rh")!.textContent).toBe("Orphaned (no longer in this proposal)");
    expect($(orphans, ".ap-comment-key")!.textContent).toBe("com.x.Users.legacy()");
    expect($(orphans, ".ap-comment-text")!.textContent).toBe("keep legacy for now");
    expect($(el, '.ghost-item[data-id="com.x.Users.legacy()"]')).toBeNull();
    // the superseded round is still explained in the history
    expect($(el, ".ap-rounds")!.textContent).toContain("feedback sent at");
    expect($(el, ".ap-rounds")!.textContent).toContain("superseded");
  });

  test("a stale round explains itself in words and cannot be approved", () => {
    const { log, id } = awaitingSlice();
    log.add({
      type: "node-finished", node: "slice.approve", visit: 1, status: "succeeded",
      writes: { "slice.approval": { outcome: "stale", proposal_id: id, reason: "worktree changed during slice.propose: tracked changes differ" } },
    });
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(el, '[data-testid="ap-explain"]')!.textContent).toBe(
      "Stale: worktree changed during slice.propose: tracked changes differ. The map is re-extracted and a fresh proposal drawn — nothing to decide on this round.",
    );
    expect(button(el, "Approve").disabled).toBe(true);
    expect($(el, ".approval-card")!.classList.contains("needs-you")).toBe(false);
  });

  test("a pending redesign explains that this proposal will be superseded", () => {
    const { log } = awaitingSlice();
    log.add({ type: "slice-redesign-requested", approval: "slice.approve", message: "split the handler" });
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(el, '[data-testid="ap-explain"]')!.textContent).toContain("a new proposal supersedes this one");
    expect(button(el, "Approve").disabled).toBe(true);
  });
});

// ---- drift view -----------------------------------------------------------------------------

// ---- the slice plan (HOW-23) ------------------------------------------------------------

describe("ApprovalCard over a slice plan", () => {
  function awaitingPlan(): { slice: SliceView; log: FakeLog; id: number } {
    const log = new FakeLog();
    started(log, "plan-feature");
    const id = proposeAndPark(log, planV1());
    return { slice: deriveSlice(log.events)!, log, id };
  }

  test("renders one row per slice — the feature, the title, the workspace and the ordering", () => {
    const { slice } = awaitingPlan();
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);

    expect($$(el, ".plan-slice").map((s) => s.dataset.id)).toEqual(["api-route", "web-client"]);
    expect($(el, ".plan-feature")!.textContent).toBe("let users delete their account");
    expect($(el, '.plan-slice[data-id="api-route"] .gr-id')!.textContent).toBe("DELETE /api/users/{id}");
    expect($(el, '.plan-slice[data-id="api-route"] .gr-prose')!.textContent).toBe("the route exists");
    // a slice that names its own workspace says so; one that inherits shows nothing
    expect($(el, '.plan-slice[data-id="web-client"] .gr-kind')!.textContent).toBe("web");
    expect($(el, '.plan-slice[data-id="api-route"] .gr-kind')).toBeNull();
    expect($(el, '.plan-slice[data-id="web-client"] .plan-deps')!.textContent).toContain("after api-route");
    expect($(el, '.plan-slice[data-id="web-client"] .plan-deps')!.textContent).toContain("ordering only");

    // the plan's edges are as much a decision as its slices
    expect(el.textContent).toContain("Out of scope");
    expect(el.textContent).toContain("the admin UI");
    expect(el.textContent).toContain("Risks");

    // a plan is NOT a ghost set: no ghost rows, no tier summary, and never the raw fallback
    expect($$(el, ".ghost-group")).toHaveLength(0);
    expect($(el, ".ap-tiers")).toBeNull();
    expect($(el, ".sd-raw")).toBeNull();
  });

  test("a comment pins to a SLICE id through the same route and the same form as a ghost", async () => {
    const { slice, id } = awaitingPlan();
    const calls = mockFetch(() => json({ ok: true }));
    const el = render(<ApprovalCard runId="r1" slice={slice} onChanged={noop} />);

    await click($(el, '.plan-slice[data-id="web-client"] .gr-pin')!);
    type($(el, '.plan-slice[data-id="web-client"] input')!, "fold this into the first slice");
    await click(button($(el, '.plan-slice[data-id="web-client"]')!, "Pin"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/runs/r1/comments");
    expect(calls[0]!.body).toEqual({ entity_id: "web-client", text: "fold this into the first slice", proposal_id: id });
  });

  test("a comment already pinned to a slice is shown on that slice's row", () => {
    const log = new FakeLog();
    started(log, "plan-feature");
    const id = proposeAndPark(log, planV1());
    pin(log, id, "api-route", "split the migration out");
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(el, '.plan-slice[data-id="api-route"] .ap-comment-text')!.textContent).toBe("split the migration out");
  });

  test("a proposal that is neither a ghost set nor a plan still shows as proposed", () => {
    const log = new FakeLog();
    started(log, "quick-task");
    proposeAndPark(log, { something: "else" });
    const el = render(<ApprovalCard runId="r1" slice={deriveSlice(log.events)!} onChanged={noop} />);
    expect($(el, ".pd-note")!.textContent).toContain("not a ghost set");
    expect($(el, ".sd-raw")!.textContent).toContain("something");
    expect($$(el, ".plan-slice")).toHaveLength(0);
  });
});

describe("DriftView", () => {
  const report = () => {
    const log = new FakeLog();
    started(log);
    log.add(drift(
      [
        { key: "v", outcome: "verified", evidence: "api/src/A.kt:3" },
        { key: "n", outcome: "not-checked", reason: "partial coverage: helper-built route" },
        { key: "m", outcome: "missing", reason: "absent after; fully searched", evidence: "api/src/Routes.kt:1" },
        { key: "u", outcome: "unexpected", evidence: "api/src/B.kt:9" },
        { key: "s", outcome: "still-present", evidence: "api/src/Users.kt:40" },
      ],
      { commit: "abc1234def5678", truncated: 3, extra: { verified: 3 } },
    ));
    return log;
  };

  test("groups worst first, stamps the commit it checked, shows reasons, evidence and the truncated count", () => {
    const el = render(<DriftView drift={deriveSlice(report().events)!.drifts[0]!} />);
    expect($$(el, ".dv-group").map((g) => g.dataset.outcome)).toEqual(["missing", "still-present", "unexpected", "not-checked", "verified"]);
    expect($(el, '[data-testid="drift-stamp"]')!.textContent).toBe("checked at abc1234def56");
    const missing = $(el, '.dv-item[data-outcome="missing"]')!;
    expect(missing.textContent).toContain("absent after; fully searched");
    expect($(missing, ".dv-evidence")!.textContent).toBe("api/src/Routes.kt:1");
    expect($(el, '.dv-item[data-outcome="not-checked"] .dv-reason')!.textContent).toBe("partial coverage: helper-built route");
    expect($(el, '.dv-group[data-outcome="verified"] .dv-count')!.textContent).toBe("4");
    expect($(el, '[data-testid="drift-truncated"]')!.textContent).toContain("3 items not listed");
  });

  test("colour only where the code disagrees with the design (PROBLEM_OUTCOMES): verified and not-checked carry none", () => {
    const el = render(<DriftView drift={deriveSlice(report().events)!.drifts[0]!} />);
    const glyph = (o: string) => $(el, `.dv-item[data-outcome="${o}"] .drift-glyph`)!;
    for (const o of ["missing", "still-present"]) expect(glyph(o).classList.contains("problem")).toBe(true);
    for (const o of ["verified", "not-checked", "unexpected"]) {
      expect(glyph(o).classList.contains("problem")).toBe(false);
      expect(glyph(o).getAttribute("style")).toBeNull();
    }
    // shapes differ per outcome, so greyscale still reads
    const shapes = new Set(["verified", "not-checked", "missing", "unexpected", "still-present"].map((o) => glyph(o).innerHTML.replace(/<title>.*<\/title>/, "")));
    expect(shapes.size).toBe(5);
    // and nothing in a drift report is ever amber
    expect(el.innerHTML).not.toContain("attention");
  });

  test("a dirty snapshot is named as such and explains why nothing is verified", () => {
    const log = new FakeLog();
    started(log);
    log.add(drift([{ key: "a", outcome: "not-checked", reason: "verified only in uncommitted changes" }], { dirty: true }));
    const el = render(<DriftView drift={deriveSlice(log.events)!.drifts[0]!} />);
    expect($(el, '[data-testid="drift-stamp"]')!.textContent).toBe("checked at abc1234def56 + uncommitted changes");
    expect(el.textContent).toContain("nothing in it is reported verified");
  });

  test("says when HEAD has moved past the checked commit", () => {
    const log = report();
    log.add({ type: "reconciled", node: "delivery.publish", git: { repo: true, branch: "b", head: "fff9999aaa", uncommitted: 0, unpushed: 0 }, disagreements: [] });
    const el = render(<DriftView drift={deriveSlice(log.events)!.drifts[0]!} />);
    expect(el.textContent).toContain("HEAD is now fff9999aaa — this check does not cover the latest code.");
  });
});

// ---- map progress, pane routing, status -------------------------------------------------------

describe("slice panes and progress", () => {
  test("tier glyphs: five distinct shapes at 12px, at most two of them round", () => {
    const tiers = ["observed", "resolved", "syntactic", "evidence-checked", "unresolved"] as const;
    const el = render(<>{tiers.map((t) => <TierGlyph key={t} tier={t} />)}</>);
    const glyphs = $$(el, ".tier-glyph");
    for (const g of glyphs) expect([g.getAttribute("width"), g.getAttribute("height")]).toEqual(["12", "12"]);
    const shapes = glyphs.map((g) => g.innerHTML.replace(/<title>.*?<\/title>/, ""));
    expect(new Set(shapes).size).toBe(5);
    expect(shapes.filter((s) => s.includes("<circle")).length).toBeLessThanOrEqual(2);
    expect(shapes.some((s) => s.includes("dasharray"))).toBe(false); // no sub-pixel dashes
  });

  test("map progress reads 'mapping files done/total'", () => {
    const el = render(<MapProgressLine progress={{ node: "map.extract", visit: 1, done: 412, total: 1300, skipped: 3 }} />);
    expect($(el, '[data-testid="map-progress"]')!.textContent).toBe("mapping files 412/1300 · 3 skipped");
  });

  test("the approval step opens on the approval card; the drift step on its report; others get none", () => {
    const { log } = awaitingSlice();
    log.add(drift([{ key: "a", outcome: "verified" }]));
    const slice = deriveSlice(log.events)!;
    const row = (node: string) => ({ node, visit: 1, started_at: "", finished_at: null, status: "running" as const, duration_ms: null, offset_ms: 0, run_span_ms: 1, waiting_ms: 0 });
    expect(slicePanes(slice, row("slice.approve")).map((p) => p.value)).toEqual(["approval"]);
    expect(slicePanes(slice, row("map.drift")).map((p) => p.value)).toEqual(["drift"]);
    expect(slicePanes(slice, row("implementation.implement"))).toEqual([]);
    expect(slicePanes(null, row("slice.approve"))).toEqual([]);
  });

  test("the status renderer still shows needs-input over a failure", () => {
    const log = new FakeLog();
    started(log);
    log.add({ type: "node-started", node: "slice.propose", visit: 1, attempt_id: "slice.propose#1" });
    log.add({ type: "node-finished", node: "slice.propose", visit: 1, status: "failed", writes: {} });
    log.add({ type: "attention-raised", node: "slice.propose", visit: 1, reason: "the ghost set was invalid", code: "attempt-failed" });
    const { status, failure } = deriveStatus(log.events);
    expect(failure).not.toBeNull();
    const el = render(<StatusBadge status={status} />);
    expect($(el, ".status")!.dataset.status).toBe("needs-input");
    expect(el.textContent?.trim()).toBe("needs input");
  });
});

beforeEach(() => {
  document.body.innerHTML = "";
});
