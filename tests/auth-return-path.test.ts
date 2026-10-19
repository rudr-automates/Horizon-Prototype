import { describe, expect, it } from "vitest";
import { safeAuthReturnPath } from "@/lib/auth/return-path";

describe("safeAuthReturnPath", () => {
  it("keeps valid in-app destinations, including lesson deep links", () => {
    expect(safeAuthReturnPath("/learn?lesson=recording&start=300"))
      .toBe("/learn?lesson=recording&start=300");
  });

  it("falls back to the account page for external or malformed destinations", () => {
    for (const value of ["https://example.com", "//example.com", "/\\example.com", "", null]) {
      expect(safeAuthReturnPath(value)).toBe("/account");
    }
  });
});
