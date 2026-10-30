/**
 * HOW-78: the change map is untrusted model output, and the report is a page someone else opens.
 * So: malformed rows drop rather than throw, a link to a box that is not there is never drawn,
 * and no string reaches the page unescaped.
 */
import { describe, expect, test } from "bun:test";
import { asChangeMap, esc, placeComponents, prLabel, renderRunReport, wrap, type RunReportModel } from "./run-report";

const MAP = {
  title: "Xero overpayment applications",
  summary: "Sequence now applies the same amount.",
  components: [
    { id: "xero", label: "Xero webhook", tag: "XERO", group: "xero edge", status: "external", what: "sends INVOICE UPDATE" },
    { id: "recon", label: "Overpayment applications", tag: "RECON", group: "invoices-api", status: "new", how: ["`Reconciler.kt`: writes only the gap"] },
    { id: "ledger", label: "Payment ledger", group: "invoices-api", status: "reused" },
  ],
  links: [{ from: "xero", to: "recon" }, { from: "recon", to: "ledger", dashed: true }, { from: "recon", to: "ghost" }],
  flow: [{ component: "xero", text: "Xero sends INVOICE UPDATE" }, { component: "recon", text: "Compare reported with held" }, "Reconcile the gap"],
  flow_name: "One invoice update",
  diff: { files: 29, additions: 1985, deletions: 35 },
  example: { title: "One 809.50 overpayment", steps: ["Xero: 300.00 applied to invoice A"], outcome: { label: "IN_SYNC", body: "Nothing is written." } },
  risks: ["Concurrent updates rely on the per-overpayment lock."],
};

const model = (over: Partial<RunReportModel> = {}): RunReportModel => ({
  run_id: "implement-ticket-abc", graph: "implement-ticket", status: "done", generated_at: "2026-10-30T12:00:00.000Z",
  change: asChangeMap(MAP), criteria: [], tests: null, screens: null, review: null, pull_requests: [], steps: [], ...over,
});

describe("asChangeMap", () => {
  test("keeps well-formed rows and skips a link to a component that does not exist", () => {
    const m = asChangeMap(MAP)!;
    expect(m.components.map((c) => c.id)).toEqual(["xero", "recon", "ledger"]);
    expect(m.links).toEqual([{ from: "xero", to: "recon" }, { from: "recon", to: "ledger", dashed: true }]);
    expect(m.flow).toEqual([{ component: "xero", text: "Xero sends INVOICE UPDATE" }, { component: "recon", text: "Compare reported with held" }, { text: "Reconcile the gap" }]);
    expect(m.example).toEqual({ title: "One 809.50 overpayment", steps: ["Xero: 300.00 applied to invoice A"], outcome: { label: "IN_SYNC", body: "Nothing is written." } });
    expect(m.diff).toEqual({ files: 29, additions: 1985, deletions: 35 });
  });

  test("parses a JSON string, defaults an unknown status to changed, drops duplicates and junk", () => {
    const m = asChangeMap(JSON.stringify({ title: "t", components: [{ id: "a", status: "weird" }, { id: "a" }, 7, { label: "no id" }] }))!;
    expect(m.components).toEqual([{ id: "a", label: "a", status: "changed", how: [] }]);
  });

  test("null for anything that is not a map at all", () => {
    for (const v of [undefined, null, "not json", 3, [], {}]) expect(asChangeMap(v)).toBeNull();
  });
});

test("a component the flow never visits sinks below the path in its lane", () => {
  const { boxes } = placeComponents(asChangeMap(MAP)!.components, new Set(["xero", "ledger"]));
  const at = Object.fromEntries(boxes.map((b) => [b.c.id, b]));
  expect(at.ledger!.y).toBeLessThan(at.recon!.y);
});

test("a PR url reads as repository / number", () => {
  expect(prLabel("https://github.com/SequenceHQ/sequence-web/pull/92")).toBe("sequence-web / #92");
});

test("placement puts one lane per group, in first-appearance order", () => {
  const { boxes, lanes } = placeComponents(asChangeMap(MAP)!.components);
  expect(lanes.map((l) => l.name)).toEqual(["xero edge", "invoices-api"]);
  const at = Object.fromEntries(boxes.map((b) => [b.c.id, b]));
  expect(at.recon!.x).toBe(at.ledger!.x);
  expect(at.ledger!.y).toBeGreaterThan(at.recon!.y);
  expect(at.xero!.x).toBeLessThan(at.recon!.x);
});

test("a box label wraps on words and clips only what still does not fit", () => {
  expect(wrap("Overpayment applications", 18, 2)).toEqual(["Overpayment", "applications"]);
  expect(wrap("Invoice update processor for the ledger", 18, 2)).toEqual(["Invoice update", "processor for the…"]);
  expect(wrap("Supercalifragilisticexpialidocious", 18, 2)).toEqual(["Supercalifragilis…"]);
});

describe("renderRunReport", () => {
  test("a self-contained page: the change, its map, the path through it and the run's history", () => {
    const html = renderRunReport(model({
      steps: [{ at: "2026-10-27T23:33:00Z", title: "Plan", kind: "step" }, { at: "2026-10-28T00:01:00Z", title: "Your jump · Plan", detail: "handle Elizabeth's comments", kind: "operator" }],
      criteria: [{ id: "ac-1", text: "partial application", state: "pass", note: "tests" }, { id: "ac-2", text: "no second payment path", state: "fail" }],
      pull_requests: [{ url: "https://github.com/o/r/pull/7", state: "OPEN" }],
    }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Xero overpayment applications</title>");
    expect(html).toContain('<svg class="map"');
    expect(html).toContain('class="wire dashed"');
    expect(html).toContain("REUSED AS IS");
    expect(html).toContain("How the run got here");
    expect(html).toContain("27 · 23:33");
    expect(html).toContain("28 · 00:01"); // a new UTC day says so
    expect(html).toContain("1/2 met");
    expect(html).toContain('href="https://github.com/o/r/pull/7"');
    // nothing is fetched: no external script, stylesheet or image
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
  });

  test("the stage: the request path, a What it does / How it's built panel per component, and the trace", () => {
    const html = renderRunReport(model());
    expect(html).toContain("Live topology / One invoice update");
    expect(html).toContain('data-act="play"');
    expect(html).toContain('data-act="step"');
    expect(html).toContain("What it does");
    expect(html).toContain("How it's built");
    expect(html.match(/data-panel="/g)).toHaveLength(3);
    // the first stop on the path is the panel shown without script; the rest wait hidden
    expect(html).toContain('data-panel="xero">');
    expect(html).toContain('data-panel="recon" hidden');
    expect(html).toContain("<code>Reconciler.kt</code>: writes only the gap");
    expect(html).toContain("Supporting systems"); // ledger is off the path
    expect(html).toContain("Worked example");
    expect(html).toContain("IN_SYNC");
    expect(html).toContain("29 files · +1985 −35");
    expect(html).toContain('<script type="application/json" id="report-data">{"flow":["xero","recon",null]}</script>');
  });

  test("the flow data cannot close its script element", () => {
    const html = renderRunReport(model({ change: asChangeMap({ title: "t", components: [{ id: "</script><b>", label: "x" }], flow: [{ component: "</script><b>", text: "go" }] }) }));
    const data = html.slice(html.indexOf('id="report-data">') + 17, html.indexOf("</script>", html.indexOf('id="report-data">')));
    expect(JSON.parse(data)).toEqual({ flow: ["</script><b>"] });
    expect(data).not.toContain("<");
  });

  test("every model string is escaped", () => {
    const evil = `</script><img src=x onerror=alert(1)>`;
    const html = renderRunReport(model({
      change: asChangeMap({ title: evil, components: [{ id: evil, label: evil, status: "new" }], flow: [evil] }),
      steps: [{ at: "2026-10-27T23:33:00Z", title: evil, detail: evil, kind: "step" }],
    }));
    expect(html).not.toContain(evil);
    expect(html).toContain(esc(evil));
  });

  test("without a change map it says so, and falls back to the implementer's summary", () => {
    const html = renderRunReport(model({ change: null, implementation_summary: "Added the reconciler." }));
    expect(html).toContain("No change map yet");
    expect(html).toContain("Map this change");
    expect(html).toContain("Added the reconciler.");
  });
});
