/**
 * HOW-68: the browser notification for a run that newly starts waiting (lib/notify.ts).
 *
 * `decideNotify` is the whole decision and is pinned without a DOM. The posting half is
 * exercised against a fake `Notification`, because the things that matter there are exactly
 * the ones a real browser would not let a test observe: that nothing is constructed without
 * permission, that the tag is the run id, and where the click goes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decideNotify, notifyPermission, notifyRuns, requestNotifyPermission, runAskHref, sendTestNotification } from "@/lib/notify";
import { observeAsks } from "@/lib/attention-sound";

const HIDDEN = { permission: "granted" as const, visible: false, focused: false };

describe("decideNotify", () => {
  const info = { a: { name: "HOW-431 Rate-limit headers", body: "Some acceptance criteria are not proven." } };

  test("a new run is announced by its name and what it is asking", () => {
    expect(decideNotify(["a"], info, HIDDEN)).toEqual([{ id: "a", title: "HOW-431 Rate-limit headers", body: "Some acceptance criteria are not proven." }]);
  });

  test("nothing without permission — default and denied are both a no", () => {
    for (const permission of ["default", "denied", "unsupported"] as const) {
      expect(decideNotify(["a"], info, { ...HIDDEN, permission })).toEqual([]);
    }
  });

  test("nothing while the page is visible AND focused: the operator is already looking", () => {
    expect(decideNotify(["a"], info, { permission: "granted", visible: true, focused: true })).toEqual([]);
    // visible but in a background window, or focused but on another tab: they are not looking
    expect(decideNotify(["a"], info, { permission: "granted", visible: true, focused: false })).toHaveLength(1);
    expect(decideNotify(["a"], info, { permission: "granted", visible: false, focused: true })).toHaveLength(1);
  });

  test("nothing fresh, nothing posted", () => {
    expect(decideNotify([], info, HIDDEN)).toEqual([]);
  });

  test("a run the screen has no note for is announced by its id rather than dropped", () => {
    expect(decideNotify(["z"], info, HIDDEN)).toEqual([{ id: "z", title: "z", body: "A run is waiting on you." }]);
  });
});

describe("posting", () => {
  const posted: Array<{ title: string; options: NotificationOptions; self: { onclick: (() => void) | null; closed: boolean } }> = [];
  let permission: NotificationPermission = "granted";
  let asked = 0;
  const realHasFocus = document.hasFocus;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    posted.length = 0;
    permission = "granted";
    asked = 0;
    class FakeNotification {
      static get permission() { return permission; }
      static requestPermission() { asked++; permission = "granted"; return Promise.resolve(permission); }
      onclick: (() => void) | null = null;
      closed = false;
      constructor(title: string, options: NotificationOptions) { posted.push({ title, options, self: this }); }
      close() { this.closed = true; }
    }
    (globalThis as any).Notification = FakeNotification;
    document.hasFocus = () => false; // a background tab
    sessionStorage.clear();
    globalThis.fetch = (async () => new Response(JSON.stringify({ chime: false }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  });
  afterEach(() => {
    delete (globalThis as any).Notification;
    document.hasFocus = realHasFocus;
    globalThis.fetch = realFetch;
    history.replaceState(null, "", "/");
  });

  test("with no Notification API nothing throws and nothing is posted", async () => {
    delete (globalThis as any).Notification;
    expect(notifyPermission()).toBe("unsupported");
    expect(notifyRuns(["a"], {})).toBe(0);
    expect(sendTestNotification()).toBe(false);
    expect(await requestNotifyPermission()).toBe("unsupported");
  });

  test("the tag is the run id, and the click focuses the ask", () => {
    expect(notifyRuns(["run/1"], { "run/1": { name: "Paginate invoices", body: "Cursor or offset pagination?" } })).toBe(1);
    expect(posted[0]!.title).toBe("Paginate invoices");
    expect(posted[0]!.options).toEqual({ body: "Cursor or offset pagination?", tag: "run/1" });
    posted[0]!.self.onclick!();
    expect(location.pathname + location.hash).toBe(runAskHref("run/1"));
    expect(location.hash).toBe("#needs-input");
    expect(posted[0]!.self.closed).toBe(true);
  });

  test("without permission nothing is constructed", () => {
    permission = "default";
    expect(notifyRuns(["a"], {})).toBe(0);
    permission = "denied";
    expect(notifyRuns(["a"], {})).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("a focused, visible page posts nothing", () => {
    document.hasFocus = () => true;
    expect(notifyRuns(["a"], {})).toBe(0);
    expect(posted).toHaveLength(0);
  });

  test("permission is only ever requested by the function Settings' button calls", async () => {
    permission = "default";
    notifyRuns(["a"], {});
    sendTestNotification();
    expect(asked).toBe(0);
    expect(await requestNotifyPermission()).toBe("granted");
    expect(asked).toBe(1);
  });

  test("observeAsks: one decision — the first sight posts nothing, a run already seen posts nothing, a new one posts once", async () => {
    const info = { a: { name: "A", body: "a asks" }, b: { name: "B", body: "b asks" } };
    await observeAsks({ waiting: ["a"], cleared: "others", info }); // first sight of the session
    expect(posted).toHaveLength(0);
    await observeAsks({ waiting: ["a"], cleared: "others", info }); // navigation
    expect(posted).toHaveLength(0);
    await observeAsks({ waiting: ["a", "b"], cleared: "others", info }); // b newly waits
    expect(posted.map((p) => [p.title, p.options.body, p.options.tag])).toEqual([["B", "b asks", "b"]]);
    await observeAsks({ waiting: ["a", "b"], cleared: "others", info });
    expect(posted).toHaveLength(1);
  });

  test("the test notification is shown even while the page is focused", () => {
    document.hasFocus = () => true;
    expect(sendTestNotification()).toBe(true);
    expect(posted[0]!.options.tag).toBe("howdah-test");
  });
});
