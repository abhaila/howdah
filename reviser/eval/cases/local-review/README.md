# local-review A/B case set (HOW-53)

The implement-ticket set scores a BUILDER. This set scores a REVIEWER: each case is a small
ticket, a builder commit with planted defects, and a builder summary that falsely claims the
change is tested, complete and verified. The prompt under test is `ticket.local_review`. A
variant passes a case when it returns the right verdict AND, on a defective case, its findings
name every planted defect.

The graph (`_shared/graph.ts.tmpl`, installed into the isolated `$HOWDAH_HOME` as the local
graph `eval-review`) is implement-ticket's review half:

    create_worktree → implementation.criteria → verify.run → implementation.evidence → implementation.local_review → done

- **No builder runs.** `ab.ts` commits `_shared/repo` on `main`, then commits the case's
  `change/` directory on top of it on the branch `ticket` and leaves that branch checked out
  (`repo.branch` in case.json). The repo has no `origin`, so the worktree branches from HEAD,
  and the reviewer's diff against `main` is exactly the planted commit.
- **The plan and the builder's summary are run inputs** (`implementation_plan`,
  `implementation_summary`), so the review is the only step the variants change.
- **The criteria step is the stock `ticket.acceptance`, in both arms.** Only a read-only agent
  may write `acceptance` (core/graph.ts), so a case cannot seed it. This costs one agent turn
  per run. It is the same prompt in both arms, and the runs are interleaved, so its noise lands
  on both arms evenly.
- **`verify.run` reports `pass` on every case.** Each defect is invisible to the repo's own
  `bun test`: the builder's tests are too weak, they pin the wrong behaviour, or (case 06) the
  failing test is skipped. A reviewer that only repeats the test result misses every defect.
  `ab.test.ts` enforces this.
- **The review always routes to `done`.** A reject does not go round a repair loop, and nothing
  publishes: an eval must never open a pull request, and the run has to finish to be scored.

```bash
# dry run, no tokens (every agent node parks)
HOWDAH_STUB=1 bun reviser/eval/ab.ts --cases reviser/eval/cases/local-review \
  --a prompts/ticket.local_review.md --b reviser/proposals/<id>.vN.proposal.md

# the real thing — spends tokens (two agent turns per run: criteria + review)
bun reviser/eval/ab.ts --cases reviser/eval/cases/local-review \
  --a prompts/ticket.local_review.md --b reviser/proposals/<id>.vN.proposal.md \
  --stamp reviser/proposals/<id>.vN.proposal.md
```

## The matching rule (`judgeReview` in `reviser/eval/ab.ts`)

It is deterministic. No LLM judges it.

1. The review is the LAST `node-finished` of `implementation.local_review` that succeeded and
   wrote `review_verdict`. If there is none, the case fails ("the review never finished").
2. `review_verdict` must equal the oracle's `expect`. If it does not, the case fails.
3. `expect: "pass"` (a clean control) is decided by the verdict alone. Findings are ignored,
   because a passing review may carry non-blocking notes.
4. `expect: "reject"`: each element of `review_findings` becomes one text. A string is used as
   it is; anything else is `JSON.stringify`'d; a non-array value is a single text. A defect is
   **named** when ONE finding's text matches EVERY regex in its `match` list. Each regex is
   compiled case-insensitive. Terms spread across different findings do not name a defect. The
   case passes only when every planted defect is named.

Extra findings on a defective case are not penalised. The **clean controls** (07, 08) are what
penalise a reviewer that rejects everything: it would score 6/8, never 8/8. Case 08 is
deliberately a little unusual (code-point destructuring) but correct, so a reviewer that
rejects whatever looks odd also loses it.

`loadCases` refuses a review oracle that cannot judge what it claims: an `expect` other than
pass or reject, a reject case with no defects, a pass case that lists defects, a defect id
listed twice, or a regex that does not compile.

| case | planted defect(s) | `match` (one finding must satisfy every term) |
|---|---|---|
| 01-paginate-off-by-one | 1-based pages computed as `page*size`; page 1 skips the first page | `page\|offset` · `off.by.one\|first page\|second page\|skip\|0-based\|page - 1\|…` |
| 02-slugify-missing-trim | leading/trailing hyphens never stripped | `leading\|trailing\|ends? with\|strip\|trim\|…` · `hyphen\|dash\|` a quoted `-` |
| 03-escape-html-ampersand | `&` not escaped (security) | `ampersand\|&amp;\|` a quoted `&` |
| 04-scope-creep | `truncate` changed (and its test rewritten) outside the ticket | `truncate` · `scope\|unrelated\|outside\|not asked\|…\|changed` |
| 05-median-two-defects | (a) input not sorted; (b) even length returns the upper middle | (a) `sort` · a negation (b) `even` · `average\|mean\|two middle\|…` · a negation |
| 06-skipped-test | the fix is incomplete and its failing test is `test.skip` | `skip\|disabled\|removed\|not run` |
| 07-clean-clamp | none: expect `pass` | |
| 08-clean-capitalize | none: expect `pass` | |

"A negation" is `\bnot\b|never|n't|missing|lacks|assum|forg[eo]t|instead|wrong|incorrect|fails|upper|only one`.
Case 05 needs it because its summary itself says "unsorted input" and "averages … even-length
lists". `case.json` is the authority for every regex. `ab.test.ts` pins the rule from both
sides:

- each case's own summary, pasted back as the only finding, does NOT name its defects (a
  reviewer that echoes the builder must not score);
- a plainly worded finding written for each case DOES name them (the rule is not so tight
  that a competent review fails it).

## Significance

An exact McNemar test needs at least six discordant pairs (`MIN_DISCORDANT`) before any split
can reach p < 0.05. With eight cases that is possible only if the variants disagree on six or
more of them. Use `--repeat` (per-case pass rates) or add cases before reading much into one
pass.

## Adding a case

1. Make `NN-name/change/`, holding every file the builder's commit adds or changes, as full
   files copied over `_shared/repo`. Use `repo.branch.delete` for files the commit removes.
2. Check that `bun test` still passes on the result. A defect the suite catches measures the
   verify step, not the reviewer.
3. Write `case.json` like the others: `goal`, `work`, `implementation_plan`, a confident
   `implementation_summary`, `repo.branch`, and a `review` oracle. Keep each `match` tight
   enough that a finding about a different problem cannot satisfy it by accident.
4. Add a plainly worded sample finding for it to the "competent reviewer" test in
   `ab.test.ts`, then run `bun test reviser/eval/ab.test.ts`. It checks the set's invariants and
   both sides of every `match`, materialises every case and loads the graph.
