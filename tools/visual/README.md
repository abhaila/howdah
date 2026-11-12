# Visual harness

Runs the viewer against a realistic demo home and captures every screen. It is what the
HOW-68 design loop checks against (`docs/designs/design-overhaul.md`).

Nothing is written into the repo: output goes to `$HOWDAH_VISUAL_OUT` (default
`$TMPDIR/howdah-visual`), and the viewer is served from a private copy of the repo made there,
because `bun web/server.ts` bundles into `web/public/` and writes proposals and feedback under
its repo root.

```bash
export HOWDAH_VISUAL_OUT=/tmp/howdah-visual
bash tools/visual/serve.sh stop            # the seed deletes home/, repo/ and work/
bun tools/visual/seed.ts                   # ~45 runs across every status and park kind, 4 workspaces, 4 local graphs, and an empty home (~3s)
bash tools/visual/serve.sh > $HOWDAH_VISUAL_OUT/serve.out 2>&1 < /dev/null
                                           # viewer on :4799 with two live runs, and the EMPTY home on :4800 (redirect it: piping its output hangs the shell)
node tools/visual/shoot.mjs                # ~570 PNGs and audit.json into $HOWDAH_VISUAL_OUT/shots (~17 min)
node tools/visual/shoot.mjs dark-run-done  # only shots whose name contains the argument
STEPS='^(gated-waive|drift-pane)$' node tools/visual/shoot.mjs light   # only the steps whose name matches
(cd $HOWDAH_VISUAL_OUT && python3 "$OLDPWD/tools/visual/analyze.py"; python3 "$OLDPWD/tools/visual/list-shots.py")
```

Re-seed after changing app code: the server runs the copy, not the working tree.
`HOWDAH_VISUAL_PORT` moves both viewers (the empty home is always the next port).

**`analyze.py` is the gate.** It writes `shots/audit-summary.md` and ends with a
`STANDARDS: PASS/FAIL` block — font sizes off the six-step scale, faces other than DM Sans / DM
Mono, an ellipsis with no way to read it, targets under 24px, focus stops with no ring, clipped
or unreachable content, contrast failures on live text, and capture steps that failed — and
exits 1 unless every count is zero. Three things are measured and deliberately not counted:
a visually-hidden label (`sr-only` clips its own text by design), React Flow's canvas (content
past the pane is reached by panning, and a canvas the operator zoomed out shrinks its targets
as browser zoom would), and text on a DISABLED control (exempt from contrast; it is listed,
marked exempt).

| File | What |
|---|---|
| `seed.ts`, `lib.ts`, `content.ts` | drives the REAL engine with scripted executors, so logs, pinned prompts and rendered hashes are genuine; only the model's words are scripted. Section O adds one run per state a built-in graph does not reach on its own (a `parallel` step, a gated acceptance park, permission and MCP asks, a soft stop, drift, stale-base, turn-timeout, no-progress, repair-stalled, queued, failed-recoverable, failed evidence, an UNVERIFIED render, stale and orphaned proposals); each seam is named where it is used |
| `live.ts` | engines holding a real runner lock: one streaming turn that is steered (a delivered steer and a pending one), and a stacked run waiting in `deps.wait` — so "running" and "waiting" are not faked |
| `serve.sh` | starts and stops the viewer, the live runs and the empty-home viewer |
| `shoot.mjs` | Playwright captures plus in-page audits: fonts, sizes, clipping, truncation, hit areas, contrast, focus |
| `analyze.py`, `list-shots.py` | turn `audit.json` into `audit-summary.md` and the standards gate; index the shots |

Playwright is expected to be resolvable by Node (`NODE_PATH=$(npm root -g)` if it is installed
globally). This directory is outside `tsconfig.json`'s `include` on purpose: it is a tool, not
part of the product, and it reaches into engine internals the way the tests do.
