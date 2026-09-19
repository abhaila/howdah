/**
 * The slice.propose eval's SCORING, pinned without any agent (the eval itself spends tokens and
 * never runs in `bun test`): ids against a real fixture base, schema pass, comments addressed.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineStatus, changedAt, fixtureCase, scoreComments, scoreIds, scoreRound, totals } from "./slice-propose.eval";
import { extract } from "../../map/extract";
import { assemble } from "../../map/assemble";
import { MapStore } from "../../map/store";
import type { AssembledMap } from "../../map/types";
import { GHOSTS_V1, GHOSTS_V2, COMMENT_V1, DELETE_ROUTE, GET_ROUTE, sliceRepo } from "../../graphs/slice-fixture";

let base: AssembledMap;
beforeAll(async () => {
  const store = new MapStore(mkdtempSync(join(tmpdir(), "howdah-eval-store-")));
  base = assemble((await extract({ repoDir: sliceRepo().dir, store, workers: 0 })).manifest, store);
});

describe("slice.propose eval scoring", () => {
  test("the fixture's v1 and v2 are schema-valid with every id valid", () => {
    for (const g of [GHOSTS_V1, GHOSTS_V2]) {
      const r = scoreRound(g, base);
      expect(r.schemaPass).toBe(true);
      expect(r.ids.valid).toBe(r.ids.total);
    }
  });

  test("ids: an invented existing id and an add of an existing key are invalid; a malformed add is invalid", () => {
    const bad = {
      entities: [
        { id: "com.example.api.<top>.invented(Request)", op: "keep" },
        { id: GET_ROUTE, op: "add" },
        { id: "not a key", op: "add" },
        { id: DELETE_ROUTE, op: "add" },
      ],
    };
    expect(scoreIds(bad, base)).toEqual({ valid: 1, total: 4, invalid: ["com.example.api.<top>.invented(Request)", GET_ROUTE, "not a key"] });
    expect(scoreRound(bad, base).schemaPass).toBe(false);
    expect(scoreIds("not an object", base)).toEqual({ valid: 0, total: 0, invalid: [] });
  });

  test("comments: the fixture comment is addressed by v2's web fetch site, not by an unchanged redraw", () => {
    const [comment] = fixtureCase().comments;
    expect(scoreComments(GHOSTS_V1, GHOSTS_V2, [comment!], base)).toEqual({ addressed: 1, total: 1 });
    expect(scoreComments(GHOSTS_V1, GHOSTS_V1, [comment!], base)).toEqual({ addressed: 0, total: 1 });
    // without a case-specific check: addressed iff the pinned item changed
    expect(changedAt(GHOSTS_V1, GHOSTS_V2, COMMENT_V1.entity_id)).toBe(false);
    expect(changedAt(GHOSTS_V1, { ...GHOSTS_V1, entities: GHOSTS_V1.entities.filter((e) => e.id !== DELETE_ROUTE) }, DELETE_ROUTE)).toBe(true);
  });

  test("totals are percentages over rounds, ids and comments", () => {
    const pass = scoreRound(GHOSTS_V2, base);
    const fail = scoreRound({ entities: [{ id: "x", op: "keep" }] }, base);
    expect(totals([{ name: "a", rounds: [pass, fail], comments: { addressed: 1, total: 2 } }])).toEqual({
      schema_pass_rate: 50,
      ids_valid_pct: Math.round((pass.ids.valid / (pass.ids.total + 1)) * 1000) / 10,
      comments_addressed_pct: 50,
    });
    expect(totals([])).toEqual({ schema_pass_rate: 100, ids_valid_pct: 100, comments_addressed_pct: 100 });
  });

  test("a missing baseline is said out loud, never silent", () => {
    expect(baselineStatus(join(tmpdir(), "howdah-no-baseline-xyz.json"))).toBe("no baseline yet — run with --score-only to record one (it spends tokens)");
  });
});
