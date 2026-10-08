/**
 * HOW-12: the verify command is per REPO workspace, looked up by the path a run knows its repo
 * by, and a blank one reads as unset — never as a script that runs as a no-op and passes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setVerifyCommand, verifyCommandFor, type HowdahConfig } from "./config";

const config = (): HowdahConfig => ({
  repos: {
    api: { path: "/code/api", verifyCommand: "bun test" },
    web: { path: "/code/web" },
    blank: { path: "/code/blank", verifyCommand: "   " },
  },
  folders: { notes: { path: "/code/notes" } },
});

describe("verifyCommandFor", () => {
  test("matches by repo path", () => {
    expect(verifyCommandFor(config(), "/code/api")).toBe("bun test");
  });

  test("undefined for a repo with none, an unregistered path, a Plain folder and a blank command", () => {
    expect(verifyCommandFor(config(), "/code/web")).toBeUndefined();
    expect(verifyCommandFor(config(), "/elsewhere")).toBeUndefined();
    expect(verifyCommandFor(config(), "/code/notes")).toBeUndefined();
    expect(verifyCommandFor(config(), "/code/blank")).toBeUndefined();
  });

  test("survives a round trip through config.json", () => {
    const base = mkdtempSync(join(tmpdir(), "howdah-cfg-verify-"));
    saveConfig(config(), base);
    expect(verifyCommandFor(loadConfig(base), "/code/api")).toBe("bun test");
  });
});

describe("setVerifyCommand", () => {
  test("sets (trimmed) and clears", () => {
    const c = config();
    setVerifyCommand(c, "web", "  ./gradlew test ");
    expect(c.repos.web?.verifyCommand).toBe("./gradlew test");
    setVerifyCommand(c, "api", undefined);
    expect("verifyCommand" in c.repos.api!).toBe(false);
    setVerifyCommand(c, "web", "  ");
    expect("verifyCommand" in c.repos.web!).toBe(false);
  });

  test("refuses a Plain folder and an unknown name, in words", () => {
    expect(() => setVerifyCommand(config(), "notes", "x")).toThrow(/Plain folder/);
    expect(() => setVerifyCommand(config(), "ghost", "x")).toThrow(/unknown repo workspace "ghost"/);
  });
});
