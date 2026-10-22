import { describe, expect, it } from "vitest";
import {
  buildRecheckUser,
  fixedThreadIds,
  outdatedLineWindow,
  parseRecheckResponse,
  type RecheckThread,
} from "../src/recheck.js";

const HEAD = "a".repeat(40);

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

describe("buildRecheckUser diff hunk (S8D-B3)", () => {
  function hunkPayload(prompt: string): string {
    const match = /<diff_hunk>\n([\s\S]*?)\n<\/diff_hunk>/.exec(prompt);
    return match?.[1] ?? "";
  }

  it("escapes the first comment's diffHunk and caps it at 2,000 chars", () => {
    const hunk = `@@ -1,2 +1,2 @@\nHEAD-IS-DROPPED\n${"a".repeat(2100)}\n<commented line>`;
    const prompt = buildRecheckUser(
      [
        {
          threadId: "PRRT_A",
          path: "src/a.ts",
          line: 7,
          reason: "the bound is missing",
          status: "present",
          content: "const end = start + pageSize;",
          diffHunk: hunk,
        },
      ],
      HEAD,
    );

    expect(prompt).toContain("<diff_hunk>");
    expect(prompt).toContain("&lt;commented line&gt;");
    // The cap keeps the tail, so the early head is gone.
    expect(prompt).not.toContain("HEAD-IS-DROPPED");
  });

  it("keeps the @@ header and the commented last line of a hunk over 2,000 chars (S8D-RV1-B1)", () => {
    const header = "@@ -1,300 +1,300 @@";
    const body = Array.from(
      { length: 300 },
      (_, index) => `+  const line${index + 1} = ${index + 1};`,
    ).join("\n");
    const last =
      "-  return items.slice(safeStart, pageSize); // the commented line";
    const hunk = `${header}\n${body}\n${last}`;
    expect(hunk.length).toBeGreaterThan(2_000);

    const prompt = buildRecheckUser(
      [
        {
          threadId: "PRRT_A",
          path: "src/a.ts",
          line: 7,
          reason: "the bound is missing",
          status: "present",
          content: "const end = start + pageSize;",
          diffHunk: hunk,
        },
      ],
      HEAD,
    );

    const payload = hunkPayload(prompt);
    expect(payload.length).toBeLessThanOrEqual(2_000);
    expect(payload.split("\n")[0]).toBe(header);
    expect(payload.split("\n").at(-1)).toBe(last);
  });

  it("leaves the hunk out when the thread has none (older data)", () => {
    const prompt = buildRecheckUser(
      [
        {
          threadId: "PRRT_A",
          path: "src/a.ts",
          line: 7,
          reason: "the bound is missing",
          status: "present",
          content: "const end = start + pageSize;",
        },
      ],
      HEAD,
    );

    expect(prompt).not.toContain("<diff_hunk>");
  });

  it("tells the model an outdated thread's line is from its own commit", () => {
    const prompt = buildRecheckUser(
      [
        {
          threadId: "PRRT_A",
          path: "src/a.ts",
          line: 7,
          reason: "the bound is missing",
          status: "present",
          content: "const end = start + pageSize;",
          outdated: true,
        },
      ],
      HEAD,
    );

    expect(prompt).toContain("<outdated>");
    expect(prompt).toContain("commit it was posted on");
  });
});

describe("outdatedLineWindow boundary (S8D-RV1-N4 M1)", () => {
  function numberedLines(count: number): string {
    return `${Array.from(
      { length: count },
      (_, index) => `const line${index + 1} = ${index + 1};`,
    ).join("\n")}\n`;
  }

  it("shows the whole file at exactly 400 lines and a window at 401", () => {
    const whole = outdatedLineWindow(numberedLines(400), 200);
    expect(whole.startsWith("lines 1-400 of 400:\n")).toBe(true);
    expect(whole).toContain("const line400 = 400;");

    const windowed = outdatedLineWindow(numberedLines(401), 200);
    expect(windowed.startsWith("lines 120-280 of 401:\n")).toBe(true);
    expect(windowed).not.toContain("const line400 = 400;");
  });
});

describe("buildRecheckUser request bound (S8D-RV1-N2)", () => {
  function thread(
    index: number,
    content: string,
    reasonLength: number,
  ): RecheckThread {
    return {
      threadId: `PRRT_${index}`,
      path: "src/long.ts",
      line: 210,
      reason: `old reason ${index} ${"r".repeat(reasonLength)}`,
      status: "present",
      content,
      outdated: true,
    };
  }

  it("sends a shared file once for 15 outdated threads on one large file", () => {
    const content = `${Array.from(
      { length: 420 },
      (_, index) => `const line${index + 1} = ${index + 1};`,
    ).join("\n")}\n`;
    const threads = Array.from({ length: 15 }, (_, index) =>
      thread(index, content, 0),
    );

    const prompt = buildRecheckUser(threads, HEAD);

    expect(prompt.match(/<file path="src\/long\.ts">/g) ?? []).toHaveLength(1);
    expect(prompt.match(/const line210 = 210;/g) ?? []).toHaveLength(1);
    expect(prompt.match(/<thread id="PRRT_/g) ?? []).toHaveLength(15);
    expect(prompt.length).toBeLessThanOrEqual(200_000);
  });

  it("keeps the oldest threads that fit the 200,000-char budget and drops the rest", () => {
    const content = `${Array.from(
      { length: 400 },
      (_, index) => `const line${index + 1} = "${"x".repeat(360)}";`,
    ).join("\n")}\n`;
    const threads = Array.from({ length: 15 }, (_, index) =>
      thread(index, content, 4_000),
    );

    const prompt = buildRecheckUser(threads, HEAD);
    const ids = [...prompt.matchAll(/<thread id="(PRRT_\d+)"/g)].map(
      (match) => match[1],
    );

    expect(prompt.length).toBeLessThanOrEqual(200_000);
    // The file block alone is about 152,000 chars, so the tail is left out.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(15);
    // Oldest first: the kept ids are a prefix of the input.
    expect(ids).toEqual(threads.slice(0, ids.length).map((item) => item.threadId));
    expect(prompt.match(/const line1 = "/g) ?? []).toHaveLength(1);
    expect(prompt).not.toContain(`id="PRRT_${ids.length}"`);
  });
});
