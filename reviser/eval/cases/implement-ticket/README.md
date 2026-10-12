# implement-ticket A/B case set (HOW-42)

Three small tickets against one tiny TypeScript repo (`_shared/repo`), each judged by a
hidden `bun test` oracle copied into the worktree only after the run. Sized to finish in well
under an hour on a subscription: each case is one plan + one implement + one `verify:run`.

The graph (`_shared/graph.ts.tmpl`, installed into the isolated `$HOWDAH_HOME` as the local
graph `eval-implement`) is implement-ticket's implementation half — create_worktree → plan →
implement → verify.run — and stops there: an eval must never open a pull request.

```bash
# dry run, no tokens (every agent node parks)
HOWDAH_STUB=1 bun reviser/eval/ab.ts --cases reviser/eval/cases/implement-ticket \
  --a prompts/implementation.implement.md --b reviser/proposals/<id>.vN.proposal.md

# the real thing — spends tokens
bun reviser/eval/ab.ts --cases reviser/eval/cases/implement-ticket \
  --a prompts/implementation.implement.md --b reviser/proposals/<id>.vN.proposal.md \
  --stamp reviser/proposals/<id>.vN.proposal.md
```

Three cases cannot produce a significant result on their own (an exact McNemar test needs at
least six discordant pairs); the report says so. Add cases, or use `--repeat`, before reading a
verdict into it.
