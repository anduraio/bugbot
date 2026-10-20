import { describe, expect, it } from "vitest";
import {
  FindingSchema,
  findingHash,
  marker,
  shouldPost,
  type DiffSide,
  type Finding,
} from "../src/filter.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse({
    file: "src/billing.ts",
    line: 42,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    reason: "Dropped the `expiresAt` check, so expired subscriptions keep access.",
    suggested_fix: "Restore the expiresAt check.",
    angle: "interrogate:correctness",
    symbol: "isSubscriptionActive",
    ...overrides,
  });
}

const changedLines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
  [
    "src/billing.ts",
    new Map<DiffSide, ReadonlySet<number>>([
      ["RIGHT", new Set([42, 43, 50])],
      ["LEFT", new Set([41])],
    ]),
  ],
]);

describe("findingHash", () => {
  it("is the same when the same finding moves to a shifted line", () => {
    const before = finding({ line: 42 });
    const after = finding({ line: 43, end_line: 45 });

    expect(findingHash(after)).toBe(findingHash(before));
  });

  it("ignores formatting-only drift in the reason", () => {
    const plain = finding({ reason: "Null deref in the subscription lookup." });
    const noisy = finding({ reason: "  NULL deref in the `subscription` lookup.  " });

    expect(findingHash(noisy)).toBe(findingHash(plain));
  });

  it("is a lowercase 40-character hex sha1", () => {
    expect(findingHash(finding())).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes when the file changes", () => {
    expect(findingHash(finding({ file: "src/other.ts" }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("changes when the category changes", () => {
    expect(findingHash(finding({ category: "security" }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("changes when the reason changes", () => {
    expect(findingHash(finding({ reason: "A different bug entirely." }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("changes when the symbol changes", () => {
    expect(findingHash(finding({ symbol: "otherSymbol" }))).not.toBe(
      findingHash(finding()),
    );
  });
});

describe("shouldPost", () => {
  it("posts a high-confidence, high-severity finding on a changed line", () => {
    expect(shouldPost(finding(), { minConfidence: 0.8, changedLines })).toBe(true);
  });

  it("does not post a finding below the confidence threshold", () => {
    expect(
      shouldPost(finding({ confidence: 0.79 }), { minConfidence: 0.8, changedLines }),
    ).toBe(false);
  });

  it("does not post a low-severity finding", () => {
    expect(
      shouldPost(finding({ severity: "low", confidence: 1 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("does not post a finding whose line is not in the diff", () => {
    expect(shouldPost(finding({ line: 99 }), { minConfidence: 0.8, changedLines })).toBe(
      false,
    );
  });

  it("does not post a LEFT-side finding on a RIGHT-only line", () => {
    expect(
      shouldPost(finding({ side: "LEFT", line: 42 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("posts a LEFT-side finding on a LEFT line", () => {
    expect(
      shouldPost(finding({ side: "LEFT", line: 41 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(true);
  });

  it("does not post a range whose end_line is before line", () => {
    expect(
      shouldPost(finding({ line: 43, end_line: 42 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("does not post a range whose end_line is not in the diff", () => {
    expect(
      shouldPost(finding({ line: 42, end_line: 99 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("posts a multi-line range fully inside the diff", () => {
    expect(
      shouldPost(finding({ line: 42, end_line: 43 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(true);
  });
});

describe("marker", () => {
  it("carries the hidden marker and a RUN_ID line watch-pr can count", () => {
    const body = marker("abc123", "987654321", "deadbeef");

    expect(body).toContain("RUN_ID: ");
    expect(body).toContain("<!-- bugbot:v1 id=abc123 run=987654321 sha=deadbeef -->");
    expect(body).toContain("RUN_ID: 987654321");
  });
});
