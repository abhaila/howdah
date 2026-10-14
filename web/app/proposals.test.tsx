/**
 * Rejecting a revision (HOW-16 P1.4). Reject is the destructive verb on this screen — it
 * closes a draft and files the reason as feedback the reviser reads next time — so it
 * confirms through an AlertDialog with the reason typed inside it.
 *
 * What is pinned here is the failure path, because a modal confirmation gets it wrong by
 * default. The dialog is a native `<dialog>` opened with `showModal()`: it makes the rest of
 * the document inert and covers it with a `::backdrop`, and BOTH places a refusal is reported
 * — the inline `banner failed` and the aria-live toast region — render outside it. A dialog
 * left open across its own failure therefore reports nothing the operator can read or dismiss.
 * So it closes before the POST, and the typed reason survives a refusal so reopening does not
 * cost it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProposalView } from "../../prompts/proposals";
import { ProposalsScreen } from "./screens/proposals";
import { ToastProvider } from "./components/ui/toast";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

const PROPOSAL: ProposalView = {
  id: "delivery.publish",
  file: "delivery.publish-v3.md",
  path: "reviser/proposals/delivery.publish-v3.md",
  base_version: 2,
  base_includes: undefined,
  fork: false,
  proposed_version: 3,
  status: "pending",
  body: "the proposed template",
  frontmatter: "",
  created: "2026-09-19T13:00:00.000Z",
  accepted_at: null,
  rejected_at: null,
  rejection_reason: null,
  diff: null,
  reflection: null,
  current_version: 2,
  stale: false,
  stale_reason: null,
  indirect_consumers: [],
  eval: { case: null, score: null, verdict: null, report: null },
  feedback: [],
};

/** GET answers with the one pending proposal; every write answers with `write` */
function serve(write: { status: number; body: unknown }, proposal: ProposalView = PROPOSAL) {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if ((init?.method ?? "GET") !== "GET") {
      posts.push(url);
      return new Response(JSON.stringify(write.body), { status: write.status, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify([proposal]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { posts };
}

async function render(): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ToastProvider><ProposalsScreen selected={null} /></ToastProvider>); });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
});

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const reasonInput = (el: HTMLElement) => el.querySelector("dialog input") as HTMLInputElement;

async function openRejectWithReason(el: HTMLElement, reason: string) {
  await act(async () => button(el, "Reject")!.click());
  const input = reasonInput(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, reason);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("rejecting a revision", () => {
  test("the confirmation asks in the prompt's name and cannot be sent empty", async () => {
    serve({ status: 200, body: {} });
    const el = await render();
    await act(async () => button(el, "Reject")!.click());
    const dialog = el.querySelector("dialog")!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("delivery.publish");
    expect(button(el, "Reject the revision")!.disabled).toBe(true); // no reason, no reject
  });

  test("a refused reject closes the dialog and keeps the reason for the retry", async () => {
    const { posts } = serve({ status: 409, body: { error: "delivery.publish proposal is already accepted" } });
    const el = await render();
    await openRejectWithReason(el, "the second paragraph is wrong");
    await act(async () => button(el, "Reject the revision")!.click());

    // the regression: the dialog stayed open over the banner and the toast, both of which
    // render outside it — inert behind its backdrop, and unreadable
    expect(el.querySelectorAll("dialog").length).toBe(0);
    expect(posts.length).toBe(1);
    expect(el.querySelector(".banner.failed")!.textContent).toContain("already accepted");
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain("already accepted");
    // and the typed reason is not lost to a refusal
    await act(async () => button(el, "Reject")!.click());
    expect(reasonInput(el).value).toBe("the second paragraph is wrong");
  });

  test("an accepted reject closes the dialog, clears the reason and announces the outcome", async () => {
    const { posts } = serve({ status: 200, body: {} });
    const el = await render();
    await openRejectWithReason(el, "drops the refusal contract");
    await act(async () => button(el, "Reject the revision")!.click());
    expect(el.querySelectorAll("dialog").length).toBe(0);
    expect(posts[0]).toContain("/reject");
    expect(el.querySelectorAll(".banner.failed").length).toBe(0);
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain("the reviser reads your reason as feedback");
    await act(async () => button(el, "Reject")!.click());
    expect(reasonInput(el).value).toBe("");
  });
});

// a stale proposal used to show ONLY Re-draft — and one with no feedback to re-draft from could
// then never be closed. Accept stays off (accepting would drop whatever moved the base, D7).
describe("a stale proposal can still be closed", () => {
  test("Reject is offered beside Re-draft; Accept is not", async () => {
    serve({ status: 200, body: {} }, { ...PROPOSAL, stale: true, current_version: 3 });
    const el = await render();
    expect(button(el, "Reject")).toBeDefined();
    expect([...el.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Accept"))).toBe(false);
    expect([...el.querySelectorAll("button")].some((b) => b.textContent?.includes("Re-draft"))).toBe(true);
  });
});
