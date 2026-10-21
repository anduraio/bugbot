import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { review, runLocalReview } from "../src/cli.js";
import type { FetchLike } from "../src/model.js";

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
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("src/cart.ts");
    expect(result.findings[0]?.line).toBe(48);
    expect(result.dropped.count).toBe(1);
    expect(result.tokensIn).toBe(4_321);
    expect(result.tokensOut).toBe(210);
    expect(calls).toBe(1);

    const sent = bodies[0] ?? "";
    expect(sent).toContain("<file path=\\\"src/cart.ts\\\">");
    expect(sent).not.toContain("<file path=\\\"package-lock.json\\\">");

    const output = lines.join("\n");
    expect(output).toContain('"findings"');
    expect(output).toContain('"tokens_in": 4321');
    expect(output).toContain('"tokens_out": 210');
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
