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
bun tools/visual/seed.ts                   # 28 runs across every status, 4 workspaces, 2 local graphs (~10s)
bash tools/visual/serve.sh                 # viewer on http://localhost:4799 plus one live run
node tools/visual/shoot.mjs                # ~350 PNGs and audit.json into $HOWDAH_VISUAL_OUT/shots (~7 min)
node tools/visual/shoot.mjs dark-run-done  # only shots whose name contains the argument
(cd $HOWDAH_VISUAL_OUT && python3 "$OLDPWD/tools/visual/analyze.py" && python3 "$OLDPWD/tools/visual/list-shots.py")
```

Re-seed after changing app code: the server runs the copy, not the working tree.

| File | What |
|---|---|
| `seed.ts`, `lib.ts`, `content.ts` | drives the REAL engine with scripted executors, so logs, pinned prompts and rendered hashes are genuine; only the model's words are scripted |
| `live.ts` | one engine holding a real runner lock and streaming, so "running" is not faked |
| `serve.sh` | starts and stops the viewer and the live run |
| `shoot.mjs` | Playwright captures plus in-page audits: fonts, sizes, clipping, truncation, hit areas, contrast, focus |
| `analyze.py`, `list-shots.py` | turn `audit.json` into `audit-summary.md` and index the shots |

Playwright is expected to be resolvable by Node (`NODE_PATH=$(npm root -g)` if it is installed
globally). This directory is outside `tsconfig.json`'s `include` on purpose: it is a tool, not
part of the product, and it reaches into engine internals the way the tests do.
