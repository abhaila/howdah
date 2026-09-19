/**
 * happy-dom test preload (system-map 1d, eng review D27) — registered by bunfig.toml for the
 * whole `bun test` run, so component tests (`web/app/*.test.tsx`) get a DOM with no extra
 * runner.
 *
 * It runs before EVERY test file (server, engine and map suites included), so what it changes
 * is listed here exactly. Registering happy-dom replaces ~40 of Bun's globals and adds ~490.
 *
 *   RESTORED to Bun's own after registration (RUNTIME below) — the non-DOM suites depend on
 *   them: fetch, Request, Response, Headers, FormData, Blob, File, URL, URLSearchParams,
 *   AbortController, AbortSignal, TextEncoder, TextDecoder, the web streams, WebSocket, the
 *   timers, queueMicrotask, performance, crypto, console, structuredClone,
 *   atob, btoa, Worker, MessageChannel, MessagePort, BroadcastChannel, navigator, DOMException.
 *
 *   LEFT REPLACED by happy-dom, because the DOM needs one coherent event system and window IS
 *   globalThis: Event, EventTarget, CustomEvent, ErrorEvent, MessageEvent, CloseEvent,
 *   PerformanceObserverEntryList, the global addEventListener / removeEventListener /
 *   dispatchEvent / postMessage, self, onerror, onmessage. Bun's own objects (AbortSignal,
 *   WebSocket, Worker) keep dispatching their internal event classes, so this is invisible to
 *   code that does not construct DOM events itself.
 *
 *   ADDED (did not exist before): window, document, location, history, localStorage,
 *   sessionStorage, the HTML/SVG element classes, DOM event subclasses (MouseEvent, …),
 *   getComputedStyle, requestAnimationFrame, CSS, name/open/close and the rest of Window.
 *
 * web/dom-preload.test.ts guards the restored set. Component tests mock `fetch` themselves.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Bun runtime globals the non-DOM suites rely on — restored after happy-dom registers. */
export const RUNTIME = [
  "fetch", "Request", "Response", "Headers", "FormData", "Blob", "File", "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "ReadableStream", "WritableStream",
  "TransformStream", "WebSocket", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "setImmediate", "clearImmediate", "queueMicrotask", "performance", "crypto", "console", "structuredClone",
  "atob", "btoa", "Worker", "MessageChannel", "MessagePort", "BroadcastChannel", "navigator", "DOMException",
] as const;

const saved = RUNTIME.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
GlobalRegistrator.register({ url: "http://localhost:4711/" });
for (const [key, descriptor] of saved) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
}

// React's act() warns unless the environment declares itself a test
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
