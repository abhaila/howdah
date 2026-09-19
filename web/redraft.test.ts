/**
 * POST /api/proposals/:file/redraft for PARTIALS (system-map 1c-B review). revise.ts refuses a
 * partial without `--evidence-from <includer>`; the reviser runs detached, so that refusal used
 * to be an unseen exit 1 while the screen polled forever. The route now applies revise.ts's own
 * rule before spawning, and spawns with this runtime (process.execPath), not whatever `bun` is
 * on PATH. The spawner is injected: the real reviser spends tokens.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHowdahServer } from "./server";

function repoWithPartial(): string {
  const root = mkdtempSync(join(tmpdir(), "howdah-redraft-"));
  for (const d of ["prompts", "feedback", join("reviser", "proposals")]) mkdirSync(join(root, d), { recursive: true });
  const prompt = (id: string, body: string) => writeFileSync(join(root, "prompts", `${id}.md`), `---\nid: ${id}\nversion: 1\ntags: [doc]\n---\n${body}`);
  prompt("doc._style", "Write plainly.\n");
  prompt("doc.outline", "Outline {{ context.goal }} for {{ context.work }}.\n{{> doc._style }}\n");
  prompt("doc.other", "Something else for {{ context.goal }}.\n");
  return root;
}

function proposal(root: string, id: string): string {
  const file = `${id}.v2.proposal.md`;
  writeFileSync(
    join(root, "reviser", "proposals", file),
    `---\nid: ${id}\nbase_version: 1\nproposed_version: 2\nstatus: pending\ncreated: 2026-09-19T00:00:00Z\n---\nWrite plainly and briefly.\n`,
  );
  return file;
}

describe("redraft route: partials and the spawn", () => {
  const root = repoWithPartial();
  const base = mkdtempSync(join(tmpdir(), "howdah-redraft-home-"));
  const spawned: string[][] = [];
  const server = createHowdahServer({
    runsDir: join(base, "runs"), attentionDir: join(base, "attention"), port: 0, repoRoot: root,
    spawnReviser: (argv) => void spawned.push(argv),
  });
  afterAll(() => server.stop(true));
  const redraft = (file: string, body?: unknown) =>
    fetch(`http://localhost:${server.port}/api/proposals/${file}/redraft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("a partial without an includer is refused up front with the command that works — nothing spawned", async () => {
    spawned.length = 0;
    const res = await redraft(proposal(root, "doc._style"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'doc._style is a partial; re-draft it from an includer: bun reviser/revise.ts doc._style --evidence-from <includer> (or POST {"evidence_from": "<includer>"})',
    );
    expect(spawned).toEqual([]);
  });

  test("a partial with a real includer spawns revise.ts --evidence-from it, on this runtime", async () => {
    spawned.length = 0;
    const res = await redraft(proposal(root, "doc._style"), { evidence_from: "doc.outline" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, drafting: "doc._style", evidence_from: "doc.outline" });
    expect(spawned).toHaveLength(1);
    const [bin, script, ...args] = spawned[0]!;
    expect(bin).toBe(process.execPath);
    expect(script!.endsWith(join("reviser", "revise.ts"))).toBe(true);
    expect(args).toEqual(["doc._style", "--evidence-from", "doc.outline"]);
  });

  test("an includer that does not include the partial, or a malformed id, is refused — nothing spawned", async () => {
    spawned.length = 0;
    const file = proposal(root, "doc._style");
    const wrong = await redraft(file, { evidence_from: "doc.other" });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { error: string }).error).toBe("--evidence-from doc.other does not include doc._style, so its feedback says nothing about it");
    expect((await redraft(file, { evidence_from: "../../etc/passwd" })).status).toBe(400);
    expect((await redraft(file, { evidence_from: 7 })).status).toBe(400);
    expect(spawned).toEqual([]);
  });

  test("a normal prompt spawns without --evidence-from, and refuses one", async () => {
    spawned.length = 0;
    const file = proposal(root, "doc.outline");
    expect((await redraft(file)).status).toBe(202);
    expect(spawned[0]!.slice(2)).toEqual(["doc.outline"]);
    expect(spawned[0]![0]).toBe(process.execPath);
    const res = await redraft(file, { evidence_from: "doc.other" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("only for partials");
    expect(spawned).toHaveLength(1);
  });
});
