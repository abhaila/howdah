#!/usr/bin/env node
/**
 * HOW-68 baseline screenshots + audits.
 *
 *   node shoot.mjs                 # everything
 *   node shoot.mjs dark-run-done   # only shots whose name contains the argument
 *
 * Needs the viewer on :4799 over <scratch>/home and the empty-home viewer on the next port
 * (see README.md). Writes shots/*.png, shots/audit.json (per-screen measurements),
 * shots/dialogs.json (Escape behaviour) and shots/failures.json (steps that threw) — which
 * analyze.py turns into the STANDARDS gate.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(import.meta.url)("playwright");

import { tmpdir } from "node:os";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(process.env.HOWDAH_VISUAL_OUT ?? join(tmpdir(), "howdah-visual"), "shots");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.HOWDAH_BASE ?? `http://localhost:${process.env.HOWDAH_VISUAL_PORT ?? 4799}`;
const only = process.argv[2];
/** STEPS=<regex>: run only the steps whose name matches (each such step must start with its own `go`) */
const stepRe = process.env.STEPS ? new RegExp(process.env.STEPS) : null;

const R = {
  done: "implement-ticket-mhs8q2lf",
  prose: "implement-ticket-mhv2k9qd",
  long: "implement-ticket-how-431-add-rate-limit-headers-to-the-public-api-gateway-and-document-them-mhv3a7xw",
  question: "quick-task-mhv41c0p",
  effect: "implement-ticket-mhv4d2e8",
  failed: "implement-ticket-mhq17zzb",
  aborted: "implement-ticket-mhp90aa1",
  dead: "write-doc-mhv5t0c3",
  live: "implement-ticket-mhv6live",
  paused: "implement-ticket-mhv1p4uz",
  maxvisits: "implement-ticket-mhv0b1ne",
  unauth: "research-mhuz6r4k",
  stuck: "quick-task-mhv5c8aa",
  planAwait: "plan-feature-mhv3zz10",
  parent: "plan-feature-mhu7d3k2",
  childStacked: "plan-feature-mhu7d3k2--api-handler",
  slice: "implement-slice-mhv2ghst",
  draftReady: "draft-graph-mhv4r1aa",
  draftSaved: "draft-graph-mhs0p7bb",
  research: "research-mht4n8s2",
  // HOW-68: the states added for the design review (seed.ts section O, live.ts)
  parallelDone: "review-change-mhv5pa7l",
  parallelParked: "review-change-mhv6pb2x",
  timeout: "quick-task-mhv6t1mo",
  noProgress: "implement-ticket-mhv5np0g",
  repairStalled: "implement-ticket-mhv3rs7l",
  staleBase: "implement-slice-mhv2st4b",
  drift: "implement-slice-mhv1dr1f",
  gated: "gated-publish-mhv4ga9t",
  permission: "quick-task-mhv6pm3x",
  elicitation: "research-mhv6el1c",
  softStopped: "quick-task-mhv6ss0p",
  queued: "quick-task-mhv7q0ue",
  failedRecoverable: "quick-task-mhv6fr2k",
  unverified: "quick-task-mho1k3p1",
  evidenceFailed: "implement-ticket-mhs2ev1d",
  stackedWaiting: "plan-feature-mhu7d3k2--audit-export",
  contextExhausted: "quick-task-mhu1x0d7",
  // the confirming review's stress run (seed.ts section P): 600+ transcript items, a 6,000-character line, a large JSON result, a 300-character unbroken token
  longTranscript: "quick-task-mhv7long",
};
/** the second viewer serve.sh starts over the EMPTY home: no runs, workspaces, local graphs or proposals */
const EMPTY = process.env.HOWDAH_EMPTY_BASE ?? `http://localhost:${Number(process.env.HOWDAH_VISUAL_PORT ?? 4799) + 1}`;

const audits = {};
const dialogs = [];
const failures = [];
const made = [];

/** everything measured in the page, in one evaluate */
const AUDIT = () => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const sel = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += "#" + e.id; const c = (typeof e.className === "string" ? e.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join("."); if (c) s += "." + c; return s; };
  const path = (e) => { const p = []; for (let n = e, i = 0; n && n !== document.body && i < 3; n = n.parentElement, i++) p.unshift(sel(n)); return p.join(" > "); };
  const txt = (e) => (e.innerText || e.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 70);
  const inView = (e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
  // Two things that clip or sit off-view BY DESIGN, and were reported as defects:
  //   a visually-hidden label (`sr-only`: a 1px box clipping its own text, for screen readers);
  //   React Flow's canvas — a pannable viewport whose content is meant to extend past the pane
  //   and is reached by panning, zooming and "Show the whole graph", not by a scrollbar.
  const srOnly = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (n.classList.contains("sr-only") || (s.position === "absolute" && s.clip !== "auto" && n.clientWidth <= 1 && n.clientHeight <= 1) || s.clipPath === "inset(50%)") return true; } return false; };
  const inCanvas = (e) => !!e.closest(".react-flow");
  const exempt = (e) => srOnly(e) || inCanvas(e);
  // a control that is switched off: exempt from WCAG contrast, and counted separately so a
  // contrast FAILURE means live text
  const isDisabled = (e) => !!e.closest(":disabled, [aria-disabled='true'], [data-disabled], [data-off]") && !e.closest("[aria-busy='true']");

  // text-bearing elements: those with a direct non-empty text node
  const textEls = [...document.body.querySelectorAll("*")].filter((e) => vis(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  const fonts = {}, sizes = {};
  for (const e of textEls) {
    const s = getComputedStyle(e);
    const fam = s.fontFamily.split(",")[0].trim().replace(/["']/g, "");
    (fonts[fam] ??= { count: 0, samples: [] }).count++;
    if (fonts[fam].samples.length < 6 && !fonts[fam].samples.includes(sel(e))) fonts[fam].samples.push(sel(e));
    const key = s.fontSize;
    (sizes[key] ??= { count: 0, samples: [] }).count++;
    if (sizes[key].samples.length < 4 && !sizes[key].samples.includes(sel(e))) sizes[key].samples.push(sel(e));
  }

  // clipped: overflow hidden/clip in an axis whose content is bigger than the box
  const clipped = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (!vis(e) || exempt(e)) continue;
    const s = getComputedStyle(e);
    const y = (s.overflowY === "hidden" || s.overflowY === "clip") && e.scrollHeight > e.clientHeight + 4;
    const x = (s.overflowX === "hidden" || s.overflowX === "clip") && e.scrollWidth > e.clientWidth + 4 && s.textOverflow !== "ellipsis";
    if ((y || x) && e.clientHeight > 0 && s.webkitLineClamp === "none")
      clipped.push({ el: path(e), axis: `${x ? "x" : ""}${y ? "y" : ""}`, client: [e.clientWidth, e.clientHeight], scroll: [e.scrollWidth, e.scrollHeight], text: txt(e).slice(0, 50) });
  }
  // does the document itself scroll, or does anything?
  const de = document.scrollingElement;
  const scrollers = [...document.body.querySelectorAll("*")].filter((e) => vis(e) && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4).map((e) => ({ el: sel(e), client: e.clientHeight, scroll: e.scrollHeight }));
  // content below the fold that no scroller can reach
  const main = document.querySelector("main");
  const unreachable = [];
  if (main) for (const e of main.querySelectorAll("*")) {
    if (!vis(e) || e.children.length || exempt(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.top >= innerHeight - 1 || r.left >= innerWidth - 1) {
      let ok = false;
      for (let n = e.parentElement; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if ((/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1 && r.top >= innerHeight - 1) || (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1 && r.left >= innerWidth - 1)) { ok = true; break; }
        if (n === document.documentElement) { const d = document.scrollingElement; if ((r.top >= innerHeight - 1 && d.scrollHeight > d.clientHeight + 1 && getComputedStyle(document.body).overflowY !== "hidden" && s.overflowY !== "hidden") || (r.left >= innerWidth - 1 && d.scrollWidth > d.clientWidth + 1)) ok = true; }
      }
      if (!ok && unreachable.length < 12) unreachable.push({ el: path(e), text: txt(e).slice(0, 50), top: Math.round(r.top), left: Math.round(r.left) });
    }
  }

  // ellipsis with no way to read the value
  const truncated = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (!vis(e)) continue;
    const s = getComputedStyle(e);
    const single = s.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1;
    const clamp = s.webkitLineClamp !== "none" && e.scrollHeight > e.clientHeight + 1;
    if (!single && !clamp) continue;
    let escape = null;
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute("title")) { escape = "title"; break; }
      if (n.hasAttribute("data-tooltip") || n.getAttribute("aria-describedby")) { escape = "tooltip"; break; }
    }
    const link = e.closest("a,button");
    truncated.push({ el: path(e), kind: single ? "ellipsis" : "line-clamp", shown: [e.clientWidth, e.scrollWidth], text: (e.textContent || "").trim().slice(0, 90), escape, inside: link ? link.tagName.toLowerCase() : null });
  }

  // hit areas
  const small = [];
  for (const e of document.body.querySelectorAll("button, a[href], input, select, textarea, [role=tab], [role=button], [role=checkbox], summary")) {
    if (!vis(e) || !inView(e)) continue;
    const r = e.getBoundingClientRect();
    if (e.tagName === "INPUT" && (e.type === "hidden")) continue;
    // a canvas the operator zoomed OUT ("Show the whole graph") shrinks its controls with it, as
    // browser zoom would: the target rule is judged at 100%, where every card and caption is ≥24px
    const flow = e.closest(".react-flow__viewport");
    if (flow && new DOMMatrixReadOnly(getComputedStyle(flow).transform).a < 0.999) continue;
    if (r.width < 24 || r.height < 24) small.push({ el: path(e), w: Math.round(r.width), h: Math.round(r.height), text: txt(e).slice(0, 40) });
  }

  // contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) { const o = c.match(/oklch|oklab|color\(/); return o ? null : null; } const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const cvs = document.createElement("canvas"); cvs.width = cvs.height = 1; const cx = cvs.getContext("2d", { willReadFrequently: true });
  const toRgb = (c) => { const p = parse(c); if (p) return p; cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (e) => { const stack = []; for (let n = e; n; n = n.parentElement) { const s = getComputedStyle(n); if (s.backgroundImage !== "none") return null; const c = toRgb(s.backgroundColor); if (c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; const root = toRgb(getComputedStyle(document.documentElement).backgroundColor); if (root.a > 0) base = root; if (stack.length && stack.at(-1).a >= 1) base = stack.pop(); for (const c of stack.reverse()) base = over(c, base); return base; };
  const contrast = {};
  for (const e of textEls) {
    if (!inView(e) || srOnly(e)) continue;
    const s = getComputedStyle(e);
    if (Number(s.opacity) === 0) continue;
    const bg = bgOf(e); if (!bg) continue;
    let op = 1; for (let n = e; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    const fgRaw = toRgb(s.color); const fg = over({ ...fgRaw, a: fgRaw.a * op }, bg);
    const l1 = lum(fg), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    if (ratio < need) {
      const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      const key = `${hex(fg)} on ${hex(bg)}`;
      const row = (contrast[key] ??= { ratio: Math.round(ratio * 100) / 100, need, count: 0, disabled: 0, sizes: [], samples: [] });
      row.count++; if (isDisabled(e)) row.disabled++; if (!row.sizes.includes(s.fontSize)) row.sizes.push(s.fontSize);
      if (row.samples.length < 4) row.samples.push(`${sel(e)} "${txt(e).slice(0, 30)}"`);
    }
  }
  return {
    viewport: [innerWidth, innerHeight], doc: { clientH: de.clientHeight, scrollH: de.scrollHeight, clientW: de.clientWidth, scrollW: de.scrollWidth, bodyOverflow: getComputedStyle(document.body).overflow, htmlOverflow: getComputedStyle(document.documentElement).overflow },
    fonts, sizes, clipped: clipped.slice(0, 40), scrollers, unreachable, truncated: truncated.slice(0, 60), small: small.slice(0, 60), contrast,
  };
};

/** Tab through the page; report focus stops with no visible ring by computed style */
async function focusAudit(page, max = 40) {
  const rows = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  await page.mouse.click(2, 2).catch(() => {});
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const e = document.activeElement; if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      const sel = e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
      const rect = e.getBoundingClientRect();
      // a ring may be drawn on a wrapper (:focus-within) — look two levels up as well
      let wrapper = false;
      for (let n = e.parentElement, k = 0; n && k < 2; n = n.parentElement, k++) { const ps = getComputedStyle(n); if (n.matches(":focus-within") && ((ps.outlineStyle !== "none" && parseFloat(ps.outlineWidth) > 0) || (ps.boxShadow !== "none" && /focus|ring/.test(n.className + "")))) wrapper = true; }
      return { el: sel, text: (e.getAttribute("aria-label") || e.innerText || e.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 40), outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, shadow: s.boxShadow === "none" ? "none" : s.boxShadow.slice(0, 60), ringed: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none" || wrapper, focusVisible: e.matches(":focus-visible"), offscreen: rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth, inFrame: e.tagName === "IFRAME" };
    });
    if (!r) continue;
    rows.push(r);
  }
  return { stops: rows.length, unringed: rows.filter((r) => !r.ringed && !r.inFrame), offscreen: rows.filter((r) => r.offscreen).map((r) => r.el + " " + r.text) };
}

const browser = await chromium.launch();

async function withPage(theme, vp, fn) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript((t) => { try { sessionStorage.setItem("howdah-splash", "1"); for (const k of Object.keys(localStorage)) localStorage.removeItem(k); localStorage.setItem("howdah-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  page.setDefaultTimeout(3500);
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message.slice(0, 200)}`));
  try { await fn(page); } finally { await ctx.close(); }
}

/** one shot: go, settle, act, capture (+ optional audit) */
function mk(page, theme, suffix = "") {
  const go = async (path) => { await page.goto(BASE + path, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(900); };
  const snap = async (name, opts = {}) => {
    const full = `${theme}-${name}${suffix}`;
    if (only && !full.includes(only)) return;
    await page.waitForTimeout(opts.wait ?? 350);
    await page.screenshot({ path: join(OUT, `${full}.png`) });
    made.push(full);
    if (opts.audit) { try { audits[full] = await page.evaluate(AUDIT); } catch (e) { failures.push(`${full}: audit ${e.message.slice(0, 120)}`); } }
    if (opts.focus) { try { audits[full].focus = await focusAudit(page, opts.focus === true ? 40 : opts.focus); } catch (e) { failures.push(`${full}: focus ${e.message.slice(0, 120)}`); } }
  };
  const step = async (name, fn) => { if (stepRe && !stepRe.test(name)) return; try { await fn(); } catch (e) { failures.push(`${theme}-${name}${suffix}: ${String(e.message).split("\n")[0].slice(0, 220)}`); } };
  const tab = (name) => page.getByRole("tab", { name, exact: true }).first().click();
  /** open → shot → Escape → did it close? */
  const dialog = async (name, open) => {
    await step(`dialog-${name}`, async () => {
      await open();
      await page.waitForSelector("dialog[open]", { timeout: 3000 });
      await snap(`dialog-${name}`);
      const role = await page.evaluate(() => document.querySelector("dialog[open]")?.getAttribute("role"));
      const focusInside = await page.evaluate(() => !!document.querySelector("dialog[open]")?.contains(document.activeElement));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const closed = (await page.locator("dialog[open]").count()) === 0;
      dialogs.push({ name: `${theme}-dialog-${name}${suffix}`, role, focusInside, closesOnEscape: closed });
      if (!closed) { await page.evaluate(() => document.querySelector("dialog[open]")?.close()); await page.keyboard.press("Escape"); }
    });
  };
  return { go, snap, step, tab, dialog };
}

async function fullPass(theme) {
  const A = theme === "dark"; // audits are taken once, on dark (light adds contrast only)
  await withPage(theme, { width: 1440, height: 900 }, async (page) => {
    const { go, snap, step, tab, dialog } = mk(page, theme);
    const aud = { audit: true, focus: A };

    // ---- top-level screens
    await step("runs-list", async () => { await go("/"); await snap("runs-list", aud); });
    await step("runs-list-scrolled", async () => { await page.evaluate(() => { const s = [...document.querySelectorAll("*")].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) ?? document.scrollingElement; s.scrollTop = s.scrollHeight; }); await snap("runs-list-bottom"); });
    await step("runs-row-hover", async () => { await go("/"); await page.locator("a[data-nav-row]").nth(9).hover(); await snap("runs-list-hover-long-name"); });
    // HOW-68: the list's keyboard — J/K move a visible selection, `/` focuses the filter
    await step("runs-list-keyboard", async () => { await go("/"); await page.keyboard.press("j"); await page.keyboard.press("j"); await page.keyboard.press("j"); await snap("runs-list-keyboard-selection"); });
    await step("runs-list-filter", async () => { await go("/"); await page.keyboard.press("/"); await page.keyboard.type("failed"); await snap("runs-list-filtered"); await page.keyboard.press("Control+a"); await page.keyboard.type("zzzz-nothing"); await snap("runs-list-filter-no-match"); });
    await step("runs-list-about", async () => { await go("/"); await page.getByRole("button", { name: /About this home/ }).click(); await snap("runs-list-about-home"); await page.keyboard.press("Escape"); });
    await step("nav-rail", async () => { await go("/"); await page.getByRole("button", { name: /sidebar/i }).first().click(); await snap("runs-list-nav-collapsed"); await page.getByRole("button", { name: /sidebar/i }).first().click(); });
    await step("attention", async () => { await go("/attention"); await snap("attention-inbox", aud); });
    await step("attention-keyboard", async () => { await go("/attention"); await page.keyboard.press("j"); await page.keyboard.press("j"); await snap("attention-inbox-keyboard-selection"); });
    // HOW-68: every primitive in every state — the page the component layer is judged on. The
    // gallery scrolls inside its own pane, so the viewport is grown to hold all of it for the
    // one full shot, then put back for the layered states (which have to be opened to be seen).
    await step("components-gallery", async () => {
      await go("/dev/components");
      const tall = await page.evaluate(() => { const p = document.querySelector('[data-screen="gallery"] [data-slot="scroll-pane"]'); return p ? p.scrollHeight + 80 : 900; });
      await page.setViewportSize({ width: 1440, height: Math.min(Math.max(tall, 900), 12000) });
      await snap("components-gallery", { audit: true, focus: A ? 120 : false });
      await page.setViewportSize({ width: 1440, height: 900 });
      await go("/dev/components");
      await page.locator('[data-gallery^="Tooltip"]').scrollIntoViewIfNeeded();
      await page.locator('[data-gallery^="Tooltip"]').getByRole("button", { name: /^More/ }).click(); await snap("components-gallery-menu");
      await page.keyboard.press("Escape");
      await page.locator('[data-gallery^="Tooltip"]').getByRole("button", { name: "Popover" }).click(); await snap("components-gallery-popover");
      await page.keyboard.press("Escape");
      await page.locator('[data-gallery^="Truncate"]').scrollIntoViewIfNeeded();
      await page.locator('[data-gallery^="Truncate"] [data-truncated]').first().focus(); await snap("components-gallery-truncate-focused");
      await page.keyboard.press("Control+k"); await page.keyboard.type("go"); await snap("components-gallery-palette");
      await page.keyboard.press("Escape");
      await page.locator("main").click({ position: { x: 400, y: 20 } }); await page.keyboard.press("?"); await snap("components-gallery-shortcut-sheet");
      await page.keyboard.press("Escape");
    });
    await step("not-found", async () => { await go("/no/such/screen"); await snap("not-found", aud); });
    await step("new-run", async () => { await go("/new"); await snap("new-run-empty", aud); });
    await step("new-run-ticket", async () => { await go("/new"); await page.locator("main select").first().selectOption("implement-ticket"); await snap("new-run-implement-ticket", { audit: true }); });
    await step("new-run-advanced", async () => { await go("/new"); await page.locator("main select").first().selectOption("implement-ticket"); await page.getByRole("button", { name: "Advanced options" }).click(); await snap("new-run-advanced-options"); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("new-run-advanced-options-bottom"); });
    await step("new-run-draft", async () => { await go("/new"); await page.locator("main select").first().selectOption("draft-graph"); await snap("new-run-draft-graph"); });
    await step("graphs", async () => { await go("/graphs"); await snap("graphs-list", aud); });
    await step("graphs-open", async () => { await go("/graphs"); await page.getByRole("button", { name: "the implement-ticket graph" }).click(); await snap("graphs-implement-ticket-selected", { audit: true, wait: 900 }); });
    await step("graphs-step", async () => { await go("/graphs"); await page.getByRole("button", { name: "the implement-ticket graph" }).click(); await page.waitForTimeout(700); await page.getByRole("button", { name: "implementation.plan", exact: true }).click(); await page.locator("[data-section='This step']").scrollIntoViewIfNeeded(); await snap("graphs-step-selected"); });
    await step("graphs-local", async () => { await go("/graphs"); await page.getByRole("button", { name: "the triage-bug graph" }).click(); await snap("graphs-local-triage-bug-selected", { wait: 900 }); });
    await step("graphs-source", async () => { await go("/graphs"); await page.getByRole("button", { name: "the triage-bug graph" }).click(); await page.waitForTimeout(700); await page.getByRole("button", { name: "Edit the source" }).click(); await page.locator("[data-slot='graph-source']").scrollIntoViewIfNeeded(); await snap("graphs-local-source-editor", { wait: 700 }); });
    await step("graphs-bottom", async () => { await go("/graphs"); await page.getByRole("button", { name: "the triage-bug graph" }).click(); await page.waitForTimeout(700); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("graphs-scrolled-bottom"); });

    // ---- builder
    await step("builder-new", async () => { await go("/graphs/new"); await snap("builder-new", aud); });
    await step("builder-existing", async () => { await go("/graphs/triage-bug/build"); await snap("builder-existing-graph-panel", { audit: true }); });
    await step("builder-step", async () => { await page.getByRole("button", { name: /^Edit triage-bug\.fix/ }).click(); await snap("builder-existing-step-selected", aud); });
    await step("builder-step-bottom", async () => { await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; }); await snap("builder-existing-step-selected-panel-bottom"); });
    await dialog("builder-remove-step", async () => { await page.getByRole("button", { name: /remove|delete/i }).filter({ hasText: /step/i }).first().click(); });
    await step("builder-edge", async () => { await go("/graphs/triage-bug/build"); await page.getByRole("button", { name: /^Route review_verdict/ }).click(); await snap("builder-existing-route-selected"); });
    await step("builder-finish", async () => { await page.getByRole("button", { name: /^Edit cannot-reproduce/ }).click(); await snap("builder-existing-finish-step-selected"); });
    await step("builder-from-run", async () => { await go(`/graphs/new?fromRun=${R.draftReady}`); await snap("builder-from-draft-run"); });
    // HOW-68: a step that blocks the save (its count is red, never amber) and the empty canvas
    await step("builder-problem", async () => { await go("/graphs/new"); await page.getByRole("textbox", { name: /the graph's name/ }).fill("my-review"); await page.getByRole("button", { name: /^Run a command/ }).click(); await snap("builder-new-step-with-a-problem", { audit: true }); });
    await step("builder-empty", async () => { await go("/graphs/new"); for (const t of ["Do the work", "done"]) { await page.getByRole("button", { name: new RegExp(`^Edit ${t}`) }).click(); await page.getByRole("button", { name: "Remove this step" }).click(); if (await page.locator("dialog[open]").count()) await page.getByRole("button", { name: /^Remove the step/ }).click(); } await snap("builder-empty-canvas"); });
    // HOW-68: the whole left-to-right graph in one frame — every wire side-to-side, every caption off the cards
    await step("builder-whole", async () => { await go("/graphs/triage-bug/build"); await page.getByRole("button", { name: "Show the whole graph" }).click(); await snap("builder-existing-whole-graph", { audit: true, wait: 600 }); });
    await step("builder-more", async () => { await go("/graphs/triage-bug/build"); await page.getByRole("button", { name: "More" }).click(); await snap("builder-more-menu"); await page.keyboard.press("Escape"); });

    // ---- prompts / proposals / settings
    await step("prompts", async () => { await go("/prompts"); await snap("prompts-list", aud); });
    await step("prompt-detail", async () => { await go("/prompts/delivery.publish"); await snap("prompts-detail-delivery-publish", { ...aud, wait: 900 }); });
    await step("prompt-detail-bottom", async () => { await go("/prompts/delivery.publish"); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("prompts-detail-scrolled-bottom"); });
    await step("prompt-partial", async () => { await go("/prompts/implementation._plan_first"); await snap("prompts-detail-partial", { wait: 900 }); });
    await step("proposals", async () => { await go("/proposals"); await snap("proposals-list-first-selected", { ...aud, wait: 900 }); });
    await step("proposals-pending", async () => {
      const pending = await page.evaluate(async () => (await (await fetch("/api/proposals")).json()).find((p) => p.status === "pending")?.file ?? null);
      if (!pending) { failures.push("no pending proposal in the copy — reject dialog not captured"); return; }
      await go(`/proposals/${encodeURIComponent(pending)}`); await snap("proposals-pending-selected", { audit: true, wait: 900 });
      await dialog("proposal-reject", async () => { await page.getByRole("button", { name: "Reject", exact: true }).click(); });
    });
    await step("settings", async () => { await go("/settings"); await snap("settings", aud); });
    await step("settings-bottom", async () => { await go("/settings"); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("settings-scrolled-bottom"); });
    await dialog("settings-remove-workspace", async () => { await go("/settings"); await page.getByRole("button", { name: "remove the notes workspace" }).click(); });
    await step("settings-add", async () => { await go("/settings"); await page.getByRole("button", { name: "Register a local path" }).click(); await page.getByRole("button", { name: "Register", exact: true }).scrollIntoViewIfNeeded(); await snap("settings-register-path-form"); });

    // ---- run detail: every tab for the finished and the needs-input run
    for (const [key, id] of [["run-done", R.done], ["run-needs-input-prose", R.prose]]) {
      await step(`${key}-build`, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { ...aud, wait: 900 }); });
      await step(`${key}-build-top`, async () => { await page.getByRole("button", { name: "Scroll to start" }).click(); await snap(`${key}-build-chat-top`); });
      await step(`${key}-build-expanded`, async () => { await page.getByRole("button", { name: /Expand \d+ tool calls/ }).click(); await snap(`${key}-build-chat-tools-expanded`, { audit: key === "run-done" }); });
      await step(`${key}-plan`, async () => { await tab("Plan"); await snap(`${key}-plan`, aud); });
      await step(`${key}-report`, async () => { await tab("Report"); await snap(`${key}-report`, { audit: true, wait: 1500 }); });
      await step(`${key}-steps`, async () => { await tab("Steps"); await snap(`${key}-steps-default`, { audit: true }); });
      await step(`${key}-steps-selected`, async () => {
        await page.getByRole("button", { name: /^implementation\.implement@1/ }).click();
        await snap(`${key}-steps-step-selected-activity`, aud);
        for (const sub of ["Ask", "Prompt & context", "Output"]) { await page.getByRole("tab", { name: sub, exact: true }).click(); await snap(`${key}-steps-step-selected-${sub.toLowerCase().replace(/[^a-z]+/g, "-")}`, { audit: sub !== "Ask", wait: 800 }); }
        await page.getByRole("tab", { name: "Run", exact: true }).click().catch(() => {}); await snap(`${key}-steps-run-scope`);
      });
      await step(`${key}-steps-fullwidth`, async () => { await page.getByRole("tab", { name: "Step", exact: true }).click().catch(() => {}); /* full width exists only while the split is side by side: under 1100px of pane (the Details drawer open at 1440) the detail already replaces the list */ if (await page.getByRole("button", { name: /^Close run details/i }).count()) await page.keyboard.press("Control+i"); await page.getByRole("button", { name: /expand the detail panel/i }).click(); await snap(`${key}-steps-detail-full-width`); await go(`/run/${id}`); });
      await step(`${key}-context`, async () => { await tab("Context"); await snap(`${key}-context`, aud); });
      await step(`${key}-context-selected`, async () => { const row = page.getByRole("button", { name: /^context key implementation_plan/ }).first(); await row.click(); await snap(`${key}-context-key-selected`, { audit: true }); });
      await step(`${key}-logs`, async () => { await tab("Logs"); await snap(`${key}-logs`, aud); });
      await step(`${key}-logs-row`, async () => { await page.locator("main [class*=log] button, main .log-row, main table tr").nth(6).click(); await snap(`${key}-logs-row-selected`); });
      await step(`${key}-graph`, async () => { await tab("Graph"); await snap(`${key}-graph`, { ...aud, wait: 900 }); });
      // HOW-68: the inspector rail is the Details drawer — open by default at 1440, toggled from the header (or ⌘I)
      await step(`${key}-inspector-hidden`, async () => { await go(`/run/${id}`); await page.getByRole("button", { name: "Hide details" }).click(); await snap(`${key}-build-details-closed`, { audit: true }); await page.getByRole("button", { name: "Show details" }).click(); });
      await step(`${key}-inspector-bottom`, async () => { await page.evaluate(() => { const p = document.querySelector('[data-slot="drawer"] [data-slot="scroll-pane"]'); if (p) p.scrollTop = p.scrollHeight; }); await snap(`${key}-details-bottom`); });
    }

    // dialogs + toast on the finished run
    await step("done-dialogs", async () => {
      await go(`/run/${R.done}`);
      await page.getByRole("button", { name: "Scroll to start" }).click().catch(() => {});
    });
    await dialog("document-reader-plan", async () => { await page.getByRole("button", { name: "read implementation_plan" }).first().click(); });
    await dialog("evidence-screenshot", async () => { await page.getByRole("button", { name: "open the screenshot of /sign-in-failed" }).first().click(); });
    await step("toast", async () => { await page.getByRole("button", { name: "More run actions" }).click(); await snap("run-done-more-menu", { wait: 250 }); await page.getByRole("menuitem", { name: /Copy resume command/ }).click(); await snap("run-done-toast-copied", { wait: 250 }); });
    await step("toast-error", async () => { await go(`/run/${R.done}`); await page.keyboard.press("o"); await snap("run-done-toast-open-ide", { wait: 500 }); });
    await step("ask-composer", async () => { await go(`/run/${R.done}`); await page.getByPlaceholder("Ask about this run…").fill("Why did the first probe say CHANGES_REQUIRED?"); await snap("run-done-ask-composer-typed"); });

    // ---- every other run state: the default (Build) pane, plus what is particular to it
    const states = [
      ["run-needs-input-long-id-name", R.long], ["run-needs-input-question", R.question], ["run-needs-input-ambiguous-effect", R.effect],
      ["run-needs-input-max-visits-no-reply", R.maxvisits], ["run-needs-input-harness-unauthenticated", R.unauth], ["run-needs-input-stuck", R.stuck],
      ["run-failed", R.failed], ["run-aborted", R.aborted], ["run-harness-dead", R.dead], ["run-live", R.live], ["run-paused", R.paused],
      ["run-plan-feature-awaiting-approval", R.planAwait], ["run-plan-feature-parent-with-children", R.parent], ["run-child-stacked", R.childStacked],
      ["run-implement-slice-awaiting-approval", R.slice], ["run-draft-graph-ready", R.draftReady], ["run-draft-graph-saved", R.draftSaved], ["run-research-done", R.research],
      // HOW-68: one per park kind and status the seed did not produce before
      ["run-parallel-done", R.parallelDone], ["run-parallel-branch-parked", R.parallelParked], ["run-needs-input-turn-timeout", R.timeout], ["run-needs-input-no-progress", R.noProgress],
      ["run-needs-input-repair-stalled", R.repairStalled], ["run-needs-input-stale-base", R.staleBase], ["run-implement-slice-drift", R.drift], ["run-needs-input-gated-acceptance", R.gated],
      ["run-needs-input-permission", R.permission], ["run-needs-input-mcp-elicitation", R.elicitation], ["run-needs-input-soft-stopped", R.softStopped], ["run-queued", R.queued],
      ["run-failed-recoverable", R.failedRecoverable], ["run-evidence-failed", R.evidenceFailed], ["run-stacked-waiting", R.stackedWaiting], ["run-needs-input-context-exhausted", R.contextExhausted],
    ];
    for (const [key, id] of states) {
      await step(key, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { audit: A, focus: A && /question|effect|live|long/.test(key) ? 40 : false, wait: 900 }); });
      await step(`${key}-top`, async () => { if (await page.locator('[data-slot="message-scroller-button"][data-direction="start"][data-active="true"]').count()) { await page.getByRole("button", { name: "Scroll to start" }).click({ timeout: 1500 }); await snap(`${key}-build-chat-top`); } });
    }
    // particular panes
    await step("long-steps", async () => { await go(`/run/${R.long}`); await tab("Steps"); await snap("run-needs-input-long-id-name-steps", { audit: true }); await tab("Plan"); await snap("run-needs-input-long-id-name-plan"); await tab("Logs"); await snap("run-needs-input-long-id-name-logs"); });
    await step("question-answer", async () => { await go(`/run/${R.question}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-question-card", { audit: true }); });
    await step("effect-card", async () => { await go(`/run/${R.effect}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-ambiguous-effect-card"); });
    await step("prose-card", async () => { await go(`/run/${R.prose}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-prose-card"); });
    await step("live-plan", async () => { await go(`/run/${R.live}`); await tab("Plan"); await snap("run-live-plan"); await tab("Steps"); await snap("run-live-steps"); await tab("Graph"); await snap("run-live-graph", { wait: 900 }); });
    await dialog("run-abort-confirm", async () => { await go(`/run/${R.live}`); await page.getByRole("button", { name: "More run actions" }).click(); await page.getByRole("menuitem", { name: /^Abort/ }).click(); });
    await step("live-controls", async () => { await go(`/run/${R.live}`); await snap("run-live-header-controls", { audit: true }); });
    for (const [key, id] of [["run-plan-feature-awaiting-approval", R.planAwait], ["run-implement-slice-awaiting-approval", R.slice]]) {
      const openApproval = async () => { await go(`/run/${id}`); await tab("Steps"); await page.getByRole("button", { name: /approve@2/ }).first().click(); await page.waitForTimeout(300); };
      await step(`${key}-steps-subtabs`, async () => {
        await openApproval();
        for (const t of ["Approval", "Map", "Drift", "Activity", "Prompt & context", "Output"]) {
          const loc = page.getByRole("tab", { name: t, exact: true });
          if (!(await loc.count())) continue;
          await loc.first().click(); await snap(`${key}-steps-approve-${t.toLowerCase().replace(/[^a-z]+/g, "-")}`, { audit: A && /Approval|Map|Drift/.test(t), wait: 900 });
        }
      });
      await step(`${key}-steps-approval-wide`, async () => { await openApproval(); /* full width exists only while the split is side by side: with the Details drawer open at 1440 the pane is under 1100px and the detail already replaces the list */ if (await page.getByRole("button", { name: /^Close run details/i }).count()) await page.keyboard.press("Control+i"); await page.getByRole("button", { name: /expand the detail panel/i }).click(); await snap(`${key}-steps-approval-full-width`, { audit: A }); await page.evaluate(() => { for (const e of document.querySelectorAll("main *")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.getBoundingClientRect().left < innerWidth * 0.6) e.scrollTop = e.scrollHeight; }); await snap(`${key}-steps-approval-full-width-bottom`); });
      await step(`${key}-steps-approval-pin`, async () => { await openApproval(); await page.getByRole("button", { name: /^pin a comment on/ }).first().click(); await snap(`${key}-steps-approval-pin-comment-open`); });
      await dialog(`${key.replace("run-", "")}-approve-confirm`, async () => { await openApproval(); await page.getByRole("button", { name: "Approve", exact: true }).click(); });
      await dialog(`${key.replace("run-", "")}-send-feedback-confirm`, async () => { await openApproval(); await page.getByRole("button", { name: "Send feedback", exact: true }).click(); });
      await step(`${key}-steps-redesign`, async () => { await openApproval(); await page.getByRole("button", { name: "Redesign", exact: true }).click(); await snap(`${key}-steps-approval-redesign-open`); });
    }
    await step("parent-tabs", async () => { await go(`/run/${R.parent}`); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.getBoundingClientRect().left > innerWidth * 0.6) e.scrollTop = e.scrollHeight; }); await snap("run-plan-feature-parent-with-children-inspector-children"); await tab("Plan"); await snap("run-plan-feature-parent-with-children-plan"); await tab("Steps"); await snap("run-plan-feature-parent-with-children-steps"); await tab("Graph"); await snap("run-plan-feature-parent-with-children-graph", { wait: 900 }); });
    await step("research-context-doc", async () => { await go(`/run/${R.research}`); await tab("Context"); await page.getByRole("button", { name: /^context key report_summary/ }).first().click(); await snap("run-research-done-context-document", { audit: true }); });
    // ---- HOW-68: what is particular to the added states
    await step("parallel-steps", async () => { await go(`/run/${R.parallelDone}`); await tab("Steps"); await snap("run-parallel-done-steps", { audit: true }); await page.getByRole("button", { name: /^review-change\.style@1/ }).click(); await snap("run-parallel-done-steps-branch-selected", { audit: A }); await tab("Graph"); await snap("run-parallel-done-graph", { audit: A, wait: 900 }); await tab("Context"); await snap("run-parallel-done-context"); });
    await step("parallel-parked-steps", async () => { await go(`/run/${R.parallelParked}`); await tab("Steps"); await snap("run-parallel-branch-parked-steps", { audit: A }); await tab("Graph"); await snap("run-parallel-branch-parked-graph", { wait: 900 }); });
    await step("parallel-builder", async () => { await go("/graphs/review-change/build"); await snap("builder-parallel-graph", { audit: A }); await page.getByRole("button", { name: /^Edit review-change\.reviews/ }).click(); await snap("builder-parallel-step-selected"); });
    await step("gated-waive", async () => { await go(`/run/${R.gated}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-gated-acceptance-card", { audit: true }); await page.getByRole("button", { name: /^Waive/ }).first().click(); await snap("run-needs-input-gated-acceptance-waive-open", { audit: A }); });
    await step("gated-plan", async () => { await go(`/run/${R.gated}`); await tab("Plan"); await snap("run-needs-input-gated-acceptance-plan"); });
    await step("drift-pane", async () => { await go(`/run/${R.drift}`); await tab("Steps"); await page.getByRole("button", { name: /^map\.drift@1/ }).click(); await page.getByRole("tab", { name: "Drift", exact: true }).click(); await snap("run-implement-slice-drift-pane", { audit: true, wait: 700 }); for (const t of ["Map", "Approval"]) { const loc = page.getByRole("tab", { name: t, exact: true }); if (await loc.count()) { await loc.first().click(); await snap(`run-implement-slice-drift-${t.toLowerCase()}`, { wait: 700 }); } } });
    await step("stale-base-card", async () => { await go(`/run/${R.staleBase}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-stale-base-card", { audit: true }); await tab("Steps"); await snap("run-needs-input-stale-base-steps"); });
    for (const [key, id] of [["permission", R.permission], ["mcp-elicitation", R.elicitation], ["soft-stopped", R.softStopped], ["turn-timeout", R.timeout], ["no-progress", R.noProgress], ["repair-stalled", R.repairStalled]])
      await step(`${key}-card`, async () => { await go(`/run/${id}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap(`run-needs-input-${key}-card`, { audit: true }); await page.locator("#needs-input details.ask-full > summary").click().catch(() => {}); await snap(`run-needs-input-${key}-card-full-message`); });
    await step("live-steers", async () => { await go(`/run/${R.live}`); await page.locator(".cv-steer").first().scrollIntoViewIfNeeded(); await snap("run-live-steer-delivered", { audit: true }); await page.locator('.cv-steer[data-state="pending"]').first().scrollIntoViewIfNeeded(); await snap("run-live-steer-pending"); await page.getByRole("button", { name: /Steer the agent/ }).click(); await page.getByRole("textbox", { name: "steer the agent" }).fill("Skip the docs for now."); await snap("run-live-steer-composer", { audit: A }); });
    await step("stacked-waiting-steps", async () => { await go(`/run/${R.stackedWaiting}`); await tab("Steps"); await snap("run-stacked-waiting-steps"); await tab("Graph"); await snap("run-stacked-waiting-graph", { wait: 900 }); });
    await step("unverified-prompt", async () => { await go(`/run/${R.unverified}`); await tab("Steps"); await page.getByRole("button", { name: /^quick-task\.work@1/ }).click(); await page.getByRole("tab", { name: "Prompt & context", exact: true }).click(); await snap("run-prompt-unverified", { audit: true, wait: 900 }); });
    await step("evidence-failed", async () => { await go(`/run/${R.evidenceFailed}`); await page.locator(".ev-strip").first().scrollIntoViewIfNeeded(); await snap("run-evidence-failed-strip", { audit: true }); });
    await step("queued-tabs", async () => { await go(`/run/${R.queued}`); for (const t of ["Plan", "Report", "Steps", "Context", "Logs", "Graph"]) { await tab(t); await snap(`run-queued-${t.toLowerCase()}`, { audit: A, wait: 700 }); } });
    await step("failed-recoverable-steps", async () => { await go(`/run/${R.failedRecoverable}`); await tab("Steps"); await snap("run-failed-recoverable-steps"); });
    // a Logs fetch that fails: the route is cut for this one step, so the pane's own error state shows
    await step("logs-error", async () => { await page.route("**/api/runs/*/log*", (r) => r.abort()); try { await go(`/run/${R.done}`); await tab("Logs"); await snap("run-done-logs-fetch-error", { audit: true, wait: 1200 }); } finally { await page.unroute("**/api/runs/*/log*"); } });
    await step("proposal-stale", async () => { await go(`/proposals/${encodeURIComponent("ticket.local_review.v3.proposal.md")}`); await snap("proposals-stale-selected", { audit: true, wait: 900 }); });
    await step("proposal-orphaned", async () => { await go(`/proposals/${encodeURIComponent("ticket.triage.v2.proposal.md")}`); await snap("proposals-orphaned-selected", { audit: true, wait: 900 }); });
    await step("graphs-parallel", async () => { await go("/graphs"); await page.getByRole("button", { name: "the review-change graph" }).click(); await snap("graphs-local-parallel-selected", { wait: 900 }); });
    // ---- HOW-68, the operator's first hands-on feedback (STEPS='feedback-') -------------------
    // The read-only graph is a React Flow canvas over a layered layout: as opened (100%), whole,
    // a step's tooltip (hover), the roving step focused from the keyboard, and after a real drag.
    await step("feedback-graph", async () => {
      await go(`/run/${R.done}`); await tab("Graph"); await page.waitForSelector(".dag-card");
      await snap("feedback-run-graph-opened", { audit: true, wait: 600 });
      const pane = await page.locator(".dag-canvas").boundingBox();
      await page.mouse.move(pane.x + pane.width - 40, pane.y + 60); await page.mouse.down(); await page.mouse.move(pane.x + pane.width - 240, pane.y + 200, { steps: 8 }); await page.mouse.up();
      await snap("feedback-run-graph-panned-by-mouse");
      await page.locator(".dag-card.current").hover(); await snap("feedback-run-graph-step-tooltip", { wait: 600 });
      await page.mouse.move(pane.x + 4, pane.y + 4);
      await page.locator(".dag-card[tabindex='0']").focus(); await page.keyboard.press("Home"); await snap("feedback-run-graph-walked-to-start", { wait: 500 });
      await page.locator(".dag-canvas").focus(); await page.keyboard.press("0"); await snap("feedback-run-graph-whole", { wait: 600 });
    });
    await step("feedback-graph-states", async () => {
      await go(`/run/${R.maxvisits}`); await tab("Graph"); await page.waitForSelector(".dag-card"); await snap("feedback-run-graph-parked-waiting", { wait: 600 });
      await page.locator(".dag-card.clickable").first().focus(); await page.keyboard.press("Enter"); await snap("feedback-run-graph-jump-card");
      await go(`/run/${R.parallelDone}`); await tab("Graph"); await page.waitForSelector(".dag-card"); await snap("feedback-run-graph-parallel", { wait: 600 });
      await go(`/runs/${R.draftReady}/draft`); await page.waitForSelector(".dag-card"); await snap("feedback-draft-review-picture", { audit: true, wait: 600 });
    });
    // every graph in the catalog on the Graphs screen, as opened and whole
    await step("feedback-graphs-all", async () => {
      const names = (await (await page.request.get(BASE + "/api/graphs")).json()).graphs.map((g) => g.name);
      for (const name of names) {
        await go("/graphs"); await page.getByRole("button", { name: `the ${name} graph` }).click(); await page.waitForSelector(".dag-card");
        await snap(`feedback-graphs-${name}`, { wait: 500 });
        await page.getByRole("button", { name: "Show the whole graph" }).click(); await snap(`feedback-graphs-${name}-whole`, { wait: 400 });
      }
    });
    // The plan uses the width its pane has; focus (F) gives the pane the window.
    await step("feedback-plan", async () => {
      await go(`/run/${R.done}`); await tab("Plan"); await snap("feedback-plan", { audit: true });
      await page.setViewportSize({ width: 2000, height: 950 }); await snap("feedback-plan-2000x950", { audit: true });
      await page.keyboard.press("f"); await snap("feedback-plan-2000x950-focus");
      await page.setViewportSize({ width: 1440, height: 900 }); await snap("feedback-plan-focus", { audit: true });
      await tab("Build"); await snap("feedback-build-focus"); await tab("Report"); await snap("feedback-report-focus", { wait: 800 });
      // focus is remembered for the SESSION: leave it, or every later step would be shot focused
      await page.keyboard.press("Escape"); await snap("feedback-report-after-leaving-focus");
    });
    // Details: the pull request first, the poll folded, and the drawer resized by mouse and keys.
    await step("feedback-details", async () => {
      await go(`/run/${R.paused}`); await snap("feedback-details-pr-first-poll-folded", { audit: true });
      await page.locator("[data-fold]").click(); await snap("feedback-details-poll-unfolded");
      const sep = page.locator("[data-slot='drawer-resize']"); const box = await sep.boundingBox();
      await page.mouse.move(box.x + 6, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x - 194, box.y + 300, { steps: 8 }); await page.mouse.up();
      await snap("feedback-details-dragged-wider", { audit: true });
      await sep.focus(); await page.keyboard.press("End"); await snap("feedback-details-narrowest-separator-focused");
      await page.keyboard.press("Home"); await snap("feedback-details-widest");
      await page.keyboard.press("Enter");
      await go(`/run/${R.repairStalled}`); await snap("feedback-details-pr-changes-requested");
    });

    // ---- HOW-68: the empty home (the second viewer). Every screen with nothing in it.
    for (const [name, path] of [["runs-list", "/"], ["attention-inbox", "/attention"], ["new-run", "/new"], ["graphs-list", "/graphs"], ["prompts-list", "/prompts"], ["proposals", "/proposals"], ["settings", "/settings"]])
      await step(`empty-${name}`, async () => { await page.goto(EMPTY + path, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(900); await snap(`empty-home-${name}`, { audit: true, focus: A && name === "runs-list" ? 40 : false }); });
    await step("empty-palette", async () => { await page.goto(EMPTY + "/", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(700); await page.keyboard.press("Control+k"); await snap("empty-home-palette"); await page.keyboard.press("Escape"); });

    await step("unknown-run", async () => { await go("/run/does-not-exist"); await snap("run-unknown-id"); });
    // HOW-68: after the launch grace (10s) the skeleton gives way to a real not-found state
    await step("unknown-run-gone", async () => { await go("/run/does-not-exist"); await page.getByText("No run with this id").waitFor({ timeout: 14000 }); await snap("run-unknown-id-not-found", { audit: A }); });

    // ---- draft review
    await step("draft-review", async () => { await go(`/runs/${R.draftReady}/draft`); await snap("draft-review-ready", { ...aud, wait: 900 }); });
    await step("draft-review-saved", async () => { await go(`/runs/${R.draftSaved}/draft`); await snap("draft-review-saved", { wait: 900 }); });
    await step("draft-review-none", async () => { await go(`/runs/${R.done}/draft`); await snap("draft-review-run-without-draft", { wait: 900 }); });
  });
}

/** HOW-68: the floor of the supported range. A parked run must be answerable here, with the drawer open or shut. */
async function floorPass() {
  await withPage("dark", { width: 1024, height: 640 }, async (page) => {
    const { go, snap, step } = mk(page, "dark", "-1024x640");
    const aud = { audit: true };
    for (const [key, id] of [["run-needs-input-long-id-name", R.long], ["run-needs-input-prose", R.prose], ["run-needs-input-question", R.question], ["run-live", R.live], ["run-plan-feature-awaiting-approval", R.planAwait]]) {
      await step(`${key}-floor`, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { ...aud, wait: 900 }); });
      await step(`${key}-floor-ask`, async () => { await go(`/run/${id}`); if (await page.locator("#needs-input").count()) { await page.keyboard.press("a"); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap(`${key}-ask-in-view`, aud); } });
      await step(`${key}-floor-details`, async () => { await go(`/run/${id}`); await page.getByRole("button", { name: "Show details" }).click(); await snap(`${key}-details-open`, aud); });
    }
  });
}

async function narrowPass() {
  await withPage("dark", { width: 1024, height: 700 }, async (page) => {
    const { go, snap, step, tab } = mk(page, "dark", "-1024x700");
    const aud = { audit: true };
    await step("runs-list", async () => { await go("/"); await snap("runs-list", aud); });
    await step("attention", async () => { await go("/attention"); await snap("attention-inbox", aud); });
    await step("components-gallery", async () => { await go("/dev/components"); await snap("components-gallery", aud); });
    for (const [key, id] of [["run-done", R.done], ["run-needs-input-prose", R.prose], ["run-needs-input-long-id-name", R.long], ["run-needs-input-question", R.question]]) {
      await step(key, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { ...aud, wait: 900 }); });
      for (const t of ["Plan", "Report", "Steps", "Context", "Logs", "Graph"]) await step(`${key}-${t}`, async () => { await tab(t); await snap(`${key}-${t.toLowerCase()}`, { ...aud, wait: 700 }); });
      await step(`${key}-steps-selected`, async () => { await go(`/run/${id}`); await tab("Steps"); await page.getByRole("button", { name: /^(implementation\.(implement|plan)|quick-task\.work)@1/ }).first().click({ force: true }); await snap(`${key}-steps-step-selected`, aud); });
    }
    // the long, hostile transcript with every tool call open, at the width where it has least room: nothing may clip or spill
    await step("run-long-transcript", async () => { await go(`/run/${R.longTranscript}`); await page.locator("main h1").click(); await page.keyboard.press("e"); await snap("run-long-transcript-expanded", { ...aud, wait: 1200 }); await tab("Logs"); await snap("run-long-transcript-logs", { ...aud, wait: 900 }); });
    for (const [key, id] of [["run-parallel-done", R.parallelDone], ["run-needs-input-gated-acceptance", R.gated], ["run-needs-input-stale-base", R.staleBase], ["run-needs-input-permission", R.permission], ["run-needs-input-mcp-elicitation", R.elicitation], ["run-needs-input-repair-stalled", R.repairStalled], ["run-queued", R.queued], ["run-stacked-waiting", R.stackedWaiting]])
      await step(key, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { ...aud, wait: 900 }); if (await page.locator("#needs-input").count()) { await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap(`${key}-ask-in-view`, aud); } });
    await step("parallel-steps", async () => { await go(`/run/${R.parallelDone}`); await tab("Steps"); await snap("run-parallel-done-steps", aud); });
    await step("drift-pane", async () => { await go(`/run/${R.drift}`); await tab("Steps"); await page.getByRole("button", { name: /^map\.drift@1/ }).click(); await page.getByRole("tab", { name: "Drift", exact: true }).click(); await snap("run-implement-slice-drift-pane", { ...aud, wait: 700 }); });
    await step("build-to-step-detail", async () => { await go(`/run/${R.done}`); await page.getByRole("button", { name: /^open implementation\.plan@1 in Steps/ }).first().click(); await page.getByRole("button", { name: /Back to Steps/ }).waitFor({ timeout: 2500 }); await snap("run-done-step-picked-from-build-lands-on-detail", aud); });
    await step("details-to-step-detail", async () => { await go(`/run/${R.done}`); await page.getByRole("button", { name: "Show details" }).click(); await page.getByRole("button", { name: /^open verify\.run@1 in Steps/ }).first().click(); await page.getByRole("button", { name: /Back to Steps/ }).waitFor({ timeout: 2500 }); await snap("run-done-step-picked-from-details-lands-on-detail", aud); });
    await step("builder-ltr", async () => { await go("/graphs/triage-bug/build"); await page.getByRole("button", { name: "Show the whole graph" }).click(); await snap("builder-existing-whole-graph", { ...aud, wait: 600 }); });
    // HOW-68: the floating layers and the empty states at the narrow width
    await step("layers", async () => {
      await go(`/run/${R.live}`);
      await page.getByRole("button", { name: "More run actions" }).click(); await snap("run-live-more-menu", { wait: 250 });
      await page.getByRole("menuitem", { name: /^Abort/ }).click(); await page.waitForSelector("dialog[open]", { timeout: 3000 }); await snap("dialog-run-abort-confirm", aud);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k"); await page.keyboard.type("go"); await snap("command-palette", aud); await page.keyboard.press("Escape");
      await page.locator("main").click({ position: { x: 300, y: 12 } }); await page.keyboard.press("?"); await snap("shortcut-sheet", aud); await page.keyboard.press("Escape");
      await go(`/run/${R.done}`); await page.getByRole("button", { name: "More run actions" }).click(); await page.getByRole("menuitem", { name: /Copy resume command/ }).click(); await snap("run-done-toast-copied", { wait: 250 });
    });
    for (const [name, path] of [["runs-list", "/"], ["attention-inbox", "/attention"], ["proposals", "/proposals"], ["new-run", "/new"]])
      await step(`empty-${name}`, async () => { await page.goto(EMPTY + path, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(900); await snap(`empty-home-${name}`, aud); });
    await step("unknown-run-gone", async () => { await go("/run/does-not-exist"); await page.getByText("No run with this id").waitFor({ timeout: 14000 }); await snap("run-unknown-id-not-found", aud); });
    // HOW-68: below 1100px the panel is a drawer — closed until something is selected, or opened on the graph
    await step("builder", async () => { await go("/graphs/triage-bug/build"); await snap("builder-existing-graph-panel", aud); await page.getByRole("button", { name: "Graph settings" }).click(); await snap("builder-existing-drawer-graph", aud); await page.keyboard.press("Escape"); await page.getByRole("button", { name: /^Edit triage-bug\.fix/ }).click({ force: true }); await snap("builder-existing-step-selected", aud); await page.keyboard.press("Escape"); await page.getByRole("button", { name: /^Name the next step/ }).click(); await snap("builder-palette-strip-name-popover"); });
    await step("graphs", async () => { await go("/graphs"); await page.getByRole("button", { name: "the implement-ticket graph" }).click(); await snap("graphs-implement-ticket-selected", { ...aud, wait: 900 }); });
    await step("settings", async () => { await go("/settings"); await snap("settings", aud); });
    await step("new", async () => { await go("/new"); await page.locator("main select").first().selectOption("implement-ticket"); await snap("new-run-implement-ticket", aud); });
    await step("prompts", async () => { await go("/prompts/delivery.publish"); await snap("prompts-detail-delivery-publish", { ...aud, wait: 900 }); });
    await step("proposals", async () => { await go("/proposals"); await snap("proposals-list-first-selected", { ...aud, wait: 900 }); });
    await step("draft", async () => { await go(`/runs/${R.draftReady}/draft`); await snap("draft-review-ready", { ...aud, wait: 900 }); });
    // HOW-68: below 1100px a split screen shows ONE pane — the list, or the detail with Back
    await step("prompts-list", async () => { await go("/prompts"); await snap("prompts-list", aud); });
    await step("proposals-detail", async () => { await go("/proposals"); await page.locator("a[data-nav-row]").first().click(); await snap("proposals-detail", { ...aud, wait: 900 }); });
    await step("graphs-list", async () => { await go("/graphs"); await snap("graphs-list", aud); });
    // HOW-68 feedback at the narrow width: the plan in one column, the graph, the drawer at half the room
    await step("feedback-narrow", async () => {
      await go(`/run/${R.done}`); await tab("Plan"); await snap("feedback-plan", aud);
      await tab("Graph"); await page.waitForSelector(".dag-card"); await snap("feedback-run-graph-opened", { ...aud, wait: 600 });
      await page.keyboard.press("Control+i").catch(() => {}); await page.waitForTimeout(200);
      if (!(await page.locator("[data-slot='drawer']").count())) await page.getByRole("button", { name: "Show details" }).click();
      await page.locator("[data-slot='drawer-resize']").focus(); await page.keyboard.press("Home"); await snap("feedback-details-widest-is-half-the-room", aud);
      await page.keyboard.press("Enter");
    });
    await step("new-run-advanced", async () => { await go("/new"); await page.locator("main select").first().selectOption("implement-ticket"); await page.getByRole("button", { name: "Advanced options" }).click(); await snap("new-run-advanced-options", aud); });
    await step("settings-bottom", async () => { await go("/settings"); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("settings-scrolled-bottom"); });
  });
}

const t0 = Date.now();
const prog = setInterval(() => console.error(`… ${made.length} shots, ${failures.length} failures, ${Math.round((Date.now() - t0) / 1000)}s`), 30000);
if (!only || only.startsWith("dark")) await fullPass("dark");
if (!only || only.startsWith("light")) await fullPass("light");
clearInterval(prog);
if (!only || only.includes("1024") || only === "narrow") await narrowPass();
if (!only || only.includes("1024x640") || only === "narrow") await floorPass();
await browser.close();

const prior = (f, d) => { try { return JSON.parse(readFileSync(join(OUT, f), "utf8")); } catch { return d; } };
const partial = !!(only || stepRe);
writeFileSync(join(OUT, "audit.json"), JSON.stringify(partial ? { ...prior("audit.json", {}), ...audits } : audits, null, 1));
writeFileSync(join(OUT, "dialogs.json"), JSON.stringify(partial ? [...prior("dialogs.json", []).filter((d) => !dialogs.some((x) => x.name === d.name)), ...dialogs] : dialogs, null, 1));
writeFileSync(join(OUT, partial ? "failures-partial.json" : "failures.json"), JSON.stringify(failures, null, 1));
if (!partial) writeFileSync(join(OUT, "index.txt"), made.join("\n") + "\n");
console.log(`${made.length} screenshots → ${OUT}`);
console.log("dialogs:", JSON.stringify(dialogs.map((d) => [d.name, d.role, d.closesOnEscape])));
console.log(`${failures.length} step failures:`); for (const f of failures) console.log("  " + f);
