import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTokenBudget,
  buildContext,
  diffLineTexts,
  hunkContextsFromDiff,
  hunkRangesByPath,
  parseDiff,
  selectModel,
  type ContextFile,
  type ReadFile,
  type ReviewContext,
  type ReviewRequest,
} from "../src/context.js";
import { buildPrompt, loadSystemPrompt } from "../src/prompt.js";

const DIFF = `diff --git a/src/keep.ts b/src/keep.ts
index 1111111..2222222 100644
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,3 +1,4 @@
 line one
-old line
+new line
+extra line
 line three
@@ -10,2 +11,3 @@
 line ten
+added ten
 line eleven
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+first
+second
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-first
-second
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/assets/logo.png differ
diff --git a/src/no-newline.ts b/src/no-newline.ts
index 6666666..7777777 100644
--- a/src/no-newline.ts
+++ b/src/no-newline.ts
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

function fileByPath(path: string) {
  const file = parseDiff(DIFF).files.find((candidate) => candidate.path === path);
  expect(file, `${path} should be parsed`).toBeDefined();
  return file!;
}

function right(path: string): number[] {
  return [...(parseDiff(DIFF).changedLines.get(path)?.get("RIGHT") ?? [])].sort(
    (a, b) => a - b,
  );
}

function left(path: string): number[] {
  return [...(parseDiff(DIFF).changedLines.get(path)?.get("LEFT") ?? [])].sort(
    (a, b) => a - b,
  );
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Runs git without touching or depending on the user's git config. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=true", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Bugbot Test",
      GIT_AUTHOR_EMAIL: "bugbot-test@example.invalid",
      GIT_COMMITTER_NAME: "Bugbot Test",
      GIT_COMMITTER_EMAIL: "bugbot-test@example.invalid",
    },
  });
}

describe("parseDiff", () => {
  it("parses a modified file with multiple hunks", () => {
    const file = fileByPath("src/keep.ts");

    expect(file.status).toBe("modified");
    expect(file.oldPath).toBe("src/keep.ts");
    expect(file.newPath).toBe("src/keep.ts");
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0]?.header).toContain("@@ -1,3 +1,4 @@");
    expect(file.added).toBe(3);
    expect(file.removed).toBe(1);
  });

  it("maps added lines to RIGHT and removed lines to LEFT", () => {
    expect(right("src/keep.ts")).toEqual([2, 3, 12]);
    expect(left("src/keep.ts")).toEqual([2]);
  });

  it("parses a new file", () => {
    const file = fileByPath("src/new.ts");

    expect(file.status).toBe("added");
    expect(file.oldPath).toBeNull();
    expect(file.newPath).toBe("src/new.ts");
    expect(right("src/new.ts")).toEqual([1, 2]);
    expect(left("src/new.ts")).toEqual([]);
  });

  it("parses a deleted file", () => {
    const file = fileByPath("src/gone.ts");

    expect(file.status).toBe("deleted");
    expect(file.newPath).toBeNull();
    expect(file.oldPath).toBe("src/gone.ts");
    expect(left("src/gone.ts")).toEqual([1, 2]);
    expect(right("src/gone.ts")).toEqual([]);
  });

  it("parses a rename with both paths", () => {
    const file = fileByPath("src/new-name.ts");

    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("src/old-name.ts");
    expect(file.newPath).toBe("src/new-name.ts");
    expect(file.hunks).toHaveLength(0);
  });

  it("marks a binary file and gives it no hunks", () => {
    const file = fileByPath("assets/logo.png");

    expect(file.binary).toBe(true);
    expect(file.status).toBe("added");
    expect(file.hunks).toHaveLength(0);
    expect(file.added).toBe(0);
    expect(file.removed).toBe(0);
  });

  it("ignores the no-newline marker and counts both sides", () => {
    const file = fileByPath("src/no-newline.ts");

    expect(file.hunks).toHaveLength(1);
    expect(right("src/no-newline.ts")).toEqual([1]);
    expect(left("src/no-newline.ts")).toEqual([1]);
  });

  it("counts added plus removed lines across the diff", () => {
    expect(parseDiff(DIFF).totalChangedLines).toBe(10);
  });

  it("returns hunk ranges on the new side", () => {
    const ranges = hunkRangesByPath(DIFF);

    expect(ranges.get("src/keep.ts")).toEqual([
      { start: 1, end: 4 },
      { start: 11, end: 13 },
    ]);
  });

  it("decodes non-ASCII quoted paths from a real git diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-utf8-"));
    tempDirs.push(root);
    const names = ["café.txt", "日本語.txt"];

    git(root, ["init", "-q"]);
    for (const name of names) {
      await writeFile(join(root, name), "one\n", "utf8");
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);
    for (const name of names) {
      await writeFile(join(root, name), "one\ntwo\n", "utf8");
    }

    const diff = git(root, ["diff"]);

    // Sanity: git really quoted both paths as UTF-8 octal bytes.
    expect(diff).toContain('"a/caf\\303\\251.txt"');
    expect(diff).toContain("\\346\\227\\245");

    const parsed = parseDiff(diff);
    expect([...parsed.files.map((file) => file.path)].sort()).toEqual(
      [...names].sort(),
    );
    expect([...parsed.changedLines.keys()].sort()).toEqual([...names].sort());
    expect([...(parsed.changedLines.get("café.txt")?.get("RIGHT") ?? [])]).toEqual([
      2,
    ]);
    expect([...(parsed.changedLines.get("日本語.txt")?.get("RIGHT") ?? [])]).toEqual([
      2,
    ]);

    const reads: string[] = [];
    const context = await buildContext(fakeRequest(diff, 120_000), async (path) => {
      reads.push(path);
      return names.includes(path) ? "one\ntwo\n" : null;
    });

    expect(context.files.map((file) => file.path).sort()).toEqual([...names].sort());
    expect(reads.sort()).toEqual([...names].sort());
    expect(context.changedLines.get("café.txt")?.get("RIGHT")?.has(2)).toBe(true);
    expect(context.changedLines.get("日本語.txt")?.get("RIGHT")?.has(2)).toBe(true);
  });

  it("reads paths with a b/ segment from binary and mode-only headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-path-spaces-"));
    tempDirs.push(root);
    await mkdir(join(root, "old b"));

    git(root, ["init", "-q"]);
    await writeFile(join(root, "old b/x.bin"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "old b/x.txt"), "one\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "base"]);

    await writeFile(join(root, "old b/x.bin"), Buffer.from([0, 9, 8, 7, 6]));
    await chmod(join(root, "old b/x.txt"), 0o755);

    const diff = git(root, ["diff"]);

    // Real git output: no ---/+++ lines for either entry.
    expect(diff).toContain("Binary files a/old b/x.bin and b/old b/x.bin differ");
    expect(diff).not.toContain("+++ b/old b/x.bin");
    expect(diff).not.toContain("+++ b/old b/x.txt");

    const parsed = parseDiff(diff);
    expect(parsed.files.map((file) => file.path).sort()).toEqual([
      "old b/x.bin",
      "old b/x.txt",
    ]);
    expect(parsed.files.find((file) => file.path === "old b/x.bin")?.binary).toBe(
      true,
    );
    expect(parsed.files.find((file) => file.path === "old b/x.txt")?.hunks).toEqual(
      [],
    );
    expect([...parsed.changedLines.keys()].sort()).toEqual([
      "old b/x.bin",
      "old b/x.txt",
    ]);
  });
});

function addedFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function modifiedFileDiff(path: string, start: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},1 +${start},1 @@`,
    `-old ${path}`,
    `+new ${path}`,
    "",
  ].join("\n");
}

/** One file entry with several single-line hunks. */
function multiHunkDiff(path: string, starts: readonly number[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...starts.flatMap((start) => [
      `@@ -${start},1 +${start},1 @@`,
      `-old ${path}`,
      `+new ${path}`,
    ]),
    "",
  ].join("\n");
}

function fakeRequest(diff: string, maxTokens: number): ReviewRequest {
  return {
    repository: "local/local",
    prNumber: 1,
    headSha: "head",
    baseSha: "base",
    diff,
    changedFiles: [],
    agentsMd: "",
    title: "Fixture",
    body: "",
    maxTokens,
  };
}

function contextWith(
  files: readonly ContextFile[],
  diff: string,
  overrides: Partial<ReviewContext> = {},
): ReviewContext {
  const parsed = parseDiff(diff);
  return {
    title: "",
    body: "",
    diff,
    files,
    agentsMd: "",
    estimatedTokens: 0,
    skipped: [],
    truncated: [],
    overBudget: false,
    systemPromptChars: 0,
    changedLines: parsed.changedLines,
    totalChangedLines: parsed.totalChangedLines,
    ...overrides,
  };
}

function numberedFile(path: string, count: number): ContextFile {
  const lines = Array.from(
    { length: count },
    (_value, index) => `row ${String(index + 1).padStart(4, "0")} of ${path}`,
  );
  return { path, content: lines.join("\n"), truncatedToHunks: false };
}

describe("applyTokenBudget", () => {
  it("reduces the largest file first, then the next, and keeps every hunk", () => {
    const diff =
      modifiedFileDiff("a.ts", 200) +
      modifiedFileDiff("b.ts", 200) +
      multiHunkDiff("c.ts", [100, 1_100]);
    const files = [
      numberedFile("a.ts", 400),
      numberedFile("b.ts", 800),
      numberedFile("c.ts", 1_200),
    ];

    const result = applyTokenBudget(contextWith(files, diff), 5_000);

    expect(result.truncated).toEqual(["c.ts", "b.ts"]);
    expect(result.files.find((file) => file.path === "a.ts")?.truncatedToHunks).toBe(
      false,
    );
    expect(result.diff).toBe(diff);
    expect(result.overBudget).toBe(false);

    // Inspect the reduced contents, not just the diff string: every hunk line
    // must still be there and the omitted ranges must be marked.
    const reducedC = result.files.find((file) => file.path === "c.ts");
    expect(reducedC?.truncatedToHunks).toBe(true);
    for (const line of [
      "row 0020 of c.ts",
      "row 0100 of c.ts",
      "row 0180 of c.ts",
      "row 1020 of c.ts",
      "row 1100 of c.ts",
      "row 1180 of c.ts",
    ]) {
      expect(reducedC?.content).toContain(line);
    }
    expect(reducedC?.content).toContain("... lines 181-1019 omitted ...");

    const reducedB = result.files.find((file) => file.path === "b.ts");
    expect(reducedB?.truncatedToHunks).toBe(true);
    expect(reducedB?.content).toContain("row 0200 of b.ts");
    expect(reducedB?.content).toContain("row 0120 of b.ts");
    expect(reducedB?.content).toContain("row 0280 of b.ts");
  });

  it("keeps +/-80 lines around each hunk in a reduced file", () => {
    const content = numberedFile("src/big.ts", 500);
    const diff = modifiedFileDiff("src/big.ts", 200);

    const result = applyTokenBudget(contextWith([content], diff), 1_500);
    const reduced = result.files.find((file) => file.path === "src/big.ts");

    expect(result.truncated).toEqual(["src/big.ts"]);
    expect(reduced?.truncatedToHunks).toBe(true);
    expect(reduced?.content).toContain("row 0120");
    expect(reduced?.content).toContain("row 0280");
    expect(reduced?.content).not.toContain("row 0119");
    expect(reduced?.content).not.toContain("row 0281");
  });

  it("drops reduced files entirely when they still do not fit", () => {
    const paths = ["a.ts", "b.ts"];
    const diff = paths.map((path) => modifiedFileDiff(path, 200)).join("");
    const files = [numberedFile("a.ts", 400), numberedFile("b.ts", 600)];

    const result = applyTokenBudget(contextWith(files, diff), 150);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
    expect(result.truncated).toEqual([]);
    expect(result.diff).toBe(diff);
    expect(result.overBudget).toBe(false);
  });

  it("counts the system prompt and the prompt wrappers against the budget", () => {
    const result = applyTokenBudget(
      contextWith([], "", { systemPromptChars: 4_000 }),
      500,
    );

    expect(result.estimatedTokens).toBeGreaterThan(1_000);
    expect(result.overBudget).toBe(true);
  });
});

describe("files whose windows cover their whole content", () => {
  const fixtureDir = fileURLToPath(new URL("./fixtures/local/", import.meta.url));

  it("drops the largest full file at --max-tokens 14000 and fits", async () => {
    const diff = await readFile(join(fixtureDir, "change.diff"), "utf8");
    const systemPromptChars = (await loadSystemPrompt()).length;

    const context = await buildContext(
      fakeRequest(diff, 14_000),
      async (path) => {
        try {
          return await readFile(join(fixtureDir, path), "utf8");
        } catch {
          return null;
        }
      },
      { systemPromptChars },
    );

    expect(context.overBudget).toBe(false);
    // Only the largest file has to go for 14,000; the 3-line file still fits.
    expect(context.skipped).toEqual(["package-lock.json", "src/cart.ts"]);
    expect(context.files.map((file) => file.path)).toEqual(["src/discount.ts"]);
    expect(context.estimatedTokens).toBeLessThanOrEqual(14_000);
    expect(context.diff).toBe(diff);
  });

  it("drops a 40k-line dense-hunk file whose +/-80 windows overlap", async () => {
    const totalLines = 40_000;
    const content = Array.from(
      { length: totalLines },
      (_value, index) => `row ${String(index + 1).padStart(5, "0")} of big.ts`,
    ).join("\n");
    const hunks: string[] = [];
    for (let start = 50; start <= totalLines - 50; start += 100) {
      hunks.push(
        `@@ -${start},1 +${start},1 @@`,
        `-old row ${start}`,
        `+new row ${start}`,
      );
    }
    const diff = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      ...hunks,
      "",
    ].join("\n");
    const systemPromptChars = (await loadSystemPrompt()).length;

    const context = await buildContext(
      fakeRequest(diff, 120_000),
      async (path) => (path === "big.ts" ? content : null),
      { systemPromptChars },
    );

    expect(context.overBudget).toBe(false);
    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["big.ts"]);
    expect(context.estimatedTokens).toBeLessThanOrEqual(120_000);
    expect(context.diff).toBe(diff);
  });
});

const READER: ReadFile = async (path) => {
  if (path === "src/app.ts") {
    return "export const answer = 42;\n";
  }
  if (path === "package-lock.json") {
    return '{ "lockfileVersion": 3 }\n';
  }
  if (path === "supabase/migrations/0001_init.sql") {
    return Array.from({ length: 600 }, (_value, index) => `-- line ${index + 1}`).join(
      "\n",
    );
  }
  if (path === "src/generated.ts") {
    return "// @generated by codegen\nexport const generated = true;\n";
  }
  if (path === "src/build/foo.ts") {
    return "export const built = true;\n";
  }
  return null;
};

const SKIP_DIFF = [
  addedFileDiff("src/app.ts", ["export const answer = 42;"]),
  addedFileDiff("package-lock.json", ['{ "lockfileVersion": 3 }']),
  addedFileDiff("supabase/migrations/0001_init.sql", ["-- init"]),
  addedFileDiff("src/generated.ts", ["// @generated by codegen"]),
  addedFileDiff("dist/bundle.js", ["console.log(1);"]),
  addedFileDiff("build/out.js", ["console.log(2);"]),
  addedFileDiff("src/thing.min.js", ["var a=1;"]),
  addedFileDiff("assets/logo.svg", ["<svg></svg>"]),
  addedFileDiff("src/build/foo.ts", ["export const built = true;"]),
].join("");

describe("buildContext", () => {
  it("skips lockfiles, generated files, images and large migration bodies but keeps their diff", async () => {
    const context = await buildContext(fakeRequest(SKIP_DIFF, 120_000), READER);

    expect(context.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "src/build/foo.ts",
    ]);
    expect(context.skipped).toEqual(
      expect.arrayContaining([
        "package-lock.json",
        "supabase/migrations/0001_init.sql",
        "src/generated.ts",
        "dist/bundle.js",
        "build/out.js",
        "src/thing.min.js",
        "assets/logo.svg",
      ]),
    );
    expect(context.truncated).toEqual([]);
    expect(context.diff).toBe(SKIP_DIFF);
    expect(context.changedLines.get("package-lock.json")?.get("RIGHT")?.size).toBe(1);
  });

  it("treats dist/, build/ and .next/ as generated only at the top level", async () => {
    const diff =
      addedFileDiff("src/build/keep.ts", ["export const kept = true;"]) +
      addedFileDiff("lib/dist/keep.ts", ["export const kept = true;"]) +
      addedFileDiff(".next/cache/x.js", ["cached();"]);
    const reader: ReadFile = async (path) =>
      path === "src/build/keep.ts" || path === "lib/dist/keep.ts"
        ? "export const kept = true;\n"
        : null;

    const context = await buildContext(fakeRequest(diff, 120_000), reader);

    expect(context.files.map((file) => file.path)).toEqual([
      "src/build/keep.ts",
      "lib/dist/keep.ts",
    ]);
    expect(context.skipped).toEqual([".next/cache/x.js"]);
  });

  it("skips deleted files but keeps their diff", async () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const gone = true;",
      "",
    ].join("\n");

    const context = await buildContext(fakeRequest(diff, 120_000), READER);

    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["src/gone.ts"]);
    expect(context.diff).toBe(diff);
  });

  it("marks a diff that alone exceeds the budget as overBudget instead of throwing", async () => {
    const lines = Array.from({ length: 2_000 }, (_value, index) => `line ${index + 1}`);
    const diff = addedFileDiff("src/huge.ts", lines);

    const context = await buildContext(fakeRequest(diff, 100), READER);

    expect(context.overBudget).toBe(true);
    expect(context.estimatedTokens).toBeGreaterThan(100);
    expect(context.diff).toBe(diff);
  });

  it("estimates tokens from the assembled prompt, not a char sum", async () => {
    const systemChars = (await loadSystemPrompt()).length;
    const diff = addedFileDiff("src/app.ts", ["export const answer = 42;"]);
    const context = await buildContext(fakeRequest(diff, 120_000), READER, {
      systemPromptChars: systemChars,
    });
    const prompt = await buildPrompt(context);

    expect(context.estimatedTokens).toBe(prompt.estimatedTokens);
    expect(prompt.estimatedTokens).toBe(
      Math.ceil((prompt.system.length + prompt.user.length) / 4),
    );
  });

  it("measures the system prompt when the caller does not pass its size", async () => {
    const diff = addedFileDiff("src/app.ts", ["export const answer = 42;"]);
    const context = await buildContext(fakeRequest(diff, 120_000), READER);
    const prompt = await buildPrompt(context);

    expect(context.systemPromptChars).toBe(prompt.system.length);
    expect(context.systemPromptChars).toBeGreaterThan(0);
    expect(context.estimatedTokens).toBe(prompt.estimatedTokens);

    const sicko = await buildContext(fakeRequest(diff, 120_000), READER, {
      commentSicko: true,
    });
    expect(sicko.systemPromptChars).toBe(
      (await loadSystemPrompt({ commentSicko: true })).length,
    );
  });

  it("keeps the assembled prompt within the budget when it is one token over", async () => {
    const systemChars = (await loadSystemPrompt()).length;
    const content = numberedFile("src/big.ts", 5_000);
    const diff = modifiedFileDiff("src/big.ts", 200);
    const reader: ReadFile = async (path) =>
      path === "src/big.ts" ? content.content : null;

    const roomy = await buildContext(fakeRequest(diff, 1_000_000), reader, {
      systemPromptChars: systemChars,
    });
    const baseline = (await buildPrompt(roomy)).estimatedTokens;
    expect(roomy.files).toHaveLength(1);

    const budget = baseline - 1;
    const context = await buildContext(fakeRequest(diff, budget), reader, {
      systemPromptChars: systemChars,
    });
    const prompt = await buildPrompt(context);

    expect(context.overBudget).toBe(false);
    expect(prompt.estimatedTokens).toBe(context.estimatedTokens);
    expect(prompt.estimatedTokens).toBeLessThanOrEqual(budget);
  });

  it("keeps the assembled prompt within the budget after dropping files", async () => {
    const systemChars = (await loadSystemPrompt()).length;
    const content = numberedFile("src/big.ts", 5_000);
    const diff = modifiedFileDiff("src/big.ts", 200);
    const reader: ReadFile = async (path) =>
      path === "src/big.ts" ? content.content : null;

    const budget = 13_900;
    const context = await buildContext(fakeRequest(diff, budget), reader, {
      systemPromptChars: systemChars,
    });
    const prompt = await buildPrompt(context);

    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["src/big.ts"]);
    expect(context.skipReasons?.["src/big.ts"]).toContain("dropped to fit");
    expect(context.overBudget).toBe(false);
    expect(prompt.estimatedTokens).toBe(context.estimatedTokens);
    expect(prompt.estimatedTokens).toBeLessThanOrEqual(budget);
  });

  it("caps 3000 skipped paths so the prompt still fits", async () => {
    const systemChars = (await loadSystemPrompt()).length;
    const diff = Array.from({ length: 3_000 }, (_value, index) =>
      addedFileDiff(`d/${index + 1}/package-lock.json`, ["{}"]),
    ).join("");

    const context = await buildContext(
      fakeRequest(diff, 150_000),
      async () => {
        throw new Error("lockfiles must not be read");
      },
      { systemPromptChars: systemChars },
    );
    const prompt = await buildPrompt(context);

    expect(context.skipped).toHaveLength(3_000);
    expect(context.overBudget).toBe(false);
    expect(prompt.estimatedTokens).toBe(context.estimatedTokens);
    expect(prompt.estimatedTokens).toBeLessThanOrEqual(150_000);
    expect(prompt.user).toContain("- and 2950 more");
    expect(prompt.user.match(/^- .*package-lock\.json/gm)).toHaveLength(50);
  });
});

describe("buildContext files with no new-side lines", () => {
  const HUGE = Array.from({ length: 100_000 }, (_value, index) => `line ${index + 1}`).join(
    "\n",
  );

  async function noNewSide(diff: string, path: string) {
    const reads: string[] = [];
    const context = await buildContext(fakeRequest(diff, 120_000), async (candidate) => {
      reads.push(candidate);
      return candidate === path ? HUGE : null;
    });
    return { context, reads };
  }

  it("leaves out a 100,000-line pure rename at the default budget", async () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");

    const { context, reads } = await noNewSide(diff, "new.ts");

    expect(context.overBudget).toBe(false);
    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["new.ts"]);
    expect(context.skipReasons?.["new.ts"]).toContain("no new-side");
    expect(context.estimatedTokens).toBeLessThanOrEqual(120_000);
    expect(reads).toEqual([]);
  });

  it("leaves out a large mode-only file at the default budget", async () => {
    const diff = [
      "diff --git a/mode.ts b/mode.ts",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    const { context, reads } = await noNewSide(diff, "mode.ts");

    expect(context.overBudget).toBe(false);
    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["mode.ts"]);
    expect(context.skipReasons?.["mode.ts"]).toContain("no new-side");
    expect(context.estimatedTokens).toBeLessThanOrEqual(120_000);
    expect(reads).toEqual([]);
  });

  it("leaves out a +0,0 deletion-only hunk", async () => {
    const diff = [
      "diff --git a/empty.ts b/empty.ts",
      "--- a/empty.ts",
      "+++ b/empty.ts",
      "@@ -1,2 +0,0 @@",
      "-gone one",
      "-gone two",
      "",
    ].join("\n");

    const { context } = await noNewSide(diff, "empty.ts");

    expect(context.overBudget).toBe(false);
    expect(context.files).toEqual([]);
    expect(context.skipped).toEqual(["empty.ts"]);
  });
});

describe("selectModel", () => {
  it("uses the normal model under both thresholds", () => {
    expect(
      selectModel({
        model: "normal/model",
        bigPrModel: "big/model",
        changedLines: 1_500,
        overBudget: false,
      }),
    ).toEqual({ model: "normal/model" });
  });

  it("uses big_pr_model over 1,500 changed lines", () => {
    expect(
      selectModel({
        model: "normal/model",
        bigPrModel: "big/model",
        changedLines: 1_501,
        overBudget: false,
      }),
    ).toEqual({ model: "big/model" });
  });

  it("uses big_pr_model when over budget", () => {
    expect(
      selectModel({
        model: "normal/model",
        bigPrModel: "big/model",
        changedLines: 10,
        overBudget: true,
      }),
    ).toEqual({ model: "big/model" });
  });

  it("skips when over budget with no big_pr_model", () => {
    expect(
      selectModel({
        model: "normal/model",
        changedLines: 10,
        overBudget: true,
      }),
    ).toEqual({ skip: "budget overflow, no big_pr_model set" });
  });

  it("skips over 1,500 lines with no big_pr_model", () => {
    expect(
      selectModel({
        model: "normal/model",
        bigPrModel: "  ",
        changedLines: 1_501,
        overBudget: false,
      }),
    ).toEqual({ skip: "big PR over 1500 changed lines, no big_pr_model set" });
  });
});

describe("hunkContextsFromDiff", () => {
  it("returns side ranges and the hunk header context text", () => {
    const diff = [
      "diff --git a/src/order.ts b/src/order.ts",
      "--- a/src/order.ts",
      "+++ b/src/order.ts",
      "@@ -23,2 +23,3 @@ export interface Order {",
      " context",
      "-old",
      "+new",
      "+extra",
      "",
    ].join("\n");

    expect(hunkContextsFromDiff(diff).get("src/order.ts")).toEqual([
      {
        side: "RIGHT",
        start: 23,
        end: 25,
        context: "export interface Order {",
      },
      {
        side: "LEFT",
        start: 23,
        end: 24,
        context: "export interface Order {",
      },
    ]);
  });

  it("translates a compare hunk that starts inside the PR hunk (N3 offset)", () => {
    const prDiff = [
      "diff --git a/src/order.ts b/src/order.ts",
      "--- a/src/order.ts",
      "+++ b/src/order.ts",
      "@@ -1,4 +1,4 @@",
      " a",
      " b",
      "-c",
      "+C",
      " d",
      "",
    ].join("\n");
    const compareDiff = [
      "diff --git a/src/order.ts b/src/order.ts",
      "--- a/src/order.ts",
      "+++ b/src/order.ts",
      "@@ -3,2 +3,2 @@",
      " b",
      "-c",
      "+C",
      "",
    ].join("\n");

    expect(hunkContextsFromDiff(compareDiff, prDiff).get("src/order.ts")).toEqual([
      { side: "RIGHT", start: 3, end: 4, context: "" },
      { side: "LEFT", start: 3, end: 4, context: "" },
    ]);
  });

  it("returns an empty context when the header has none", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "",
    ].join("\n");

    expect(hunkContextsFromDiff(diff).get("src/a.ts")?.[0]?.context).toBe("");
  });
});

describe("comment-sicko in the budget", () => {
  it("measures the same prompt buildPrompt assembles", async () => {
    const diff = addedFileDiff("src/app.ts", ["export const answer = 42;"]);
    const context = await buildContext(fakeRequest(diff, 120_000), READER, {
      commentSicko: true,
    });
    const prompt = await buildPrompt(context, { commentSicko: true });

    expect(context.systemPromptChars).toBe(prompt.system.length);
    expect(context.estimatedTokens).toBe(prompt.estimatedTokens);
  });
});

describe("diffLineTexts", () => {
  it("keeps added, deleted and context lines on their own side and path (S8D-R2-N5)", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -4,3 +5,3 @@",
      " context old",
      "-deleted",
      "+added",
      " tail",
      "",
    ].join("\n");
    const lineText = diffLineTexts(diff);

    // Hunk starts at old line 4 and new line 5.
    expect(lineText("src/a.ts", 4, "LEFT")).toBe("context old");
    expect(lineText("src/a.ts", 5, "RIGHT")).toBe("context old");
    expect(lineText("src/a.ts", 5, "LEFT")).toBe("deleted");
    expect(lineText("src/a.ts", 5, "RIGHT")).toBe("context old");
    expect(lineText("src/a.ts", 6, "RIGHT")).toBe("added");
    expect(lineText("src/a.ts", 6, "LEFT")).toBe("tail");
    expect(lineText("src/a.ts", 7, "RIGHT")).toBe("tail");

    // A line the diff does not carry, a side it does not carry, and another
    // file all read undefined rather than throwing.
    expect(lineText("src/a.ts", 8, "RIGHT")).toBeUndefined();
    expect(lineText("src/missing.ts", 5, "RIGHT")).toBeUndefined();
  });
});
