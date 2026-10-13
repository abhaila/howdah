import { expect, test } from "bun:test";
import { truncate } from "./text";

test("oracle: truncate", () => {
  expect(truncate("short", 10)).toBe("short");
  expect(truncate("exactly10!", 10)).toBe("exactly10!");
  expect(truncate("this is too long", 8)).toBe("this is…");
  expect([...truncate("🐘🐘🐘🐘", 3)]).toEqual(["🐘", "🐘", "…"]);
  expect(() => truncate("x", 0)).toThrow(RangeError);
});
