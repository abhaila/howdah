# Coder session — Sprint 0 foundations

Plan: docs/designs/system-map.md → "Sprint 0" (0.1–0.5) and Implementation Tasks T1–T5.
Branch: feat/sprint-0-foundations (from main @ db153b4).
Baseline: `bun test` 239 pass / 0 fail; `bun node_modules/typescript/lib/tsc.js --noEmit` clean.

Plan docs (docs/, TODOS.md) are NOT committed — user's git-commit rule excludes plan .md files.
Checkboxes are ticked locally only.

## Order
1. T1 (0.4 security guard, web/) ∥ T2 (0.5 locked append, log/) — no file overlap
2. T3 (0.1 hashed suffixes)
3. T5 (0.3 loop bounds + budget floors)
4. T4 (0.2 park codes + reply rendering)

## Decisions
- T1: the Host check applies to every request (including GET/SSE), not only writes — DNS
  rebinding can read run logs containing proprietary code. Origin + JSON content-type checks
  apply to writes. Small, same-issue extension of eng-review 1A.
- T2: tail seq read from the last bytes of the file under the lock (not a full readLog per
  append — chunk streaming makes full reads O(n²)).

## Progress
- [x] T1 — a949341 (review PASS; added guard unit tests + one cleanup helper)
- [x] T2 — committed (review PASS; +owner-checked release, +racing-breakers test). FOLLOW-UP for T4: reply paths (web/server.ts ~403, cli/main.ts ~277) must use appendIf
- [x] T3 — db2545f (review PASS; split from T5 by hunk, verified alone in a worktree: 289 pass). NOTE for T4: reply wording must be a versioned builder in core/template.ts (fill assemblePrompt's replySuffix slot via SuffixBuilders + bump SUFFIX_VERSION), and reconstructRender needs reply candidates.
- [x] T5 — committed (review FAIL→fixed: derive closes asks on operator-jump; +crash-after-jump and viewer tests). T4 should tighten maxVisits test assertions to check park `code`.
- [x] T4 — 5eab470 (review FAIL×2 → fixed: crash-safe notes incl. repeated crashes, maxVisits-stranded replies refused, one rendersReply predicate, resume/reply race via appendIf, 400 on bad bodies; AskCard shows refusals)

## Problems / lessons
- Parallel agents T3+T5 both edited engine/run.ts, log/events.ts → commit split by hunk with a script + worktree verification. My first split script dropped the shared header hunk (keyword filter too greedy); caught by the worktree tsc run.

## Sprint 0 COMPLETE — a949341, e1dedb4, db2545f, 96c7355, 5eab470

## Slice 1
- [x] 1b extractor — 00c310f (7 review rounds; cross-project resolution cut to SCIP; U1–U16; 208 map tests)
- [x] 1a engine approval — committed (5 review rounds: fingerprint streaming, single-runner identity lock, PID-reuse recovery, proven-only abort). Follow-up: when holder is genuine-but-unproven, abort seals the log while the runner may still be mid-node — consider control-file only + seal once holder gone.
- [x] 1c — 3036659 (map core: ghosts/drift/neighbourhood) + b6529d0 (engine wiring, implement-slice, includes, metrics, eval)
- [x] 1d render — 1acadce

## Decision (orchestrator, 1b round 6): cut cross-project resolution from slice 1
Six review rounds each found one more Kotlin/Gradle resolution feature that produced a false root
(imports, aliases, nested classifiers, project visibility, dependency configs, transitive deps).
Rather than model Gradle precisely, slice 1's syntactic tier resolves a routes owner ONLY when the
unique candidate is in the site's own Gradle project; anything cross-project → unknown ({*}) with a
reason. Exact cross-module resolution is SCIP's (slice 2). Cost: recall in multi-module apps.

## SPRINT 0 + SLICE 1 COMPLETE (branch feat/sprint-0-foundations, not pushed)
a949341 e1dedb4 db2545f 96c7355 5eab470 | 00c310f c506e2b 3036659 b6529d0 1acadce | 47775f5 (NUL) 57d2fa8 (CLAUDE.md)
Final: 968 tests pass, `bun run check` green (node 25).
Open follow-ups: record slice.propose eval baseline (spends tokens); abort seals log while a genuine-but-unproven runner may be mid-node; /plan-design-review on the approval card + drift view; TODOS.md (resolve-effect verb P2, map object-store GC P3).
