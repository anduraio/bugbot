import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GhError,
  execFileGh,
  parseJsonPages,
  parsePullSpec,
  runRemoteReview,
  runStatus,
  type GhRunner,
} from "../src/gh.js";
import {
  HARNESS_PATHS,
  runInstallSkill,
  skillDestination,
  skillSourcePath,
} from "../src/skill.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA7 = "0123456";
const PR_URL = "https://github.com/o/r/pull/12";

const SUMMARY = [
  "<!-- bugbot:summary -->",
  "## Bugbot review",
  "",
  "- Passes: 2",
  "- Model: deepseek/test",
  "- Tokens: 10 in / 20 out",
  "- Posted this pass: 1",
  "- Open Bugbot comments: 3",
  "- Failed to post: 0",
  "- Skipped: 1 duplicate, 2 out of scope",
  "- Marked fixed this pass: 4",
  "",
  "Bugbot only comments; it never approves or blocks.",
].join("\n");

function summaryComment(body = SUMMARY, login = "andura-bugbot[bot]") {
  return { id: 1, user: { login }, body };
}

interface FakeGh {
  readonly gh: GhRunner;
  readonly calls: string[][];
  readonly argvShapes: unknown[];
}

function fakeGh(
  handler: (args: readonly string[]) => { stdout: string; stderr?: string },
): FakeGh {
  const calls: string[][] = [];
  const argvShapes: unknown[] = [];
  const gh: GhRunner = async (args) => {
    argvShapes.push(args);
    calls.push([...args]);
    const result = handler(args);
    return { stdout: result.stdout, stderr: result.stderr ?? "" };
  };
  return { gh, calls, argvShapes };
}

function reviewGh(
  prView: unknown = { headRefName: "feature/x", isCrossRepository: false },
): FakeGh {
  return fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return { stdout: JSON.stringify(prView) };
    }
    return { stdout: "" };
  });
}

const CHECK_RUNS_ARGS = [
  "api",
  `repos/o/r/commits/${SHA}/check-runs` +
    "?check_name=bugbot&filter=all&per_page=100",
];

const RUN_LIST_ARGS = [
  "run",
  "list",
  "-R",
  "o/r",
  "--commit",
  SHA,
  "--limit",
  "100",
  "--json",
  "status,name,workflowName",
];

function statusGh(options: {
  readonly checkRuns?: unknown;
  readonly runs?: unknown;
  readonly comments?: unknown;
  readonly commentsText?: string;
  readonly prView?: unknown;
}): FakeGh {
  return fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify(
          options.prView ?? { headRefOid: SHA, url: PR_URL },
        ),
      };
    }
    if (args[0] === "api" && args[1]?.includes("/check-runs")) {
      return {
        stdout: JSON.stringify(
          options.checkRuns ?? { total_count: 0, check_runs: [] },
        ),
      };
    }
    if (args[0] === "run" && args[1] === "list") {
      return { stdout: JSON.stringify(options.runs ?? []) };
    }
    if (args[0] === "api" && args[1]?.includes("/comments")) {
      if (options.commentsText !== undefined) {
        return { stdout: options.commentsText };
      }
      return { stdout: JSON.stringify(options.comments ?? []) };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  });
}

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bb-skill-home-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("pull request argument", () => {
  it("accepts a GitHub pull request URL", () => {
    expect(parsePullSpec(PR_URL)).toEqual({ owner: "o", repo: "r", number: 12 });
  });

  it("accepts owner/repo#number", () => {
    expect(parsePullSpec("o/r#12")).toEqual({
      owner: "o",
      repo: "r",
      number: 12,
    });
  });

  it("accepts a bare number and needs --repo for the repository", () => {
    expect(parsePullSpec("12")).toEqual({ number: 12 });
    expect(parsePullSpec("12", "o/r")).toEqual({
      owner: "o",
      repo: "r",
      number: 12,
    });
  });

  it("rejects bad arguments including shell text, spaces and ..", () => {
    for (const bad of [
      "o/r#12; rm -rf /",
      "o/r #12",
      "o/../r#12",
      "../r#12",
      "https://github.com/o/../r/pull/12",
      "https://example.com/o/r/pull/12",
      "o/r#0",
      "12 --repo",
      "0",
      "o/r#9007199254740993",
      "https://github.com/o/r/pull/9007199254740993",
    ]) {
      expect(() => parsePullSpec(bad), bad).toThrow(/invalid pull request/);
    }
    expect(() => parsePullSpec("12", "../r")).toThrow(/invalid pull request/);
    expect(() => parsePullSpec("12", "o/r;id")).toThrow(/invalid pull request/);
    expect(() => parsePullSpec("9007199254740993", "o/r")).toThrow(
      /invalid pull request/,
    );
  });
});

describe("review <pr>", () => {
  it("calls gh workflow run with an argv array and nothing else", async () => {
    const fake = reviewGh();
    const lines: string[] = [];

    const code = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(fake.calls).toEqual([
      [
        "pr",
        "view",
        "12",
        "-R",
        "o/r",
        "--json",
        "headRefName,isCrossRepository",
      ],
      [
        "workflow",
        "run",
        "bugbot.yml",
        "-R",
        "o/r",
        "--ref",
        "feature/x",
        "-f",
        "pr=12",
      ],
    ]);
    expect(fake.argvShapes[0]).toEqual(
      expect.any(Array),
    );
    expect(lines.join("\n")).toContain("requested a review");
    expect(lines.join("\n")).toContain("bugbot status o/r#12");
  });

  it("accepts the URL form", async () => {
    const fake = reviewGh();
    const code = await runRemoteReview([PR_URL], { gh: fake.gh, log: () => {}, error: () => {} });

    expect(code).toBe(0);
    expect(fake.calls[1]).toEqual([
      "workflow",
      "run",
      "bugbot.yml",
      "-R",
      "o/r",
      "--ref",
      "feature/x",
      "-f",
      "pr=12",
    ]);
  });

  it("resolves a bare number with gh repo view before dispatching", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "repo") {
        return { stdout: JSON.stringify({ nameWithOwner: "o/r" }) };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feature/x",
            isCrossRepository: false,
          }),
        };
      }
      return { stdout: "" };
    });

    const code = await runRemoteReview(["12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(0);
    expect(fake.calls).toEqual([
      ["repo", "view", "--json", "nameWithOwner"],
      [
        "pr",
        "view",
        "12",
        "-R",
        "o/r",
        "--json",
        "headRefName,isCrossRepository",
      ],
      [
        "workflow",
        "run",
        "bugbot.yml",
        "-R",
        "o/r",
        "--ref",
        "feature/x",
        "-f",
        "pr=12",
      ],
    ]);
  });

  it("honors --workflow", async () => {
    const fake = reviewGh();
    const code = await runRemoteReview(
      ["--workflow", "custom.yaml", "--repo", "o/r", "12"],
      { gh: fake.gh, log: () => {}, error: () => {} },
    );

    expect(code).toBe(0);
    expect(fake.calls[1]).toEqual([
      "workflow",
      "run",
      "custom.yaml",
      "-R",
      "o/r",
      "--ref",
      "feature/x",
      "-f",
      "pr=12",
    ]);
  });

  it("dispatches on the PR head branch so status can find the run (B1)", async () => {
    const fake = reviewGh({
      headRefName: "bugbot/step-10",
      isCrossRepository: false,
    });
    const lines: string[] = [];

    const code = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(fake.calls[1]).toEqual([
      "workflow",
      "run",
      "bugbot.yml",
      "-R",
      "o/r",
      "--ref",
      "bugbot/step-10",
      "-f",
      "pr=12",
    ]);
    expect(lines.join("\n")).toContain("bugbot/step-10");
  });

  it("refuses a fork pull request before dispatching (B1)", async () => {
    const fake = reviewGh({
      headRefName: "feature/x",
      isCrossRepository: true,
    });
    const errors: string[] = [];

    const code = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(fake.calls.some((call) => call[0] === "workflow")).toBe(false);
    expect(errors.join("\n")).toContain("fork");
    expect(errors.join("\n")).toContain("Nothing was started");
  });

  it("refuses an unusable head branch before dispatching (B1)", async () => {
    for (const prView of [
      { headRefName: "-r.yml", isCrossRepository: false },
      { headRefName: "", isCrossRepository: false },
      { headRefName: "feature/x", isCrossRepository: "no" },
      {},
    ]) {
      const fake = reviewGh(prView);
      const errors: string[] = [];

      const code = await runRemoteReview(["o/r#12"], {
        gh: fake.gh,
        log: () => {},
        error: (line) => errors.push(line),
      });

      expect(code, JSON.stringify(prView)).toBe(1);
      expect(fake.calls.some((call) => call[0] === "workflow")).toBe(false);
      expect(errors.join("\n")).toContain("could not start a review");
    }
  });

  it("rejects workflow names that gh could read as a flag (B3)", async () => {
    for (const workflow of [
      "-r.yml",
      "-R.yml",
      "-f.yml",
      "--ref.yml",
      ".yml",
      "x.yml;id",
      "../bugbot.yml",
      "bugbot.yml ",
    ]) {
      const fake = reviewGh();
      const errors: string[] = [];

      const code = await runRemoteReview(
        ["--workflow", workflow, "--repo", "o/r", "12"],
        { gh: fake.gh, log: () => {}, error: (line) => errors.push(line) },
      );

      expect(code, workflow).toBe(1);
      expect(fake.calls, workflow).toEqual([]);
      expect(errors.join("\n")).toContain("invalid workflow file");
    }
  });

  it("rejects a --repo value that gh could read as a flag (M18)", async () => {
    const fake = reviewGh();
    const errors: string[] = [];

    const code = await runRemoteReview(["o/r#12", "--repo", "-x"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(errors.join("\n")).toContain("--repo");
  });

  it("status finds the run that review started (B1)", async () => {
    let dispatchedOn: string | null = null;
    const fake = fakeGh((args) => {
      const valueAfter = (flag: string): string | null => {
        const index = args.indexOf(flag);
        return index >= 0 ? (args[index + 1] ?? null) : null;
      };

      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feature/x",
            headRefOid: SHA,
            isCrossRepository: false,
            url: PR_URL,
          }),
        };
      }
      if (args[0] === "workflow" && args[1] === "run") {
        dispatchedOn = valueAfter("--ref");
        return { stdout: "" };
      }
      if (args[0] === "api" && args[1]?.includes("/check-runs")) {
        return { stdout: JSON.stringify({ total_count: 0, check_runs: [] }) };
      }
      if (args[0] === "api" && args[1]?.includes("/comments")) {
        return { stdout: "[]" };
      }
      if (args[0] === "run" && args[1] === "list") {
        // A dispatched run's head_sha is the tip of the dispatched ref, so
        // the run is only visible for the PR head when review used --ref.
        const commit = valueAfter("--commit");
        const runs =
          commit === SHA && dispatchedOn === "feature/x"
            ? [{ status: "queued", name: "bugbot", workflowName: "bugbot" }]
            : [];
        return { stdout: JSON.stringify(runs) };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    });

    const reviewCode = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });
    const statusCode = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(dispatchedOn).toBe("feature/x");
    expect(reviewCode).toBe(0);
    expect(statusCode).toBe(2);
  });

  it("does not call an unknown ref a missing dispatch trigger (N5)", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feature/x",
            isCrossRepository: false,
          }),
        };
      }
      throw new GhError(
        args,
        "",
        "HTTP 404: reference not found on ref feature/x",
        1,
      );
    });
    const errors: string[] = [];

    const code = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("could not start a review");
    expect(errors.join("\n")).not.toContain("workflow_dispatch");
  });

  it("exits 1 with the dispatch hint when the caller cannot be dispatched", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feature/x",
            isCrossRepository: false,
          }),
        };
      }
      throw new GhError(
        args,
        "",
        "could not find any workflows named bugbot.yml",
        1,
      );
    });
    const errors: string[] = [];

    const code = await runRemoteReview(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("workflow_dispatch");
    expect(errors.join("\n")).toContain("pr input");
    expect(errors.join("\n")).toContain("examples/caller.yml");
    expect(errors.join("\n")).toContain("feature/x");
    expect(fake.calls).toEqual([
      [
        "pr",
        "view",
        "12",
        "-R",
        "o/r",
        "--json",
        "headRefName,isCrossRepository",
      ],
      [
        "workflow",
        "run",
        "bugbot.yml",
        "-R",
        "o/r",
        "--ref",
        "feature/x",
        "-f",
        "pr=12",
      ],
    ]);
  });

  it("exits 1 on a bad pull request without calling gh", async () => {
    const fake = reviewGh();
    const errors: string[] = [];

    const code = await runRemoteReview(["o/r#12; rm -rf /"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
    expect(errors.join("\n")).toContain("invalid pull request");
  });
});

describe("status <pr>", () => {
  it("exits 0 and prints done, conclusion, head and summary counts", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 2, name: "bugbot", status: "completed", conclusion: "success", started_at: "2026-01-01T00:01:00Z" },
          { id: 1, name: "other", status: "completed", conclusion: "failure" },
        ],
      },
      comments: [summaryComment()],
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(fake.calls).toEqual([
      ["pr", "view", "12", "-R", "o/r", "--json", "headRefOid,url"],
      CHECK_RUNS_ARGS,
      RUN_LIST_ARGS,
      ["api", "repos/o/r/issues/12/comments", "--paginate"],
    ]);
    const output = lines.join("\n");
    expect(output).toContain("State: done");
    expect(output).toContain("Conclusion: success");
    expect(output).toContain(`Head: ${SHA7}`);
    expect(output).toContain("Passes: 2");
    expect(output).toContain("Open comments: 3");
    expect(output).toContain("Marked fixed this pass: 4");
    expect(output).toContain("Skipped: duplicate 1, out of scope 2");
  });

  it("exits 2 while the bugbot check is in progress", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "bugbot", status: "in_progress", conclusion: null },
        ],
      },
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("exits 2 when no check exists but a bugbot run is queued", async () => {
    const fake = statusGh({
      checkRuns: { total_count: 0, check_runs: [] },
      runs: [
        { status: "in_progress", name: "CI", workflowName: "ci" },
        { status: "queued", name: "bugbot", workflowName: "bugbot" },
      ],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
    expect(fake.calls[2]).toEqual(RUN_LIST_ARGS);
  });

  it("does not count an active run with another workflow name (M13)", async () => {
    const fake = statusGh({
      checkRuns: { total_count: 0, check_runs: [] },
      runs: [{ status: "in_progress", name: "CI", workflowName: "ci" }],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(3);
  });

  it("does not count a completed check with another name (M12)", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "other", status: "completed", conclusion: "success" },
        ],
      },
      runs: [],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(3);
  });

  it("lets a newer queued re-run with no started_at win (N1/M6)", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 2,
        check_runs: [
          {
            id: 1,
            name: "bugbot",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:00:00Z",
          },
          {
            id: 2,
            name: "bugbot",
            status: "queued",
            conclusion: null,
            started_at: null,
          },
        ],
      },
      runs: [],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
  });

  it("lets a newer in-progress check win whatever the array order (M6)", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 2,
        check_runs: [
          {
            id: 1,
            name: "bugbot",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-01-01T00:02:00Z",
          },
          {
            id: 2,
            name: "bugbot",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:01:00Z",
          },
        ],
      },
      runs: [],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
  });

  it("breaks a started_at tie with the higher check id", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 2,
        check_runs: [
          {
            id: 1,
            name: "bugbot",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-01-01T00:01:00Z",
          },
          {
            id: 2,
            name: "bugbot",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:01:00Z",
          },
        ],
      },
      runs: [],
      comments: [],
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      conclusion: "success",
    });
  });

  it("lets an active re-run win over an older completed check (N2)", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          {
            id: 1,
            name: "bugbot",
            status: "completed",
            conclusion: "success",
            started_at: "2026-01-01T00:01:00Z",
          },
        ],
      },
      runs: [{ status: "queued", name: "bugbot", workflowName: "bugbot" }],
      comments: [],
    });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(2);
  });

  it("exits 3 when nothing ran for the head SHA", async () => {
    const fake = statusGh({ comments: [] });

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(3);
  });

  it("exits 1 on a gh error", async () => {
    const fake = fakeGh((args) => {
      if (args[0] === "pr") {
        return { stdout: JSON.stringify({ headRefOid: SHA, url: PR_URL }) };
      }
      throw new GhError(args, "", "HTTP 500", 1);
    });
    const errors: string[] = [];

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("could not read status");
  });

  it("exits 1 on a usage error without calling gh", async () => {
    const fake = statusGh({});

    const code = await runStatus([], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it("prints the --json shape", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "bugbot", status: "completed", conclusion: "neutral" },
        ],
      },
      comments: [summaryComment()],
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      repository: "o/r",
      pull: 12,
      url: PR_URL,
      headSha: SHA,
      headSha7: SHA7,
      state: "done",
      conclusion: "neutral",
      check: { status: "completed", conclusion: "neutral" },
      summary: {
        passes: 2,
        openComments: 3,
        markedFixed: 4,
        skipped: [
          { label: "duplicate", count: 1 },
          { label: "out of scope", count: 2 },
        ],
      },
      exitCode: 0,
    });
  });

  it("uses only the bot's marked summary comment", async () => {
    const humanLookalike = summaryComment(
      [
        "<!-- bugbot:summary -->",
        "- Passes: 99",
        "- Open Bugbot comments: 99",
        "- Marked fixed this pass: 99",
      ].join("\n"),
      "a-person",
    );
    const botWithoutMarker = summaryComment("- Passes: 88", "andura-bugbot[bot]");
    const botMarked = summaryComment();

    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "bugbot", status: "completed", conclusion: "success" },
        ],
      },
      comments: [botWithoutMarker, botMarked, humanLookalike],
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(0);
    const payload = JSON.parse(lines[0] ?? "") as {
      summary: { passes: number };
    };
    expect(payload.summary.passes).toBe(2);
  });

  it("reads paginated comments", async () => {
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "bugbot", status: "completed", conclusion: "success" },
        ],
      },
      commentsText:
        JSON.stringify([summaryComment("<!-- bugbot:summary -->\n- Passes: 1", "a-person")]) +
        "\n" +
        JSON.stringify([summaryComment()]),
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(0);
    const payload = JSON.parse(lines[0] ?? "") as {
      summary: { passes: number };
    };
    expect(payload.summary.passes).toBe(2);
  });

  it("exits 1 when the head SHA is malformed (M11)", async () => {
    const fake = statusGh({
      prView: { headRefOid: "not-a-sha", url: PR_URL },
      comments: [],
    });
    const errors: string[] = [];

    const code = await runStatus(["o/r#12"], {
      gh: fake.gh,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("no head SHA");
    expect(fake.calls.some((call) => call[0] === "api")).toBe(false);
  });

  it("uses the newest bot summary when a pass posted twice (M23)", async () => {
    const older = summaryComment(
      "<!-- bugbot:summary -->\n- Passes: 1",
      "andura-bugbot[bot]",
    );
    const newer = summaryComment(
      "<!-- bugbot:summary -->\n- Passes: 7",
      "andura-bugbot[bot]",
    );
    const fake = statusGh({
      checkRuns: {
        total_count: 1,
        check_runs: [
          { id: 1, name: "bugbot", status: "completed", conclusion: "success" },
        ],
      },
      comments: [older, newer],
    });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      summary: { passes: 7 },
    });
  });

  it("keeps --json exitCode equal to the process exit code (M24)", async () => {
    const fake = statusGh({ comments: [], runs: [] });
    const lines: string[] = [];

    const code = await runStatus(["o/r#12", "--json"], {
      gh: fake.gh,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(code).toBe(3);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      state: "none",
      exitCode: 3,
    });
  });

  it("takes a bare number with --repo without gh repo view", async () => {
    const fake = statusGh({ comments: [] });

    const code = await runStatus(["12", "--repo", "o/r"], {
      gh: fake.gh,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(3);
    expect(fake.calls[0]).toEqual([
      "pr",
      "view",
      "12",
      "-R",
      "o/r",
      "--json",
      "headRefOid,url",
    ]);
    expect(fake.calls.some((call) => call[0] === "repo")).toBe(false);
  });
});

describe("parseJsonPages", () => {
  it("reads one array or back-to-back paginated arrays", () => {
    expect(parseJsonPages('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseJsonPages('[{"id":1}]\n[{"id":2}]')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(parseJsonPages("")).toEqual([]);
  });
});

describe("execFileGh", () => {
  function withPath<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env["PATH"];
    process.env["PATH"] = path;
    return run().finally(() => {
      if (previous === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = previous;
      }
    });
  }

  it("passes argv literally and never through a shell (M16)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-gh-path-"));
    const script = join(dir, "gh");
    const marker = join(dir, "shell-ran");
    writeFileSync(
      script,
      '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done\n',
      "utf8",
    );
    chmodSync(script, 0o755);
    const previous = process.env["PATH"];

    try {
      const result = await withPath(`${dir}:${previous ?? ""}`, () =>
        execFileGh([
          "workflow",
          "run",
          "bugbot.yml",
          "-f",
          `pr=1; touch ${marker}`,
        ]),
      );

      expect(result.stdout).toBe(
        `workflow\nrun\nbugbot.yml\n-f\npr=1; touch ${marker}\n`,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says gh was not found on PATH (N4)", async () => {
    const missing = mkdtempSync(join(tmpdir(), "bb-missing-path-"));
    try {
      await expect(
        withPath(missing, () => execFileGh(["status"])),
      ).rejects.toThrow(/gh was not found on PATH/);
    } finally {
      rmSync(missing, { recursive: true, force: true });
    }
  });
});

describe("install-skill", () => {
  const expected: Record<keyof typeof HARNESS_PATHS, string> = {
    claude: ".claude/skills/bugbot/SKILL.md",
    "claude-personal": ".claude-personal/skills/bugbot/SKILL.md",
    grok: ".grok/skills/bugbot/SKILL.md",
    opencode: ".config/opencode/skills/bugbot/SKILL.md",
    agents: ".agents/skills/bugbot/SKILL.md",
  };

  it("installs the skill at each harness path under a temp HOME", async () => {
    const source = readFileSync(skillSourcePath(), "utf8");

    for (const harness of Object.keys(HARNESS_PATHS) as Array<
      keyof typeof HARNESS_PATHS
    >) {
      const home = tempHome();
      const lines: string[] = [];
      const code = await runInstallSkill(["--harness", harness], {
        home,
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      });

      const destination = join(home, expected[harness]);
      expect(code, harness).toBe(0);
      expect(destination).toBe(skillDestination(home, harness));
      expect(readFileSync(destination, "utf8")).toBe(source);
      expect(lines.join("\n")).toContain(destination);
      expect(existsSync(join(home, ".pstack"))).toBe(false);
    }
  });

  it("refuses to overwrite a different file without --force", async () => {
    const home = tempHome();
    const destination = skillDestination(home, "grok");
    const dir = join(home, expected.grok.replace(/\/SKILL\.md$/, ""));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(destination, "old content", "utf8");
    const errors: string[] = [];

    const code = await runInstallSkill(["--harness", "grok"], {
      home,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(readFileSync(destination, "utf8")).toBe("old content");
    expect(errors.join("\n")).toContain("--force");
  });

  it("is a no-op when the installed file is identical", async () => {
    const home = tempHome();
    const first = await runInstallSkill(["--harness", "agents"], {
      home,
      log: () => {},
      error: () => {},
    });
    const lines: string[] = [];
    const second = await runInstallSkill(["--harness", "agents"], {
      home,
      log: (line) => lines.push(line),
      error: () => {},
    });

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(lines.join("\n")).toContain("already installed");
  });

  it("overwrites with --force", async () => {
    const home = tempHome();
    const destination = skillDestination(home, "claude");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".claude/skills/bugbot"), { recursive: true });
    writeFileSync(destination, "old content", "utf8");

    const code = await runInstallSkill(["--harness", "claude", "--force"], {
      home,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(0);
    expect(readFileSync(destination, "utf8")).toBe(
      readFileSync(skillSourcePath(), "utf8"),
    );
  });

  it("writes nothing on --dry-run", async () => {
    const home = tempHome();
    const lines: string[] = [];

    const code = await runInstallSkill(
      ["--harness", "opencode", "--dry-run"],
      { home, log: (line) => lines.push(line), error: () => {} },
    );

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain(skillDestination(home, "opencode"));
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it("rejects an unknown harness", async () => {
    const home = tempHome();

    const code = await runInstallSkill(["--harness", "pstack"], {
      home,
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(1);
    expect(existsSync(join(home, ".pstack"))).toBe(false);
  });

  it("refuses a symlinked parent directory that points outside HOME (B4)", async () => {
    const home = tempHome();
    const outside = mkdtempSync(join(tmpdir(), "bb-skill-outside-"));
    mkdirSync(join(home, ".grok"), { recursive: true });
    symlinkSync(outside, join(home, ".grok", "skills"));
    const errors: string[] = [];

    const code = await runInstallSkill(["--harness", "grok"], {
      home,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("symlink");
    expect(existsSync(join(outside, "bugbot", "SKILL.md"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked parent directory that points into .pstack (B4)", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".pstack", "skills"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(join(home, ".pstack", "skills"), join(home, ".agents", "skills"));
    const errors: string[] = [];

    const code = await runInstallSkill(["--harness", "agents"], {
      home,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("symlink");
    expect(existsSync(join(home, ".pstack", "skills", "bugbot"))).toBe(false);
  });

  it("refuses a dangling SKILL.md symlink even without --force (B4)", async () => {
    const home = tempHome();
    const outside = mkdtempSync(join(tmpdir(), "bb-skill-outside-"));
    const dir = join(home, ".claude-personal", "skills", "bugbot");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, "planted.txt"), join(dir, "SKILL.md"));
    const errors: string[] = [];

    const code = await runInstallSkill(["--harness", "claude-personal"], {
      home,
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("symlink");
    expect(existsSync(join(outside, "planted.txt"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked destination with --force as well (B4)", async () => {
    const home = tempHome();
    const dest = skillDestination(home, "opencode");
    const outside = join(home, "outside.txt");
    mkdirSync(join(home, ".config", "opencode", "skills", "bugbot"), {
      recursive: true,
    });
    writeFileSync(outside, "outside", "utf8");
    symlinkSync(outside, dest);

    const code = await runInstallSkill(
      ["--harness", "opencode", "--force"],
      { home, log: () => {}, error: () => {} },
    );

    expect(code).toBe(1);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("refuses a symlink on --dry-run too (B4)", async () => {
    const home = tempHome();
    const outside = mkdtempSync(join(tmpdir(), "bb-skill-outside-"));
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(outside, join(home, ".agents", "skills"));

    const code = await runInstallSkill(
      ["--harness", "agents", "--dry-run"],
      { home, log: () => {}, error: () => {} },
    );

    expect(code).toBe(1);
    rmSync(outside, { recursive: true, force: true });
  });
});
