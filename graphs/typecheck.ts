/**
 * The compiler pass for a local graph (D8).
 *
 * `loadLocalGraph` proves a graph LOADS and VALIDATES, which is the gate every save passes.
 * It cannot see type errors: types are erased before anything runs, so a node whose `writes`
 * declares the wrong shape, or an edge condition reading a key as the wrong type, imports and
 * validates perfectly well and only bites during a run.
 *
 * A local graph lives outside the repo's tsconfig `include`, so `bun run check` never sees
 * it. This runs tsc against a generated config that extends the repo's — same strictness,
 * same lib, same `noUncheckedIndexedAccess` — with the one file added. The graph imports
 * `../core/graph` by an absolute path written at scaffold time, so resolution works from
 * anywhere without a paths mapping.
 *
 * tsc runs under node, and CLAUDE.md records that this machine has node 16 first on PATH,
 * which cannot load TypeScript 7's ESM entry. So it is invoked the way that always works
 * here: `bun node_modules/typescript/lib/tsc.js`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localGraphPath } from "./local";

export interface TypecheckResult {
  ok: boolean;
  /** tsc's own diagnostics, with the temp config's noise stripped */
  diagnostics: string[];
  /** true when tsc could not be run at all — never reported as a clean pass */
  unavailable?: string;
}

export async function typecheckLocalGraph(home: string, name: string, repoRoot: string): Promise<TypecheckResult> {
  const file = localGraphPath(home, name);
  const dir = mkdtempSync(join(tmpdir(), "howdah-tsc-"));
  try {
    const config = {
      extends: join(repoRoot, "tsconfig.json"),
      compilerOptions: { noEmit: true, skipLibCheck: true, types: ["bun"], typeRoots: [join(repoRoot, "node_modules", "@types")] },
      files: [file],
    };
    const configPath = join(dir, "tsconfig.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const proc = Bun.spawnSync(
      ["bun", join(repoRoot, "node_modules", "typescript", "lib", "tsc.js"), "-p", configPath],
      { stdout: "pipe", stderr: "pipe", cwd: repoRoot, env: { ...process.env } },
    );
    const dec = new TextDecoder();
    const out = `${dec.decode(proc.stdout)}\n${dec.decode(proc.stderr)}`.trim();

    // tsc not installed / not runnable is NOT a pass, and must not read like one
    if (proc.exitCode === null || /cannot find module|command not found|ENOENT/i.test(out))
      return { ok: false, diagnostics: [], unavailable: out.slice(0, 400) || "tsc could not be run" };

    const diagnostics = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // the generated config is an implementation detail; errors about IT are ours, not the operator's
      .filter((l) => !l.includes(configPath))
      // tsc prints the path relative to its cwd, which is the repo — an operator reading this
      // wants "my-review.ts(25,7)", not a chain of ../ back out to $HOWDAH_HOME
      .map((l) => l.replace(/^\S*?([\w.-]+\.ts)\(/, "$1("));

    return { ok: proc.exitCode === 0, diagnostics: proc.exitCode === 0 ? [] : diagnostics };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
