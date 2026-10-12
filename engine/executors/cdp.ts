/**
 * HOW-52: a minimal Chrome DevTools Protocol client over chrome-headless-shell — just enough to
 * navigate, wait for a page to render, collect its console errors and take a screenshot.
 *
 * Why not Playwright: the `playwright` package is not a dependency (CLAUDE.md admits three, on
 * purpose), and on this machine full Playwright launches timed out three review rounds running
 * while the bare headless-shell binary from its browser cache worked first time. CDP over the
 * global WebSocket is ~100 lines and has no dependency tree to name.
 *
 * Why not `--screenshot` with `--virtual-time-budget`: a page holding an SSE stream (every
 * Howdah run page) never goes idle, so virtual time never settles — it hangs, or captures a
 * blank page. Captures here wait for the load event, a DOM-ready check and a fixed render pause,
 * NEVER for network idle.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The headless browser: $HOWDAH_BROWSER, else the newest chrome-headless-shell in Playwright's
 * browser cache. Null when there is none — the caller reports `not-checked`, never a pass.
 */
export function findHeadlessBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HOWDAH_BROWSER) return existsSync(env.HOWDAH_BROWSER) ? env.HOWDAH_BROWSER : null;
  const caches = [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const shells = readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const dir of shells) {
      for (const platform of readdirSync(join(cache, dir))) {
        const bin = join(cache, dir, platform, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

/** a free loopback TCP port, by binding port 0 and letting it go */
export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export interface CdpPage {
  /** navigate, wait for load + DOM-ready + `renderWaitMs`, and return the console errors seen */
  visit(url: string, opts?: { loadTimeoutMs?: number; renderWaitMs?: number; readyWhen?: string }): Promise<{ errors: string[] }>;
  /** a PNG of the current viewport */
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function openBrowser(binary: string, viewport: { width: number; height: number }, opts: { launchTimeoutMs?: number } = {}): Promise<CdpPage> {
  const port = freePort();
  const profile = mkdtempSync(join(tmpdir(), "howdah-cdp-"));
  const proc = Bun.spawn(
    [binary, "--headless", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${viewport.width},${viewport.height}`, "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const cleanup = () => {
    try { proc.kill("SIGKILL"); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  let ws: WebSocket | null = null;
  const deadline = Date.now() + (opts.launchTimeoutMs ?? 15_000);
  while (!ws && Date.now() < deadline) {
    await Bun.sleep(100);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((p) => p.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not listening yet */ }
  }
  if (!ws) { cleanup(); throw new Error(`the headless browser did not open a debugging port within ${opts.launchTimeoutMs ?? 15_000}ms`); }
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP websocket failed")); });

  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(method: string, params: any) => void>();
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg.method, msg.params);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws!.send(JSON.stringify({ id: i, method, params }));
    });

  await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  return {
    async visit(url, o = {}) {
      const errors: string[] = [];
      const onEvent = (method: string, params: any) => {
        if (method === "Runtime.consoleAPICalled" && params.type === "error")
          errors.push(params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
        else if (method === "Runtime.exceptionThrown")
          errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "uncaught exception");
        else if (method === "Log.entryAdded" && params.entry?.level === "error")
          errors.push(`${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`);
      };
      listeners.add(onEvent);
      try {
        let loaded!: () => void;
        const load = new Promise<void>((r) => (loaded = r));
        const onLoad = (method: string) => { if (method === "Page.loadEventFired") loaded(); };
        listeners.add(onLoad);
        await send("Page.navigate", { url });
        await Promise.race([load, Bun.sleep(o.loadTimeoutMs ?? 15_000)]);
        listeners.delete(onLoad);
        // DOM-ready, then a fixed pause for the app to render — never "network idle"
        for (let i = 0; i < 50; i++) {
          const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
          if (r?.result?.value === "complete") break;
          await Bun.sleep(100);
        }
        // the app's own "the real screen is up" signal, when the contract names one
        if (o.readyWhen) {
          const until = Date.now() + (o.loadTimeoutMs ?? 15_000);
          while (Date.now() < until) {
            const r = await send("Runtime.evaluate", { expression: `Boolean(${o.readyWhen})`, returnByValue: true }).catch(() => null);
            if (r?.result?.value === true) break;
            await Bun.sleep(100);
          }
        }
        await Bun.sleep(o.renderWaitMs ?? 1500);
        return { errors: [...errors] };
      } finally {
        listeners.delete(onEvent);
      }
    },
    async screenshot() {
      const r = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(r.data, "base64");
    },
    async close() {
      try { ws!.close(); } catch {}
      cleanup();
    },
  };
}
