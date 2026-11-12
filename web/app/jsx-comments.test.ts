/**
 * HOW-68: a `//` comment placed between JSX elements is not a comment — it is text, and React
 * renders it. Wrapping the inbox's Row in a `listitem` left one such "comment" between the two
 * tags, and every row of Needs you printed a paragraph of source notes above itself. TypeScript
 * accepts it and no other test looks at the prose, so the source is scanned instead: a line
 * that starts with `//` directly after a line ending in a JSX opening tag is refused.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import { join } from "node:path";

test("no `//` comment sits between JSX tags, where React would render it as text", () => {
  const root = import.meta.dir;
  const bad: string[] = [];
  for (const rel of new Glob("**/*.tsx").scanSync(root)) {
    const lines = readFileSync(join(root, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      const prev = i > 0 ? lines[i - 1]!.trimEnd() : "";
      if (line.trim().startsWith("//") && /<[A-Za-z][^<]*[^=]>$/.test(prev) && !prev.endsWith("=>")) {
        bad.push(`${rel}:${i + 1} ${line.trim().slice(0, 80)}`);
      }
    });
  }
  expect(bad).toEqual([]);
});
