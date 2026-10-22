import { describe, expect, it } from "vitest";
import { fixedThreadIds, parseRecheckResponse } from "../src/recheck.js";

describe("parseRecheckResponse", () => {
  const known = new Set(["PRRT_A", "PRRT_B"]);

  it("drops an answer for a thread id it was never asked about (M18)", () => {
    const raw = JSON.stringify({
      results: [
        { thread: "PRRT_A", fixed: true, confidence: 0.9 },
        { thread: "PRRT_UNKNOWN", fixed: true, confidence: 0.99 },
      ],
    });

    const verdicts = parseRecheckResponse(raw, known);

    expect(verdicts.map((verdict) => verdict.thread)).toEqual(["PRRT_A"]);
  });

  it("keeps only the first answer for a repeated thread id", () => {
    const raw = JSON.stringify({
      results: [
        { thread: "PRRT_B", fixed: false, confidence: 0.9 },
        { thread: "PRRT_B", fixed: true, confidence: 0.99 },
      ],
    });

    const verdicts = parseRecheckResponse(raw, known);

    expect(verdicts).toHaveLength(1);
    expect(fixedThreadIds(verdicts).size).toBe(0);
  });
});
