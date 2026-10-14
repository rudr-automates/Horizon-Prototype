import { describe, expect, it } from "vitest";
import { checkClaimDeterministically } from "@/lib/answer/verification";

const context = {
  payloadEvidenceIds: new Set(["block_1", "block_2"]),
  blockTextById: new Map([
    ["block_1", "The Marlin backoff constant is 0.37 seconds."],
    ["block_2", "This slide summarises the previous section."],
  ]),
};

describe("checkClaimDeterministically", () => {
  it("passes a claim whose evidence is in the payload and quote is verbatim", () => {
    const result = checkClaimDeterministically(
      {
        text: "The instructor sets the backoff constant to 0.37.",
        evidenceIds: ["block_1"],
        quote: "Marlin backoff constant is 0.37",
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("is whitespace- and case-tolerant for quote matching", () => {
    const result = checkClaimDeterministically(
      {
        text: "x",
        evidenceIds: ["block_1"],
        quote: "MARLIN   BACKOFF   CONSTANT",
      },
      context,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a citation that was not in the model payload", () => {
    const result = checkClaimDeterministically(
      { text: "x", evidenceIds: ["block_hidden"], quote: "backoff" },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("not in payload");
  });

  it("rejects a quote that does not appear in the cited block", () => {
    const result = checkClaimDeterministically(
      { text: "x", evidenceIds: ["block_2"], quote: "backoff constant is 0.37" },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("not found");
  });
});
