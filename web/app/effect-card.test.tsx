/**
 * Component test for the effect card (HOW-3): happy-dom (registered by web/app/dom-preload.ts
 * via bunfig.toml) + bun:test, driven with real DOM events. The card's rows come from the real
 * read model (deriveDetail over a fixture log), so this also pins the contract between
 * derive.ts's `ambiguous_effects` and the component.
 *
 * What matters here: the two verdicts are offered as BUTTONS (a reply textarea would be
 * refused by resolveReply), each POSTs the effect it names, and a 409 refusal is shown
 * verbatim instead of collapsing into a generic failure.
 */
import { afterEach, expect, describe, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog, started } from "../slice.fixtures";
import { EffectCard } from "./main";

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
function mockFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const $$ = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
const button = (el: ParentNode, label: string) => {
  const b = $$(el, "button").find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}" in: ${$$(el, "button").map((x) => x.textContent).join(" | ")}`);
  return b as HTMLButtonElement;
};
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

/** a run parked on ambiguous-effect, through the real read model */
function ambiguousDetail() {
  const log = new FakeLog();
  started(log);
  log.add({ type: "node-started", node: "publish", visit: 1, attempt_id: "publish#1" });
  log.add({ type: "side-effect-intent", node: "publish", visit: 1, attempt_id: "publish#1", effect: "create-pr" });
  log.add({ type: "attention-raised", node: "publish", visit: 1, reason: 'ambiguous side effect "create-pr" — probe could not decide', code: "ambiguous-effect" });
  return deriveDetail("r1", log.events);
}

describe("EffectCard (HOW-3)", () => {
  test("derive fills ambiguous_effects only while the run is parked on ambiguous-effect", () => {
    expect(ambiguousDetail().ambiguous_effects).toEqual([{ node: "publish", visit: 1, effect: "create-pr", attempt_id: "publish#1" }]);
    const plain = new FakeLog();
    started(plain);
    plain.add({ type: "node-started", node: "publish", visit: 1, attempt_id: "publish#1" });
    plain.add({ type: "side-effect-intent", node: "publish", visit: 1, attempt_id: "publish#1", effect: "create-pr" });
    expect(deriveDetail("r1", plain.events).ambiguous_effects).toEqual([]); // not parked: nothing to ask about
  });

  test("both verdicts are offered, and the chosen one POSTs the effect it names", async () => {
    const detail = ambiguousDetail();
    const calls = mockFetch(() => json({ ok: true, idempotent: false }));
    const resolved: number[] = [];
    const el = render(<EffectCard runId="r1" ask={detail.ask!} effects={detail.ambiguous_effects} onResolved={() => resolved.push(1)} />);

    expect(el.textContent).toContain("create-pr");
    expect(el.textContent).toContain("probe could not decide");
    button(el, "It happened"); // both must exist before we click either
    await click(button(el, "It didn't happen"));

    expect(calls).toEqual([{ url: "/api/runs/r1/effects", body: { effect: "create-pr", verdict: "not-happened", node: "publish" } }]);
    expect(el.textContent).toContain("Recorded");
  });

  test('"It happened" sends the other verdict', async () => {
    const detail = ambiguousDetail();
    const calls = mockFetch(() => json({ ok: true, idempotent: false }));
    const el = render(<EffectCard runId="r1" ask={detail.ask!} effects={detail.ambiguous_effects} onResolved={() => {}} />);
    await click(button(el, "It happened"));
    expect(calls[0]!.body.verdict).toBe("happened");
  });

  test("a 409 refusal is shown verbatim, and the buttons stay usable", async () => {
    const detail = ambiguousDetail();
    mockFetch(() => json({ error: "runner is live — pause or abort first, then resolve-effect", code: "runner-live" }, 409));
    const el = render(<EffectCard runId="r1" ask={detail.ask!} effects={detail.ambiguous_effects} onResolved={() => {}} />);
    await click(button(el, "It happened"));
    expect(el.textContent).toContain("runner is live — pause or abort first, then resolve-effect");
    expect(button(el, "It happened").disabled).toBe(false);
  });
});
