#!/usr/bin/env node
/**
 * HOW-68 baseline screenshots + audits.
 *
 *   node shoot.mjs                 # everything
 *   node shoot.mjs dark-run-done   # only shots whose name contains the argument
 *
 * Needs the viewer on :4799 over <scratch>/home (see README.md). Writes shots/*.png,
 * shots/audit.json (per-screen measurements) and shots/dialogs.json (Escape behaviour).
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
const BASE = process.env.HOWDAH_BASE ?? "http://localhost:4799";
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
};

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
    if (!vis(e)) continue;
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
    if (!vis(e) || e.children.length) continue;
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
    if (!inView(e)) continue;
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
      const row = (contrast[key] ??= { ratio: Math.round(ratio * 100) / 100, need, count: 0, sizes: [], samples: [] });
      row.count++; if (!row.sizes.includes(s.fontSize)) row.sizes.push(s.fontSize);
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
    await step("runs-row-hover", async () => { await go("/"); await page.locator("a.run-row").nth(9).hover(); await snap("runs-list-hover-long-name"); });
    await step("nav-rail", async () => { await go("/"); await page.getByRole("button", { name: /sidebar/i }).first().click(); await snap("runs-list-nav-collapsed"); await page.getByRole("button", { name: /sidebar/i }).first().click(); });
    await step("attention", async () => { await go("/attention"); await snap("attention-inbox", aud); });
    await step("new-run", async () => { await go("/new"); await snap("new-run-empty", aud); });
    await step("new-run-ticket", async () => { await page.locator("main select").first().selectOption("implement-ticket"); await snap("new-run-implement-ticket", { audit: true }); });
    await step("new-run-draft", async () => { await page.locator("main select").first().selectOption("draft-graph"); await snap("new-run-draft-graph"); });
    await step("graphs", async () => { await go("/graphs"); await snap("graphs-list", aud); });
    await step("graphs-open", async () => { await page.getByRole("button", { name: "the implement-ticket graph" }).click(); await snap("graphs-implement-ticket-selected", { audit: true, wait: 900 }); });
    await step("graphs-local", async () => { await page.getByRole("button", { name: "the triage-bug graph" }).click(); await snap("graphs-local-triage-bug-selected", { wait: 900 }); });
    await step("graphs-bottom", async () => { await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("graphs-scrolled-bottom"); });

    // ---- builder
    await step("builder-new", async () => { await go("/graphs/new"); await snap("builder-new", aud); });
    await step("builder-existing", async () => { await go("/graphs/triage-bug/build"); await snap("builder-existing-graph-panel", { audit: true }); });
    await step("builder-step", async () => { await page.getByRole("button", { name: /^Edit triage-bug\.fix/ }).click(); await snap("builder-existing-step-selected", aud); });
    await step("builder-step-bottom", async () => { await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; }); await snap("builder-existing-step-selected-panel-bottom"); });
    await dialog("builder-remove-step", async () => { await page.getByRole("button", { name: /remove|delete/i }).filter({ hasText: /step/i }).first().click(); });
    await step("builder-edge", async () => { await go("/graphs/triage-bug/build"); await page.getByRole("button", { name: /^Route review_verdict/ }).click(); await snap("builder-existing-route-selected"); });
    await step("builder-finish", async () => { await page.getByRole("button", { name: /^Edit cannot-reproduce/ }).click(); await snap("builder-existing-finish-step-selected"); });
    await step("builder-from-run", async () => { await go(`/graphs/new?fromRun=${R.draftReady}`); await snap("builder-from-draft-run"); });

    // ---- prompts / proposals / settings
    await step("prompts", async () => { await go("/prompts"); await snap("prompts-list", aud); });
    await step("prompt-detail", async () => { await go("/prompts/delivery.publish"); await snap("prompts-detail-delivery-publish", { ...aud, wait: 900 }); });
    await step("prompt-detail-bottom", async () => { await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("prompts-detail-scrolled-bottom"); });
    await step("prompt-partial", async () => { await go("/prompts/implementation._plan_first"); await snap("prompts-detail-partial", { wait: 900 }); });
    await step("proposals", async () => { await go("/proposals"); await snap("proposals-list-first-selected", { ...aud, wait: 900 }); });
    await step("proposals-pending", async () => {
      const pending = await page.evaluate(async () => (await (await fetch("/api/proposals")).json()).find((p) => p.status === "pending")?.file ?? null);
      if (!pending) { failures.push("no pending proposal in the copy — reject dialog not captured"); return; }
      await go(`/proposals/${encodeURIComponent(pending)}`); await snap("proposals-pending-selected", { audit: true, wait: 900 });
      await dialog("proposal-reject", async () => { await page.getByRole("button", { name: "Reject", exact: true }).click(); });
    });
    await step("settings", async () => { await go("/settings"); await snap("settings", aud); });
    await step("settings-bottom", async () => { await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }); await snap("settings-scrolled-bottom"); });
    await dialog("settings-remove-workspace", async () => { await page.getByRole("button", { name: "remove the notes workspace" }).click(); });
    await step("settings-add", async () => { await page.getByRole("button", { name: "register a local path" }).click(); await snap("settings-register-path-form"); });

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
        await page.getByRole("button", { name: "Run", exact: true }).click().catch(() => {}); await snap(`${key}-steps-run-scope`);
      });
      await step(`${key}-steps-fullwidth`, async () => { await page.getByRole("button", { name: "Step", exact: true }).click().catch(() => {}); await page.getByRole("button", { name: /expand the detail panel/i }).click(); await snap(`${key}-steps-detail-full-width`); await go(`/run/${id}`); });
      await step(`${key}-context`, async () => { await tab("Context"); await snap(`${key}-context`, aud); });
      await step(`${key}-context-selected`, async () => { const row = page.locator("main").getByText("implementation_plan", { exact: true }).first(); await row.click(); await snap(`${key}-context-key-selected`, { audit: true }); });
      await step(`${key}-logs`, async () => { await tab("Logs"); await snap(`${key}-logs`, aud); });
      await step(`${key}-logs-row`, async () => { await page.locator("main [class*=log] button, main .log-row, main table tr").nth(6).click(); await snap(`${key}-logs-row-selected`); });
      await step(`${key}-graph`, async () => { await tab("Graph"); await snap(`${key}-graph`, { ...aud, wait: 900 }); });
      await step(`${key}-inspector-hidden`, async () => { await go(`/run/${id}`); await page.getByRole("button", { name: "Hide the inspector" }).focus(); await page.keyboard.press("Enter"); await snap(`${key}-build-inspector-hidden`, { audit: true }); await go(`/run/${id}`); });
      await step(`${key}-inspector-bottom`, async () => { await page.evaluate(() => { const a = document.querySelector("aside, .inspector, [class*=inspector]"); for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.getBoundingClientRect().left > innerWidth * 0.6) e.scrollTop = e.scrollHeight; }); await snap(`${key}-inspector-scrolled-bottom`); });
    }

    // dialogs + toast on the finished run
    await step("done-dialogs", async () => {
      await go(`/run/${R.done}`);
      await page.getByRole("button", { name: "Scroll to start" }).click().catch(() => {});
    });
    await dialog("document-reader-plan", async () => { await page.getByRole("button", { name: "read implementation_plan" }).first().click(); });
    await dialog("evidence-screenshot", async () => { await page.getByRole("button", { name: "open the screenshot of /sign-in-failed" }).first().click(); });
    await step("toast", async () => { await page.getByRole("button", { name: "Copy resume" }).click(); await snap("run-done-toast-copied", { wait: 250 }); });
    await step("toast-error", async () => { await go(`/run/${R.done}`); await page.getByRole("button", { name: "Open in IDE" }).click(); await snap("run-done-toast-open-ide", { wait: 500 }); });
    await step("ask-composer", async () => { await go(`/run/${R.done}`); await page.getByPlaceholder("Ask about this run…").fill("Why did the first probe say CHANGES_REQUIRED?"); await snap("run-done-ask-composer-typed"); });

    // ---- every other run state: the default (Build) pane, plus what is particular to it
    const states = [
      ["run-needs-input-long-id-name", R.long], ["run-needs-input-question", R.question], ["run-needs-input-ambiguous-effect", R.effect],
      ["run-needs-input-max-visits-no-reply", R.maxvisits], ["run-needs-input-harness-unauthenticated", R.unauth], ["run-needs-input-stuck", R.stuck],
      ["run-failed", R.failed], ["run-aborted", R.aborted], ["run-harness-dead", R.dead], ["run-live", R.live], ["run-paused", R.paused],
      ["run-plan-feature-awaiting-approval", R.planAwait], ["run-plan-feature-parent-with-children", R.parent], ["run-child-stacked", R.childStacked],
      ["run-implement-slice-awaiting-approval", R.slice], ["run-draft-graph-ready", R.draftReady], ["run-draft-graph-saved", R.draftSaved], ["run-research-done", R.research],
    ];
    for (const [key, id] of states) {
      await step(key, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { audit: A, focus: A && /question|effect|live|long/.test(key) ? 40 : false, wait: 900 }); });
      await step(`${key}-top`, async () => { if (await page.getByRole("button", { name: "Scroll to start" }).count()) { await page.getByRole("button", { name: "Scroll to start" }).click({ timeout: 1500 }); await snap(`${key}-build-chat-top`); } });
    }
    // particular panes
    await step("long-steps", async () => { await go(`/run/${R.long}`); await tab("Steps"); await snap("run-needs-input-long-id-name-steps", { audit: true }); await tab("Plan"); await snap("run-needs-input-long-id-name-plan"); await tab("Logs"); await snap("run-needs-input-long-id-name-logs"); });
    await step("question-answer", async () => { await go(`/run/${R.question}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-question-card", { audit: true }); });
    await step("effect-card", async () => { await go(`/run/${R.effect}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-ambiguous-effect-card"); });
    await step("prose-card", async () => { await go(`/run/${R.prose}`); await page.locator("#needs-input").scrollIntoViewIfNeeded(); await snap("run-needs-input-prose-card"); });
    await step("live-plan", async () => { await go(`/run/${R.live}`); await tab("Plan"); await snap("run-live-plan"); await tab("Steps"); await snap("run-live-steps"); await tab("Graph"); await snap("run-live-graph", { wait: 900 }); });
    await dialog("run-abort-confirm", async () => { await go(`/run/${R.live}`); await page.getByRole("button", { name: /^abort/i }).first().click(); });
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
      await step(`${key}-steps-approval-wide`, async () => { await openApproval(); await page.getByRole("button", { name: /expand the detail panel/i }).click(); await snap(`${key}-steps-approval-full-width`, { audit: A }); await page.evaluate(() => { for (const e of document.querySelectorAll("main *")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.getBoundingClientRect().left < innerWidth * 0.6) e.scrollTop = e.scrollHeight; }); await snap(`${key}-steps-approval-full-width-bottom`); });
      await step(`${key}-steps-approval-pin`, async () => { await openApproval(); await page.getByRole("button", { name: /^pin a comment on/ }).first().click(); await snap(`${key}-steps-approval-pin-comment-open`); });
      await dialog(`${key.replace("run-", "")}-approve-confirm`, async () => { await openApproval(); await page.getByRole("button", { name: "Approve", exact: true }).click(); });
      await dialog(`${key.replace("run-", "")}-send-feedback-confirm`, async () => { await openApproval(); await page.getByRole("button", { name: "Send feedback", exact: true }).click(); });
      await step(`${key}-steps-redesign`, async () => { await openApproval(); await page.getByRole("button", { name: "Redesign", exact: true }).click(); await snap(`${key}-steps-approval-redesign-open`); });
    }
    await step("parent-tabs", async () => { await go(`/run/${R.parent}`); await page.evaluate(() => { for (const e of document.querySelectorAll("*")) if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4 && e.getBoundingClientRect().left > innerWidth * 0.6) e.scrollTop = e.scrollHeight; }); await snap("run-plan-feature-parent-with-children-inspector-children"); await tab("Plan"); await snap("run-plan-feature-parent-with-children-plan"); await tab("Steps"); await snap("run-plan-feature-parent-with-children-steps"); await tab("Graph"); await snap("run-plan-feature-parent-with-children-graph", { wait: 900 }); });
    await step("research-context-doc", async () => { await go(`/run/${R.research}`); await tab("Context"); await page.locator("main").getByText("report_summary", { exact: true }).first().click(); await snap("run-research-done-context-document", { audit: true }); });
    await step("unknown-run", async () => { await go("/run/does-not-exist"); await snap("run-unknown-id"); });

    // ---- draft review
    await step("draft-review", async () => { await go(`/runs/${R.draftReady}/draft`); await snap("draft-review-ready", { ...aud, wait: 900 }); });
    await step("draft-review-saved", async () => { await go(`/runs/${R.draftSaved}/draft`); await snap("draft-review-saved", { wait: 900 }); });
    await step("draft-review-none", async () => { await go(`/runs/${R.done}/draft`); await snap("draft-review-run-without-draft", { wait: 900 }); });
  });
}

async function narrowPass() {
  await withPage("dark", { width: 1024, height: 700 }, async (page) => {
    const { go, snap, step, tab } = mk(page, "dark", "-1024x700");
    const aud = { audit: true };
    await step("runs-list", async () => { await go("/"); await snap("runs-list", aud); });
    await step("attention", async () => { await go("/attention"); await snap("attention-inbox", aud); });
    for (const [key, id] of [["run-done", R.done], ["run-needs-input-prose", R.prose], ["run-needs-input-long-id-name", R.long], ["run-needs-input-question", R.question]]) {
      await step(key, async () => { await go(`/run/${id}`); await snap(`${key}-build-chat`, { ...aud, wait: 900 }); });
      for (const t of ["Plan", "Report", "Steps", "Context", "Logs", "Graph"]) await step(`${key}-${t}`, async () => { await tab(t); await snap(`${key}-${t.toLowerCase()}`, { ...aud, wait: 700 }); });
      await step(`${key}-steps-selected`, async () => { await go(`/run/${id}`); await tab("Steps"); await page.getByRole("button", { name: /^(implementation\.(implement|plan)|quick-task\.work)@1/ }).first().click({ force: true }); await snap(`${key}-steps-step-selected`, aud); });
    }
    await step("builder", async () => { await go("/graphs/triage-bug/build"); await snap("builder-existing-graph-panel", aud); await page.getByRole("button", { name: /^Edit triage-bug\.fix/ }).click({ force: true }); await snap("builder-existing-step-selected", aud); });
    await step("graphs", async () => { await go("/graphs"); await page.getByRole("button", { name: "the implement-ticket graph" }).click(); await snap("graphs-implement-ticket-selected", { ...aud, wait: 900 }); });
    await step("settings", async () => { await go("/settings"); await snap("settings", aud); });
    await step("new", async () => { await go("/new"); await page.locator("main select").first().selectOption("implement-ticket"); await snap("new-run-implement-ticket", aud); });
    await step("prompts", async () => { await go("/prompts/delivery.publish"); await snap("prompts-detail-delivery-publish", { ...aud, wait: 900 }); });
    await step("proposals", async () => { await go("/proposals"); await snap("proposals-list-first-selected", { ...aud, wait: 900 }); });
    await step("draft", async () => { await go(`/runs/${R.draftReady}/draft`); await snap("draft-review-ready", { ...aud, wait: 900 }); });
  });
}

const t0 = Date.now();
const prog = setInterval(() => console.error(`… ${made.length} shots, ${failures.length} failures, ${Math.round((Date.now() - t0) / 1000)}s`), 30000);
if (!only || only.startsWith("dark")) await fullPass("dark");
if (!only || only.startsWith("light")) await fullPass("light");
clearInterval(prog);
if (!only || only.includes("1024") || only === "narrow") await narrowPass();
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
