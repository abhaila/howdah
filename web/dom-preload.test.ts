/**
 * Guard for web/app/dom-preload.ts: the happy-dom preload runs before every test file, so a
 * NON-DOM test must still see Bun's own runtime globals. Bun's are native; happy-dom's are JS
 * classes, so "[native code]" tells them apart without importing either.
 */
import { describe, expect, test } from "bun:test";
import { RUNTIME } from "./app/dom-preload";

const native = (v: unknown) => typeof v === "function" && Function.prototype.toString.call(v).includes("[native code]");

describe("happy-dom preload keeps Bun's runtime globals", () => {
  test.each(["fetch", "Response", "Request", "Headers", "setTimeout", "clearTimeout", "DOMException", "AbortController", "URL", "WebSocket"])("%s is Bun's", (name) => {
    expect(native((globalThis as Record<string, unknown>)[name])).toBe(true);
  });

  test("every restored global is still there, and the DOM was added", () => {
    for (const name of RUNTIME) expect((globalThis as Record<string, unknown>)[name]).toBeDefined();
    expect(typeof document.createElement).toBe("function");
  });

  test("Bun's Response and timers behave as Bun's", async () => {
    expect(await new Response("ok").text()).toBe("ok");
    expect(new DOMException("x", "AbortError").name).toBe("AbortError");
    await new Promise<void>((r) => setTimeout(r, 1));
  });
});
