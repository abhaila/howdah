/**
 * The shell (HOW-68): the router's 404, and the rail.
 *
 * The 404 is the one that shipped wrong for the app's whole life: `isRuns` was "nothing else
 * matched", so every mistyped or stale address rendered the Runs list under a URL that was
 * not the Runs list's. What is pinned is both directions — an unknown path says so, and a
 * known path still does not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./main";
import { resetShortcutsForTest } from "@/lib/shortcuts";

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

async function at(path: string): Promise<HTMLElement> {
  history.pushState(null, "", path);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App />); });
  await act(async () => { await Bun.sleep(10); });
  return host;
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* not every environment has one */ }
  resetShortcutsForTest();
  // every count the rail polls for: nothing waiting, nothing pending
  globalThis.fetch = (async () => new Response("[]", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = host = null;
  globalThis.fetch = realFetch;
  history.pushState(null, "", "/");
});

describe("an unknown path is a 404, not the Runs list", () => {
  test("it says nothing lives there, quotes the path, and offers the way back", async () => {
    const el = await at("/no/such/screen");
    const screen = el.querySelector('[data-screen="not-found"]') as HTMLElement;
    expect(screen).not.toBeNull();
    expect(screen.querySelector("h1")!.textContent).toBe("Nothing lives here");
    expect(screen.querySelector("code")!.textContent).toBe("/no/such/screen");
    const back = [...screen.querySelectorAll("a")].find((a) => a.textContent === "Go to Runs")!;
    expect(back.getAttribute("href")).toBe("/");
    expect([...screen.querySelectorAll("button")].some((b) => b.textContent!.includes("Find a command"))).toBe(true);
  });

  test("no rail item is lit, because it is not any of those places", async () => {
    const el = await at("/no/such/screen");
    expect(el.querySelector("nav a.nav.active")).toBeNull();
    expect(el.querySelector('nav a[aria-current="page"]')).toBeNull();
  });

  test("a path that only STARTS like a real one is still unknown", async () => {
    for (const path of ["/new/extra", "/settingsx", "/dev", "/graphs/a/b/c"]) {
      const el = await at(path);
      expect(el.querySelector('[data-screen="not-found"]'), path).not.toBeNull();
      act(() => root!.unmount());
      host!.remove();
    }
  });

  test("a real path is not a 404, and a trailing slash is the same place", async () => {
    for (const path of ["/dev/components", "/dev/components/"]) {
      const el = await at(path);
      expect(el.querySelector('[data-screen="not-found"]'), path).toBeNull();
      expect(el.querySelector('[data-screen="gallery"]'), path).not.toBeNull();
      act(() => root!.unmount());
      host!.remove();
    }
  });
});

describe("the rail", () => {
  test("every item is a named link with its key printed, and labels cannot wrap", async () => {
    const el = await at("/dev/components");
    const items = [...el.querySelectorAll("nav a.nav")] as HTMLAnchorElement[];
    expect(items.map((a) => a.getAttribute("aria-label"))).toEqual(["Runs", "Needs you", "New run", "Graphs", "Prompts", "Proposals", "Settings"]);
    expect(items.map((a) => a.getAttribute("href"))).toEqual(["/", "/attention", "/new", "/graphs", "/prompts", "/proposals", "/settings"]);
    expect([...items[0]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["G", "R"]);
    expect([...items[2]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["C"]);
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    expect(css.match(/\.sidebar a\.nav\s*\{([^}]*)\}/)?.[1] ?? "").toContain("white-space: nowrap");
  });

  test("a count replaces the key hint and is part of the item's NAME — amber only for waiting", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/api/attention") ? [{}, {}] : url.includes("/api/ready") ? [{}] : url.includes("/api/proposals") ? [{ status: "pending" }] : [];
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const el = await at("/dev/components");
    const needs = el.querySelector('nav a[href="/attention"]') as HTMLAnchorElement;
    expect(needs.getAttribute("aria-label")).toBe("Needs you, 2 waiting on you, 1 ready to review");
    expect(needs.querySelector("kbd")).toBeNull();
    const badges = [...needs.querySelectorAll(".nav-badge")];
    expect(badges.map((b) => [b.textContent, b.classList.contains("quiet")])).toEqual([["2", false], ["1", true]]);
    // a pending proposal can wait: it is a plain count, never the alarm colour
    const proposals = el.querySelector('nav a[href="/proposals"]') as HTMLAnchorElement;
    expect(proposals.getAttribute("aria-label")).toBe("Proposals, 1 pending");
    expect(proposals.querySelector(".nav-badge")!.classList.contains("quiet")).toBe(true);
  });

  test("the foot offers the palette, and there is a skip link to the content", async () => {
    const el = await at("/dev/components");
    expect(el.querySelector('nav button[aria-label="Commands"]')).not.toBeNull();
    expect((el.querySelector("a.skip-link") as HTMLAnchorElement).getAttribute("href")).toBe("#main");
    expect(el.querySelector("main#main")).not.toBeNull();
  });

  test("there is no load splash: the app is on screen on the first render", async () => {
    const el = await at("/dev/components");
    expect(el.querySelector(".splash")).toBeNull();
    const css = await Bun.file(new URL("../public/howdah.css", import.meta.url)).text();
    expect(css).not.toContain(".splash");
  });
});
