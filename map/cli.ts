/**
 * Standalone extractor entry — system-map slice 1b ("runnable standalone").
 *
 *   bun map/cli.ts <repo-dir> [--commit <sha>] [--store <dir>] [--workers N]
 *                             [--manifest-out <dir>] [--json]
 *
 * Extracts a snapshot (working tree, or `--commit` from git objects), assembles it, and prints
 * counts per entity kind, blocks, edges, joins, skips, unparsed regions, not-checked files and
 * adapter coverage. `--json` prints the assembled map instead. The `howdah map` verb in
 * cli/main.ts (1c) will call the same `extract` + `assemble`.
 */

import { assemble } from "./assemble";
import { extract } from "./extract";
import { MapStore, defaultStoreDir, writeManifestTo } from "./store";
import type { AssembledMap } from "./types";
import { cmpStr } from "./util";

interface Args {
  repo: string;
  commit?: string;
  store: string;
  workers?: number;
  manifestOut?: string;
  json: boolean;
}

function usage(msg?: string): never {
  if (msg !== undefined) console.error(msg);
  console.error("usage: bun map/cli.ts <repo-dir> [--commit <sha>] [--store <dir>] [--workers N] [--manifest-out <dir>] [--json]");
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let repo: string | undefined;
  const a: Omit<Args, "repo"> = { store: defaultStoreDir(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${t} needs a value`);
      return v;
    };
    if (t === "--commit") a.commit = next();
    else if (t === "--store") a.store = next();
    else if (t === "--workers") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 0) usage("--workers must be a non-negative integer");
      a.workers = n;
    } else if (t === "--manifest-out") a.manifestOut = next();
    else if (t === "--json") a.json = true;
    else if (t === "-h" || t === "--help") usage();
    else if (t !== undefined && !t.startsWith("--") && repo === undefined) repo = t;
    else usage(`unknown argument ${t ?? ""}`);
  }
  if (repo === undefined) usage("missing <repo-dir>");
  return { repo, ...a };
}

function countBy<T>(xs: T[], f: (x: T) => string): string {
  const m = new Map<string, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])).map(([k, n]) => `${k}=${n}`).join(" ") || "none";
}

export function summarise(map: AssembledMap): string {
  const lines: string[] = [];
  const ambiguous = map.entities.filter((e) => e.ambiguous === true).length;
  lines.push(`manifest ${map.manifestHash.slice(0, 16)}  commit ${map.commit?.slice(0, 12) ?? "(none)"}  extractor ${map.extractorVersion}`);
  lines.push(`files       ${map.files.length} extracted  (${countBy(map.files, (f) => f.language)})`);
  lines.push(`blocks      ${map.blocks.length}  (${countBy(map.blocks, (b) => b.family)})`);
  lines.push(`entities    ${map.entities.length}  (${countBy(map.entities, (e) => e.kind)})  ambiguous=${ambiguous}`);
  lines.push(`edges       ${map.edges.length}  (${countBy(map.edges, (e) => e.kind)})`);
  lines.push(`fe→be joins ${map.joins.length}  (${countBy(map.joins, (j) => j.status)})`);
  lines.push(`casts       ${map.casts.length}  (${countBy(map.casts, (c) => c.kind)})   names ${map.names.length}`);
  lines.push(`skipped     ${map.skipped.length}  (${countBy(map.skipped, (s) => s.reason.replace(/ \(\d+ bytes.*$/, ""))})`);
  lines.push(`not-checked ${map.notChecked.length}${map.notChecked.length > 0 ? "  (" + countBy(map.notChecked, (n) => n.reason.split(":")[0] ?? n.reason) + ")" : ""}`);
  lines.push(`unparsed    ${map.unparsed.length} regions in ${new Set(map.unparsed.map((u) => u.file)).size} files`);
  for (const a of map.adapters) {
    const cov = map.coverage.filter((c) => c.adapter === a.name);
    const partial = cov.filter((c) => c.status === "partial");
    lines.push(`coverage    ${a.name}@${a.version}: ${cov.length - partial.length} full, ${partial.length} partial (covers ${a.covers.join(",")})`);
    for (const p of partial.slice(0, 5)) lines.push(`              partial ${p.file}: ${p.reasons[0]?.reason ?? ""}${p.reasons.length > 1 ? ` (+${p.reasons.length - 1})` : ""}`);
    if (partial.length > 5) lines.push(`              … ${partial.length - 5} more`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const store = new MapStore(args.store);
  let last = 0;
  const res = await extract({
    repoDir: args.repo,
    store,
    ...(args.commit !== undefined ? { commit: args.commit } : {}),
    ...(args.workers !== undefined ? { workers: args.workers } : {}),
    onProgress: (p) => {
      if (args.json || !process.stderr.isTTY) return;
      const now = Date.now();
      if (now - last < 100 && p.done < p.total) return;
      last = now;
      process.stderr.write(`\rextracting ${p.done}/${p.total} (skipped ${p.skipped})`);
      if (p.done === p.total) process.stderr.write("\n");
    },
  });
  const t = performance.now();
  const map = assemble(res.manifest, store);
  const assembleMs = Math.round(performance.now() - t);
  if (args.manifestOut !== undefined) writeManifestTo(res.manifest, args.manifestOut);
  if (args.json) console.log(JSON.stringify(map, null, 2));
  else {
    console.log(summarise(map));
    const s = res.stats;
    console.log(`timing      extract ${s.ms} ms (${s.parsed} parsed, ${s.cached} cached), assemble ${assembleMs} ms   store ${store.dir}`);
  }
}
