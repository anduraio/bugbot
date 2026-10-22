import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { review, runLocalReview } from "../src/cli.js";
import type { FetchLike } from "../src/model.js";
import { loadSystemPrompt } from "../src/prompt.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/local/", import.meta.url));
const modelResponse = readFileSync(
  join(fixtureDir, "model-response.json"),
  "utf8",
);

function envWith(values: Record<string, string>): (name: string) => string {
  return (name) => values[name] ?? "";
}

function addedDiff(path: string, content = "placeholder"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1 @@",
    `+${content}`,
    "",
  ].join("\n");
}

/** Runs a local review with a fake fetch and returns the sent request bodies. */
async function reviewWithBodies(
  diffPath: string,
  repoDir: string,
): Promise<{ bodies: string[]; skipped: readonly string[] }> {
  const bodies: string[] = [];
  const result = await runLocalReview(
    { diffPath, repoDir },
    {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response(modelResponse, { status: 200 });
      },
      env: envWith({ OPENROUTER_API_KEY: "test-key" }),
      log: () => undefined,
    },
  );

  return { bodies, skipped: result.skipped };
}

function cartFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/cart.ts",
    line: 48,
    side: "RIGHT",
    severity: "high",
    category: "bug",
    confidence: 0.95,
    reason:
      "findCustomer returns undefined for an unknown customerId, and customer.name then throws.",
    suggested_fix: "Guard the lookup.",
    angle: "interrogate:correctness",
    symbol: "cartOwnerName",
    ...overrides,
  };
}

function responseWithFindings(findings: readonly unknown[]): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ findings }),
          },
        },
      ],
    }),
    { status: 200 },
  );
}

function reviewFindings(findings: readonly unknown[]) {
  return runLocalReview(
    { diffPath: join(fixtureDir, "change.diff"), repoDir: fixtureDir },
    {
      fetch: async () => responseWithFindings(findings),
      env: envWith({ OPENROUTER_API_KEY: "test-key" }),
      log: () => undefined,
    },
  );
}

describe("runLocalReview", () => {
  it("returns one valid finding and reports one dropped with a fake fetch", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      calls += 1;
      bodies.push(String(init?.body));
      return new Response(modelResponse, { status: 200 });
    };
    const lines: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
      },
      {
        fetch: fakeFetch,
        env: envWith({ OPENROUTER_API_KEY: "test-key" }),
        log: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(4);
    expect(result.findings[0]?.file).toBe("src/cart.ts");
    expect(result.findings[0]?.line).toBe(48);
    expect(result.dropped.count).toBe(1);
    expect(result.tokensIn).toBe(4_321);
    expect(result.tokensOut).toBe(210);
    expect(calls).toBe(1);

    // The dismissed medium finding is summarized; the dismissed high finding
    // survives the safety override and is a different bug two lines from 48,
    // so S8D-B1 keeps both; the lower-confidence repeat dedupes by hash.
    expect(result.planned.map((comment) => `${comment.file}:${comment.line}`)).toEqual([
      "src/cart.ts:48",
      "src/cart.ts:46",
    ]);
    expect(result.planned[0]?.symbol).toBe("cartOwnerName");
    expect(result.summary).toEqual({
      posted: 2,
      belowConfidence: 0,
      lowSeverity: 0,
      notInDiff: 0,
      triageDismissed: 1,
      duplicate: 1,
      overCap: 0,
      outOfScope: 0,
      schemaInvalid: 1,
    });
    expect(result.existing).toEqual([]);

    const sent = bodies[0] ?? "";
    expect(sent).toContain("<file path=\\\"src/cart.ts\\\">");
    expect(sent).not.toContain("<file path=\\\"package-lock.json\\\">");

    const output = lines.join("\n");
    expect(output).toContain('"findings"');
    expect(output).toContain('"triage"');
    expect(output).toContain('"tokens_in": 4321');
    expect(output).toContain('"tokens_out": 210');
    expect(output).toContain("Planned comments: 2");
    expect(output).toContain(
      `- src/cart.ts:48 RIGHT high ${result.planned[0]?.hash.slice(0, 12)}`,
    );
    expect(output).toContain(
      "Summary: posted=2 belowConfidence=0 lowSeverity=0 notInDiff=0 triageDismissed=1 duplicate=1 overCap=0 schemaInvalid=1",
    );
    expect(output).toContain("Existing tokens: (none)");
  });

  it("applies BUGBOT_COMMENT_SICKO when --comment-sicko is not passed", async () => {
    const bodies: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
      },
      {
        fetch: async (_input, init) => {
          bodies.push(String(init?.body));
          return new Response(modelResponse, { status: 200 });
        },
        env: envWith({
          OPENROUTER_API_KEY: "test-key",
          BUGBOT_COMMENT_SICKO: "true",
        }),
        log: () => undefined,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(bodies[0]).toContain("## prompts/comment-sicko.md");
  });

  it("builds and measures the prompt with the same comment-sicko setting", async () => {
    const lines: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
        printPrompt: true,
      },
      {
        env: envWith({ BUGBOT_COMMENT_SICKO: "true" }),
        log: (line) => lines.push(line),
      },
    );

    const output = lines.join("\n");
    const systemChars = Number(/System prompt: (\d+) chars/.exec(output)?.[1]);
    const userChars = Number(/User message: (\d+) chars/.exec(output)?.[1]);
    const withSicko = (await loadSystemPrompt({ commentSicko: true })).length;

    expect(systemChars).toBe(withSicko);
    expect(result.estimatedTokens).toBe(
      Math.ceil((systemChars + userChars) / 4),
    );
  });

  it("honors BUGBOT_MIN_CONFIDENCE and falls back to 0.8 for garbage", async () => {
    const runWith = async (value: string) =>
      runLocalReview(
        {
          diffPath: join(fixtureDir, "change.diff"),
          repoDir: fixtureDir,
        },
        {
          fetch: async () => new Response(modelResponse, { status: 200 }),
          env: envWith({
            OPENROUTER_API_KEY: "test-key",
            BUGBOT_MIN_CONFIDENCE: value,
          }),
          log: () => undefined,
        },
      );

    const strict = await runWith("0.99");
    expect(strict.planned).toHaveLength(0);
    expect(strict.summary.belowConfidence).toBe(4);

    for (const garbage of ["abc", "-1", "2", "0.1 "]) {
      const result = await runWith(garbage);
      expect(result.summary.posted, garbage).toBe(2);
      expect(result.summary.belowConfidence, garbage).toBe(0);
    }
  });

  it("prints prompt sizes without a key or a fetch", async () => {
    let calls = 0;
    const lines: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
        printPrompt: true,
      },
      {
        fetch: async () => {
          calls += 1;
          throw new Error("fetch must not be called");
        },
        env: envWith({}),
        log: (line) => lines.push(line),
      },
    );

    const output = lines.join("\n");
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(0);
    expect(output).toContain("Estimated tokens:");
    expect(output).toContain("Skipped files: package-lock.json");
    expect(output).toContain("Truncated files: (none)");
    expect(output).toMatch(/System prompt: \d+ chars/);
    expect(output).toMatch(/User message: \d+ chars/);
    expect(result.skipped).toContain("package-lock.json");
  });

  it("fails with a safe message and no fetch when the key is missing", async () => {
    let calls = 0;
    const lines: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
      },
      {
        fetch: async () => {
          calls += 1;
          return new Response(modelResponse, { status: 200 });
        },
        env: envWith({}),
        log: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toBe(0);
    expect(lines.join("\n")).toContain(
      "Bugbot couldn't review: OPENROUTER_API_KEY is not set",
    );
  });

  it("keeps a successful call's usage when the reply fails to parse (F23-RV1-B1)", async () => {
    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
      },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: JSON.stringify({ nope: 1 }),
                  },
                },
              ],
              usage: { prompt_tokens: 123, completion_tokens: 45 },
            }),
            { status: 200 },
          ),
        env: envWith({ OPENROUTER_API_KEY: "test-key" }),
        log: () => undefined,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(0);
    // The parse error carries no usage; the successful call's usage stays.
    expect(result.tokensIn).toBe(123);
    expect(result.tokensOut).toBe(45);
  });

  it("rejects an out-of-range max_output_tokens before any model call (F23-RV1-N4)", async () => {
    let calls = 0;
    const lines: string[] = [];

    const result = await runLocalReview(
      {
        diffPath: join(fixtureDir, "change.diff"),
        repoDir: fixtureDir,
      },
      {
        fetch: async () => {
          calls += 1;
          return new Response(modelResponse, { status: 200 });
        },
        env: envWith({
          OPENROUTER_API_KEY: "test-key",
          BUGBOT_MAX_OUTPUT_TOKENS: "0",
        }),
        log: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toBe(0);
    expect(result.tokensIn).toBe(0);
    expect(lines.join("\n")).toContain(
      "Bugbot couldn't review: BUGBOT_MAX_OUTPUT_TOKENS must be a whole number from 1000 to 64000",
    );
  });

  it("refuses paths that try to leave the repo dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-local-"));
    const lines: string[] = [];

    try {
      await writeFile(join(root, "secret.txt"), "do not read this", "utf8");
      const diffPath = join(root, "escape.diff");
      await writeFile(
        diffPath,
        [
          "diff --git a/../secret.txt b/../secret.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/../secret.txt",
          "@@ -0,0 +1 @@",
          "+do not read this",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runLocalReview(
        {
          diffPath,
          repoDir: join(root, "missing-repo"),
          printPrompt: true,
        },
        { env: envWith({}), log: (line) => lines.push(line) },
      );

      expect(result.exitCode).toBe(0);
      expect(lines.join("\n")).toContain("../secret.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never reads a symlinked directory outside the repo dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-symlink-dir-"));
    const outside = await mkdtemp(join(tmpdir(), "bugbot-outside-dir-"));

    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(outside, "secret.txt"), "TOP-SECRET-DIR-MARKER", "utf8");
      await symlink(outside, join(repo, "leakdir"), "dir");

      const diffPath = join(root, "change.diff");
      await writeFile(diffPath, addedDiff("leakdir/secret.txt"), "utf8");

      const { bodies, skipped } = await reviewWithBodies(diffPath, repo);

      expect(skipped).toContain("leakdir/secret.txt");
      expect(bodies.join("\n")).not.toContain("TOP-SECRET-DIR-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never reads a symlinked file outside the repo dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-symlink-file-"));
    const outside = await mkdtemp(join(tmpdir(), "bugbot-outside-file-"));

    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(outside, "secret.txt"), "TOP-SECRET-FILE-MARKER", "utf8");
      await symlink(join(outside, "secret.txt"), join(repo, "leakfile"), "file");

      const diffPath = join(root, "change.diff");
      await writeFile(diffPath, addedDiff("leakfile"), "utf8");

      const { bodies, skipped } = await reviewWithBodies(diffPath, repo);

      expect(skipped).toContain("leakfile");
      expect(bodies.join("\n")).not.toContain("TOP-SECRET-FILE-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never reads an absolute path outside the repo dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-absolute-"));
    const outside = await mkdtemp(join(tmpdir(), "bugbot-outside-abs-"));

    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      const absolute = join(outside, "secret.txt");
      await writeFile(absolute, "TOP-SECRET-ABS-MARKER", "utf8");

      const diffPath = join(root, "change.diff");
      await writeFile(
        diffPath,
        [
          "diff --git a/absolute b/absolute",
          "new file mode 100644",
          "--- /dev/null",
          `+++ ${absolute}`,
          "@@ -0,0 +1 @@",
          "+placeholder",
          "",
        ].join("\n"),
        "utf8",
      );

      const { bodies, skipped } = await reviewWithBodies(diffPath, repo);

      expect(skipped).toContain(absolute);
      expect(bodies.join("\n")).not.toContain("TOP-SECRET-ABS-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("never reads an AGENTS.md symlink outside the repo dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-agents-"));
    const outside = await mkdtemp(join(tmpdir(), "bugbot-outside-agents-"));

    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(outside, "AGENTS.md"), "TOP-SECRET-AGENTS-MARKER", "utf8");
      await symlink(join(outside, "AGENTS.md"), join(repo, "AGENTS.md"), "file");

      const diffPath = join(root, "change.diff");
      await writeFile(diffPath, addedDiff("src/missing.ts"), "utf8");

      const { bodies } = await reviewWithBodies(diffPath, repo);

      expect(bodies.join("\n")).not.toContain("TOP-SECRET-AGENTS-MARKER");
      expect(bodies.join("\n")).toContain("(no AGENTS.md)");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a Unix filename that contains a backslash", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-backslash-"));

    try {
      const repo = join(root, "repo");
      await mkdir(repo);
      await writeFile(join(repo, "back\\slash.txt"), "one\nBACKSLASH-MARKER\n", "utf8");

      const diffPath = join(root, "change.diff");
      await writeFile(
        diffPath,
        [
          'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
          "new file mode 100644",
          "--- /dev/null",
          '+++ "b/back\\\\slash.txt"',
          "@@ -0,0 +1,2 @@",
          "+one",
          "+BACKSLASH-MARKER",
          "",
        ].join("\n"),
        "utf8",
      );

      const { bodies, skipped } = await reviewWithBodies(diffPath, repo);

      expect(skipped).not.toContain("back\\slash.txt");
      expect(bodies.join("\n")).toContain("BACKSLASH-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads paths whose names start with two dots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-dotdot-"));

    try {
      const repo = join(root, "repo");
      await mkdir(join(repo, "..cache"), { recursive: true });
      await writeFile(join(repo, "..foo"), "DOTFOO-MARKER", "utf8");
      await writeFile(join(repo, "..cache/x.txt"), "DOTCACHE-MARKER", "utf8");

      const diffPath = join(root, "change.diff");
      await writeFile(
        diffPath,
        addedDiff("..foo", "DOTFOO-MARKER") +
          addedDiff("..cache/x.txt", "DOTCACHE-MARKER"),
        "utf8",
      );

      const { bodies, skipped } = await reviewWithBodies(diffPath, repo);

      expect(skipped).not.toContain("..foo");
      expect(skipped).not.toContain("..cache/x.txt");
      expect(bodies.join("\n")).toContain("DOTFOO-MARKER");
      expect(bodies.join("\n")).toContain("DOTCACHE-MARKER");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes --local output to stdout only, never to GITHUB_STEP_SUMMARY", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugbot-summary-"));
    const summaryPath = join(root, "summary.md");
    const previous = process.env.GITHUB_STEP_SUMMARY;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await writeFile(summaryPath, "", "utf8");
      process.env.GITHUB_STEP_SUMMARY = summaryPath;

      const code = await review([
        "--local",
        "--diff",
        join(fixtureDir, "change.diff"),
        "--repo-dir",
        fixtureDir,
        "--print-prompt",
      ]);

      expect(code).toBe(0);
      expect(log).toHaveBeenCalled();
      expect(await readFile(summaryPath, "utf8")).toBe("");
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = previous;
      }
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fail-safe field normalization through runLocalReview", () => {
  it("never dismisses high, security or data findings with every malformed triage value", async () => {
    const triages: unknown[] = ["DISMISS", "dismiss ", "skip", null, 3];
    const findings: unknown[] = [];

    for (const [index, triage] of triages.entries()) {
      findings.push(
        cartFinding({ triage, reason: `High bug ${index}.` }),
        cartFinding({
          severity: "medium",
          category: "security",
          triage,
          reason: `Security bug ${index}.`,
        }),
        cartFinding({
          severity: "medium",
          category: "data",
          triage,
          reason: `Data bug ${index}.`,
        }),
      );
    }

    const result = await reviewFindings(findings);

    expect(result.exitCode).toBe(0);
    expect(result.dropped.count).toBe(0);
    expect(result.findings).toHaveLength(15);
    // Every category survives the malformed dismiss values. The five copies
    // of each category share F:48, so step 8c keeps one per category.
    expect(result.planned).toHaveLength(3);
    expect(result.summary.duplicate).toBe(12);
    expect(result.summary.triageDismissed).toBe(0);
  });

  it("posts mixed-case severity and category after normalizing them", async () => {
    const result = await reviewFindings([
      cartFinding({ severity: "HIGH", reason: "Mixed case severity." }),
      cartFinding({
        severity: "medium",
        category: "Security",
        reason: "Mixed case category.",
      }),
    ]);

    expect(result.dropped.count).toBe(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.severity).toBe("high");
    expect(result.findings[1]?.category).toBe("security");
    expect(result.planned).toHaveLength(2);
  });

  it("counts a medium bug with mixed-case Dismiss as triageDismissed", async () => {
    const result = await reviewFindings([
      cartFinding({ severity: "medium", triage: "Dismiss", reason: "Naming only." }),
    ]);

    expect(result.dropped.count).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.planned).toHaveLength(0);
    expect(result.summary.triageDismissed).toBe(1);
  });

  it("maps skip to dismiss and a non-string triage to fix", async () => {
    const skipped = await reviewFindings([
      cartFinding({ severity: "medium", triage: "skip", reason: "Medium skip." }),
    ]);
    expect(skipped.planned).toHaveLength(0);
    expect(skipped.summary.triageDismissed).toBe(1);

    const fixed = await reviewFindings([
      cartFinding({ severity: "medium", triage: 3, reason: "Medium numeric triage." }),
    ]);
    expect(fixed.planned).toHaveLength(1);
    expect(fixed.summary.triageDismissed).toBe(0);
  });

  it("ignores dismiss on a coerced category but not on a real bug (R2-N1)", async () => {
    const misspelled = await reviewFindings([
      cartFinding({
        severity: "medium",
        category: "securty",
        triage: "dismiss",
        reason: "Misspelled security category.",
      }),
    ]);

    expect(misspelled.dropped.count).toBe(0);
    expect(misspelled.findings).toHaveLength(1);
    expect(misspelled.findings[0]?.category).toBe("bug");
    expect(misspelled.planned).toHaveLength(1);
    expect(misspelled.summary.triageDismissed).toBe(0);

    const realBug = await reviewFindings([
      cartFinding({
        severity: "medium",
        category: "bug",
        triage: "dismiss",
        reason: "A real medium bug.",
      }),
    ]);

    expect(realBug.findings).toHaveLength(1);
    expect(realBug.planned).toHaveLength(0);
    expect(realBug.summary.triageDismissed).toBe(1);
  });

  it("strips categoryCoerced from the printed JSON but keeps the safe behaviour (R3-N5)", async () => {
    const lines: string[] = [];
    const result = await runLocalReview(
      { diffPath: join(fixtureDir, "change.diff"), repoDir: fixtureDir },
      {
        fetch: async () =>
          responseWithFindings([
            cartFinding({
              severity: "medium",
              category: "securty",
              triage: "dismiss",
              reason: "Misspelled security category.",
            }),
          ]),
        env: envWith({ OPENROUTER_API_KEY: "test-key" }),
        log: (line) => lines.push(line),
      },
    );

    // The coercion still ignores `dismiss`, so the finding posts.
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0]?.category).toBe("bug");

    const printed = lines.find((line) => line.trimStart().startsWith("{"));
    expect(printed).toBeDefined();
    const parsed = JSON.parse(printed ?? "") as {
      findings: Array<Record<string, unknown>>;
    };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).not.toHaveProperty("categoryCoerced");
  });
});
