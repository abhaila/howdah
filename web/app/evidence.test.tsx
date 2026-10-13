/**
 * HOW-52 — the Evidence strip: thumbnails per step that open into a lightbox with the URL, the
 * capture time and the console errors; a failed or not-checked capture says why.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveDetail } from "../derive";
import { FakeLog } from "../slice.fixtures";
import { conversation } from "./run/chat";
import { EvidenceStrip } from "./run/evidence";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  document.querySelectorAll("dialog").forEach((d) => d.remove());
  root = host = null;
});

const ITEM = (path: string, i: number, errors: string[] = []) => ({
  path, url: `http://127.0.0.1:5555${path}`, file: `evidence/implementation.evidence@1/0${i + 1}-x.png`, abs_path: `/runs/r/evidence/x${i}.png`,
  captured_at: "2026-10-12T10:00:00.000Z", console_errors: errors.length, console_sample: errors,
});

function withEvidence(result: unknown): FakeLog {
  const log = new FakeLog();
  log.add({ type: "run-started", graph: "implement-ticket", inputs: {}, pinned_prompts: {} });
  log.add({ type: "node-started", node: "implementation.evidence", visit: 1, attempt_id: "e#1" });
  log.add({ type: "node-finished", node: "implementation.evidence", visit: 1, status: "succeeded", writes: { "evidence.items": result } });
  return log;
}

function render(log: FakeLog): HTMLElement {
  const detail = deriveDetail("r1", log.events);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<EvidenceStrip runId="r1" entry={detail.evidence[0]!} />));
  return host;
}

describe("the Evidence strip", () => {
  test("renders a thumbnail per screen, served by the guarded file route, with its console-error count", () => {
    const el = render(withEvidence({ outcome: "captured", items: [ITEM("/", 0), ITEM("/run/x", 1, ["the panel threw"])], console_file: "evidence/implementation.evidence@1/console.txt" }));
    const imgs = [...el.querySelectorAll(".ev-thumb img")] as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "/api/runs/r1/file/evidence/implementation.evidence%401/01-x.png",
      "/api/runs/r1/file/evidence/implementation.evidence%401/02-x.png",
    ]);
    expect([...el.querySelectorAll(".ev-thumb-path")].map((p) => p.textContent)).toEqual(["/", "/run/x"]);
    expect(el.querySelectorAll(".ev-thumb-errors")).toHaveLength(1);
  });

  test("the lightbox shows the URL, the capture time and the console errors", () => {
    const el = render(withEvidence({ outcome: "captured", items: [ITEM("/run/x", 0, ["the panel threw", "and again"])], console_file: "evidence/implementation.evidence@1/console.txt" }));
    act(() => (el.querySelector(".ev-thumb") as HTMLButtonElement).click());
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("http://127.0.0.1:5555/run/x");
    expect(dialog.textContent).toContain(new Date("2026-10-12T10:00:00.000Z").toLocaleString());
    expect(dialog.querySelector(".ev-console")!.textContent).toBe("the panel threw\nand again");
    expect(dialog.querySelector("a")!.getAttribute("href")).toContain("console.txt");
  });

  test("not-checked and failed say why, and draw no thumbnails", () => {
    const el = render(withEvidence({ outcome: "not-checked", items: [], reason: "no preview is configured for the workspace" }));
    expect(el.querySelector(".ev-strip")!.getAttribute("data-outcome")).toBe("not-checked");
    expect(el.querySelector(".ev-reason")!.textContent).toContain("no preview is configured");
    expect(el.querySelector(".ev-thumb")).toBeNull();
  });

  test("a file outside the run's evidence folder never reaches the page", () => {
    const detail = deriveDetail("r1", withEvidence({ outcome: "captured", items: [{ ...ITEM("/", 0), file: "../../etc/passwd" }, ITEM("/ok", 1)] }).events);
    expect(detail.evidence[0]!.result.items.map((i) => i.path)).toEqual(["/ok"]);
  });

  test("the transcript draws the strip where the evidence step closes", () => {
    const msgs = conversation(deriveDetail("r1", withEvidence({ outcome: "captured", items: [ITEM("/", 0)] }).events));
    expect(msgs.map((m) => m.kind)).toEqual(["step", "wrote", "evidence"]);
  });
});
