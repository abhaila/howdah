import { describe, expect, test } from "bun:test";
import { isAllowReply } from "./reply";

describe("free-text ask replies", () => {
  test("allow phrases — including the observed 'Full Access' failure", () => {
    for (const r of ["allow", "yes", "ok", "LGTM", "go ahead", "Change permissions to Full Access", "approved, continue", "grant it", ""])
      expect({ r, allow: isAllowReply(r) }).toEqual({ r, allow: true });
  });
  test("denials and questions do not allow", () => {
    for (const r of ["deny", "no", "don't run that", "stop", "use the scratch dir instead", "why did it fail?"])
      expect({ r, allow: isAllowReply(r) }).toEqual({ r, allow: false });
  });
  test("mixed signals lean on the explicit deny", () => {
    expect(isAllowReply("no, don't allow this")).toBe(false);
  });
});
