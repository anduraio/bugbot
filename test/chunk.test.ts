import { describe, expect, it } from "vitest";
import { planChunks, splitDiff } from "../src/chunk.js";
import { parseDiff } from "../src/context.js";

function fileDiff(path: string, hunks: number, linesPerHunk: number): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (let hunk = 0; hunk < hunks; hunk += 1) {
    const start = hunk * 100 + 1;
    lines.push(`@@ -${start},1 +${start},${linesPerHunk + 1} @@`);
    lines.push(" context line");
    for (let line = 0; line < linesPerHunk; line += 1) {
      lines.push(`+added ${path} ${hunk} ${line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const WIDE = { maxTokens: 1_000_000, maxChangedLines: 1_000_000 };

describe("splitDiff", () => {
  it("splits on diff --git and keeps each file's header and hunks", () => {
    const diff = fileDiff("a.ts", 2, 3) + fileDiff("b.ts", 1, 4);
    const sections = splitDiff(diff);

    expect(sections.map((section) => section.label)).toEqual(["a.ts", "b.ts"]);
    expect(sections[0]!.hunks).toHaveLength(2);
    expect(sections[0]!.changedLines).toBe(6);
    expect(sections[1]!.changedLines).toBe(4);
    expect(sections[0]!.header).toContain("+++ b/a.ts");
    expect(sections.map((s) => s.header + s.hunks.join("")).join("")).toBe(diff);
  });

  it("returns one section for a diff without git headers", () => {
    const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    expect(splitDiff(diff)).toHaveLength(1);
    expect(splitDiff("")).toEqual([]);
  });
});

describe("planChunks", () => {
  it("keeps a diff that fits as one part with the original text", () => {
    const diff = fileDiff("a.ts", 2, 3) + fileDiff("b.ts", 1, 3);
    const chunks = planChunks(diff, WIDE);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.diff).toBe(diff);
    expect(chunks[0]!.labels).toEqual(["a.ts", "b.ts"]);
  });

  it("groups whole files in diff order under the changed-line cap", () => {
    const diff = ["a", "b", "c", "d", "e"]
      .map((name) => fileDiff(`src/${name}.ts`, 1, 300))
      .join("");
    const chunks = planChunks(diff, { maxTokens: 1_000_000, maxChangedLines: 1_000 });

    expect(chunks.map((chunk) => chunk.labels)).toEqual([
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      ["src/d.ts", "src/e.ts"],
    ]);
    expect(chunks.map((chunk) => chunk.changedLines)).toEqual([900, 600]);
    expect(chunks.map((chunk) => chunk.diff).join("")).toBe(diff);
  });

  it("splits a file over the token cap at hunk boundaries and repeats its header", () => {
    const diff = fileDiff("big.json", 4, 200) + fileDiff("small.ts", 1, 2);
    const chunks = planChunks(diff, { maxTokens: 3_000, maxChangedLines: 1_000_000 });

    // Two hunks fit per part, so big.json spans two parts and small.ts joins
    // the last one.
    expect(chunks.map((chunk) => chunk.labels)).toEqual([
      ["big.json"],
      ["big.json", "small.ts"],
    ]);
    let changed = 0;
    for (const chunk of chunks) {
      const parsed = parseDiff(chunk.diff);
      // Each part is still a valid diff of whole hunks.
      for (const file of parsed.files) {
        expect(file.hunks.length).toBeGreaterThan(0);
        expect(["big.json", "small.ts"]).toContain(file.path);
      }
      changed += parsed.totalChangedLines;
    }
    expect(changed).toBe(parseDiff(diff).totalChangedLines);
  });

  it("never splits a single hunk, even when it is over both caps", () => {
    const diff = fileDiff("one.ts", 1, 2_000);
    const chunks = planChunks(diff, { maxTokens: 100, maxChangedLines: 10 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.diff).toBe(diff);
  });
});
