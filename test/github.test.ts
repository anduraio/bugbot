import { describe, expect, it, vi } from "vitest";
import {
  MAX_POSTED_COMMENTS,
  formatComment,
  type Finding,
  type PlannedComment,
} from "../src/filter.js";
import {
  assertAllowedRequest,
  errorDetail,
  fetchPullRequest,
  fetchPullRequestDiff,
  findSummary,
  finishCheck,
  GitHubError,
  listBugbotThreads,
  listCheckRuns,
  normalizeLogin,
  parseThreadBody,
  postReview,
  readRepositoryFile,
  redact,
  renderSummary,
  safeDisplay,
  reportSkipped,
  resolveFixedThreads,
  startCheck,
  upsertSummary,
  type BugbotThread,
  type CheckConclusion,
  type GitHubOptions,
  type ReviewSummary,
} from "../src/github.js";
import type { FetchLike } from "../src/model.js";

const TOKEN = "ghs_TESTTOKEN123";
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BOT = "andura-bugbot";

interface Recorded {
  method: string;
  /** URL pathname, including any base-url prefix. */
  path: string;
  url: string;
  search: string;
  body: unknown;
  headers: Record<string, string>;
}

function recording(
  handler: (call: Recorded) => Response | Promise<Response>,
): { fetchFn: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw);
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const call: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname,
      url: raw,
      search: url.search,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchFn, calls };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pullResponse(sha = HEAD_SHA): Response {
  return json({
    draft: false,
    head: { sha, repo: { full_name: "o/r" } },
    base: { repo: { full_name: "o/r" } },
  });
}

function options(extra: Partial<GitHubOptions> = {}): GitHubOptions {
  return {
    token: TOKEN,
    repository: "o/r",
    prNumber: 1,
    headSha: HEAD_SHA,
    runId: "12345",
    ...extra,
  };
}

function plannedComment(overrides: Partial<PlannedComment> = {}): PlannedComment {
  const file = overrides.file ?? "src/a.ts";
  const line = overrides.line ?? 10;
  const side = overrides.side ?? "RIGHT";
  const severity = overrides.severity ?? "high";
  const category = overrides.category ?? "bug";
  const reason = overrides.reason ?? "value can be undefined";
  const finding: Finding = {
    file,
    line,
    side,
    severity,
    category,
    categoryCoerced: false,
    confidence: 0.9,
    reason,
    suggested_fix: "add a guard",
    angle: "test",
    symbol: "",
    triage: "fix",
  };

  return {
    finding,
    file,
    line,
    side,
    severity,
    category,
    confidence: 0.9,
    reason,
    suggestedFix: "add a guard",
    triage: "fix",
    symbol: "",
    hash: "c".repeat(40),
    title: "**High bug: value can be undefined**",
    ...overrides,
  };
}

function comment(
  author: string | null,
  body: string,
  databaseId = 1001,
  accountType?: "Bot" | "User" | "Organization",
): Record<string, unknown> {
  const type = accountType ?? (author === BOT ? "Bot" : "User");
  return {
    databaseId,
    author: author === null ? null : { login: author, __typename: type },
    body,
  };
}

/** A REST issue-comment user, which carries `type` instead of `__typename`. */
function restUser(login: string, type: "Bot" | "User" = "Bot"): Record<string, unknown> {
  return { login, type };
}

function botSummaryComment(id: number, body: string): Record<string, unknown> {
  return { id, user: restUser(BOT, "Bot"), body };
}

/** Fails instead of hanging when the code under test never settles. */
async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("test deadline exceeded")),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function threadNode(
  comments: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "PRRT_1",
    isResolved: false,
    path: "src/a.ts",
    line: 10,
    originalLine: 10,
    diffSide: "RIGHT",
    comments: { nodes: comments },
    ...overrides,
  };
}

function botComment(overrides: Partial<PlannedComment> = {}): Record<string, unknown> {
  return comment(BOT, formatComment(plannedComment(overrides), "12345", HEAD_SHA));
}

function threadsResponse(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): Response {
  return json({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  });
}

function reviewSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    passCount: 2,
    model: "deepseek/deepseek-v4.1-flash-1017",
    tokensIn: 1234,
    tokensOut: 56,
    posted: 3,
    openComments: 7,
    skipped: { duplicate: 1, belowConfidence: 1 },
    resolved: 1,
    truncated: [],
    ...overrides,
  };
}

function bugbotThread(overrides: Partial<BugbotThread> = {}): BugbotThread {
  return {
    threadId: "PRRT_1",
    firstCommentId: 1001,
    path: "src/a.ts",
    line: 10,
    originalLine: 10,
    side: "RIGHT",
    isResolved: false,
    marker: { hash: "c".repeat(40), runId: "12345", sha: HEAD_SHA },
    category: "bug",
    reason: "value can be undefined",
    state: "open",
    ...overrides,
  };
}

function reviewBodies(calls: readonly Recorded[]): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.path.endsWith("/reviews"))
    .map((call) => call.body as Record<string, unknown>);
}

describe("assertAllowedRequest", () => {
  it("accepts every allowed REST operation", () => {
    const allowed = [
      { method: "GET", path: "/repos/o/r/pulls/1" },
      { method: "GET", path: "/repos/o/r/issues/1/comments" },
      { method: "POST", path: "/repos/o/r/issues/1/comments" },
      { method: "PATCH", path: "/repos/o/r/issues/comments/9" },
      {
        method: "POST",
        path: "/repos/o/r/pulls/1/reviews",
        body: { event: "COMMENT" },
      },
      { method: "POST", path: "/repos/o/r/pulls/1/comments/9/replies" },
      { method: "POST", path: "/repos/o/r/check-runs" },
      { method: "PATCH", path: "/repos/o/r/check-runs/9" },
    ];

    for (const request of allowed) {
      expect(() => assertAllowedRequest(request)).not.toThrow();
    }
  });

  it("rejects merge, approve, request-changes, dismissals and deletes", () => {
    const rejected = [
      { method: "PUT", path: "/repos/o/r/pulls/1/merge" },
      {
        method: "POST",
        path: "/repos/o/r/pulls/1/reviews",
        body: { event: "APPROVE" },
      },
      {
        method: "POST",
        path: "/repos/o/r/pulls/1/reviews",
        body: { event: "REQUEST_CHANGES" },
      },
      {
        method: "POST",
        path: "/repos/o/r/pulls/1/reviews",
        body: { event: "comment" },
      },
      { method: "POST", path: "/repos/o/r/pulls/1/reviews/9/events" },
      { method: "POST", path: "/repos/o/r/pulls/1/dismissals" },
      {
        method: "POST",
        path: "/repos/o/r/pulls/1/requested_reviewers",
      },
      { method: "POST", path: "/repos/o/r/pulls/1/reviews" },
      { method: "DELETE", path: "/repos/o/r/issues/comments/1" },
      {
        method: "POST",
        path: "/graphql",
        body: { query: "mutation Merge { mergePullRequest(input: {}) { pullRequest { id } } }" },
      },
      {
        method: "POST",
        path: "/graphql",
        body: { query: "mutation Add { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }" },
      },
    ];

    for (const request of rejected) {
      expect(() => assertAllowedRequest(request)).toThrow();
    }
  });

  it("rejects GraphQL bodies that are not one of the two known documents", () => {
    expect(() => assertAllowedRequest({ method: "POST", path: "/graphql" })).toThrow(
      /GraphQL operation not allowed/,
    );
    expect(() =>
      assertAllowedRequest({
        method: "POST",
        path: "/graphql",
        body: { query: "query { viewer { login } }" },
      }),
    ).toThrow(/GraphQL operation not allowed/);
  });
});

describe("boundary validation", () => {
  it("rejects a bad repository, prNumber, runId or head SHA with no request", async () => {
    const { fetchFn, calls } = recording(() => {
      throw new Error("fetch must not be called for invalid input");
    });

    const cases = [
      () =>
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r/extra",
          prNumber: 1,
          fetch: fetchFn,
        }),
      () =>
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r",
          prNumber: 0,
          fetch: fetchFn,
        }),
      () =>
        startCheck(options({ repository: "", fetch: fetchFn })),
      () => startCheck(options({ prNumber: 0, fetch: fetchFn })),
      () => startCheck(options({ runId: "12a", fetch: fetchFn })),
      () => startCheck(options({ headSha: "a".repeat(39), fetch: fetchFn })),
      () => startCheck(options({ headSha: "A".repeat(40), fetch: fetchFn })),
      () => startCheck(options({ prNumber: 1.5, fetch: fetchFn })),
      () =>
        fetchPullRequest({
          token: TOKEN,
          repository: "o/..",
          prNumber: 1,
          fetch: fetchFn,
        }),
      () =>
        fetchPullRequest({
          token: TOKEN,
          repository: "./r",
          prNumber: 1,
          fetch: fetchFn,
        }),
      () => startCheck(options({ repository: "o/..", fetch: fetchFn })),
    ];

    for (const run of cases) {
      await expect(run()).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);

    expect(() =>
      assertAllowedRequest({ method: "GET", path: "/repos/o/../pulls/1" }),
    ).toThrow(/invalid repository/);
    expect(() =>
      assertAllowedRequest({ method: "GET", path: "/repos/./r/pulls/1" }),
    ).toThrow();
  });
});

describe("fetchPullRequest", () => {
  it("sends the documented headers and maps draft, fork and labels", async () => {
    const { fetchFn, calls } = recording(() =>
      json({
        number: 1,
        draft: true,
        head: { sha: HEAD_SHA, repo: { full_name: "o/r" } },
        base: { repo: { full_name: "o/r" } },
        labels: [{ name: "bugbot" }, null, { name: null }],
      }),
    );

    const state = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
    });

    expect(state).toEqual({
      number: 1,
      headSha: HEAD_SHA,
      draft: true,
      fork: false,
      labels: ["bugbot"],
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/repos/o/r/pulls/1");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.Accept).toBe("application/vnd.github+json");
    expect(call.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(call.headers["User-Agent"]).toBe("bugbot");
  });

  it("treats a different or null head repo as a fork", async () => {
    const different = recording(() =>
      json({
        draft: false,
        head: { sha: HEAD_SHA, repo: { full_name: "someone/r" } },
        base: { repo: { full_name: "o/r" } },
      }),
    );
    const forkState = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: different.fetchFn,
    });
    expect(forkState.fork).toBe(true);

    const deleted = recording(() =>
      json({
        draft: false,
        head: { sha: HEAD_SHA, repo: null },
        base: { repo: { full_name: "o/r" } },
      }),
    );
    const deletedState = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: deleted.fetchFn,
    });
    expect(deletedState.fork).toBe(true);
  });

  it("tolerates null labels, a null draft and a null base repo", async () => {
    const { fetchFn } = recording(() =>
      json({
        draft: null,
        head: { sha: HEAD_SHA, repo: { full_name: "o/r" } },
        base: { repo: null },
        labels: null,
      }),
    );

    const state = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
    });
    expect(state.labels).toEqual([]);
    expect(state.draft).toBe(false);
    expect(state.fork).toBe(true);
  });

  it("uses an overridden base URL", async () => {
    const { fetchFn, calls } = recording(() =>
      json({
        draft: false,
        head: { sha: HEAD_SHA, repo: { full_name: "o/r" } },
        base: { repo: { full_name: "o/r" } },
      }),
    );

    await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
      baseUrl: "https://ghe.example/api/v3/",
    });

    expect(calls[0]?.url).toBe("https://ghe.example/api/v3/repos/o/r/pulls/1");
  });
});

describe("check runs", () => {
  it("starts an in-progress check named bugbot", async () => {
    const { fetchFn, calls } = recording(() => json({ id: 77 }, 201));

    const handle = await startCheck(options({ fetch: fetchFn }));

    expect(handle.id).toBe(77);
    expect(handle.appId).toBeNull();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/repos/o/r/check-runs");
    expect(call.body).toEqual({
      name: "bugbot",
      head_sha: HEAD_SHA,
      status: "in_progress",
      external_id: "12345",
    });
  });

  it("reports the app that created the check run", async () => {
    const { fetchFn } = recording(() => json({ id: 77, app: { id: 4242 } }, 201));

    const handle = await startCheck(options({ fetch: fetchFn }));

    expect(handle).toMatchObject({ id: 77, appId: 4242 });
  });

  it("finishes neutral or success with a capped summary", async () => {
    const { fetchFn, calls } = recording(() => json({}));

    await finishCheck(
      options({ fetch: fetchFn }),
      { id: 77 },
      "neutral",
      "x".repeat(60_001),
    );
    await finishCheck(options({ fetch: fetchFn }), { id: 77 }, "success", "clean");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe("PATCH");
      expect(call.path).toBe("/repos/o/r/check-runs/77");
      expect((call.body as Record<string, unknown>).status).toBe("completed");
      expect((call.body as Record<string, unknown>).conclusion).not.toBe("failure");
    }
    const first = calls[0]!.body as {
      conclusion: string;
      output: { title: string; summary: string };
    };
    expect(first.conclusion).toBe("neutral");
    expect(first.output.title).toBe("Bugbot");
    expect(first.output.summary).toHaveLength(60_000);
  });

  it("rejects a failure conclusion before fetching", async () => {
    const { fetchFn, calls } = recording(() => json({}));

    await expect(
      finishCheck(
        options({ fetch: fetchFn }),
        { id: 77 },
        "failure" as unknown as CheckConclusion,
        "broken",
      ),
    ).rejects.toThrow(/neutral or success/);
    expect(calls).toHaveLength(0);
  });

  it("reports a skipped review as one completed neutral check", async () => {
    const { fetchFn, calls } = recording(() => json({ id: 78 }, 201));

    await reportSkipped(options({ fetch: fetchFn }), "Bugbot skipped: draft");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      name: "bugbot",
      head_sha: HEAD_SHA,
      status: "completed",
      conclusion: "neutral",
      external_id: "12345",
      output: { title: "Bugbot", summary: "Bugbot skipped: draft" },
    });
  });
});

describe("parseThreadBody", () => {
  it("recovers the category and reason from formatComment output", () => {
    const body = formatComment(
      plannedComment({
        category: "edge-case",
        severity: "medium",
        reason: "the empty list path throws",
        title: "**Medium edge-case: the empty list path throws**",
      }),
      "12345",
      HEAD_SHA,
    );

    expect(parseThreadBody(body)).toEqual({
      category: "edge-case",
      reason: "the empty list path throws",
    });
  });

  it("returns category null for a body that was not written by formatComment", () => {
    expect(parseThreadBody("not a bugbot comment")).toEqual({
      category: null,
      reason: "",
    });
    expect(parseThreadBody("**Something else: text**\n\ntext")).toEqual({
      category: null,
      reason: "text",
    });
  });
});

describe("normalizeLogin", () => {
  it("strips one trailing [bot] and compares case-insensitively", () => {
    expect(normalizeLogin("Andura-Bugbot[bot]")).toBe("andura-bugbot");
    expect(normalizeLogin("ANDURA-BUGBOT")).toBe("andura-bugbot");
    expect(normalizeLogin("andura-bugbot-fan")).toBe("andura-bugbot-fan");
  });
});

describe("listBugbotThreads", () => {
  it("returns a thread whose first comment is the bot with a valid marker", async () => {
    const { fetchFn, calls } = recording(() => threadsResponse([threadNode([botComment()])]));

    const threads = await listBugbotThreads(
      options({ fetch: fetchFn, botLogin: "Andura-Bugbot[bot]" }),
    );

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      threadId: "PRRT_1",
      firstCommentId: 1001,
      path: "src/a.ts",
      line: 10,
      originalLine: 10,
      side: "RIGHT",
      isResolved: false,
      category: "bug",
      reason: "value can be undefined",
      state: "open",
    });
    expect(threads[0]?.marker.runId).toBe("12345");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/graphql");
    expect((calls[0]?.body as { query: string }).query).toContain("reviewThreads");
  });

  it("ignores a human comment with a perfect marker copy", async () => {
    const body = formatComment(plannedComment(), "12345", HEAD_SHA);
    const { fetchFn } = recording(() =>
      threadsResponse([threadNode([comment("a-human", body)])]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads).toEqual([]);
  });

  it("ignores a deleted-user (null author) thread", async () => {
    const body = formatComment(plannedComment(), "12345", HEAD_SHA);
    const { fetchFn } = recording(() =>
      threadsResponse([threadNode([comment(null, body)])]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads).toEqual([]);
  });

  it("marks a thread skipped when a non-bot reply says won't fix", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([
          botComment(),
          comment("a-human", "Won't fix, this is intentional."),
          comment(BOT, "Fixed in 0123456.", 1002),
        ]),
      ]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads[0]?.state).toBe("skipped");
  });

  it("does not mark a thread skipped for a bot reply that says skip", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([botComment(), comment(BOT, "skip note", 1002)]),
      ]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads[0]?.state).toBe("open");
  });

  it("marks a resolved thread resolved even when a human said skip", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode(
          [botComment(), comment("a-human", "skip")],
          { isResolved: true },
        ),
      ]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads[0]?.state).toBe("resolved");
    expect(threads[0]?.isResolved).toBe(true);
  });

  it("paginates with pageInfo across two pages", async () => {
    const { fetchFn, calls } = recording((call) => {
      const variables = (call.body as { variables: { after: string | null } }).variables;
      if (variables.after === null) {
        return threadsResponse(
          [threadNode([botComment()])],
          true,
          "CURSOR1",
        );
      }
      return threadsResponse([
        threadNode([botComment({ file: "src/b.ts" })], {
          id: "PRRT_2",
          line: 20,
          originalLine: 20,
        }),
      ]);
    });

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));

    expect(threads.map((thread) => thread.threadId)).toEqual(["PRRT_1", "PRRT_2"]);
    expect(calls).toHaveLength(2);
    expect((calls[0]?.body as { variables: { after: string | null } }).variables.after).toBeNull();
    expect((calls[1]?.body as { variables: { after: string | null } }).variables.after).toBe(
      "CURSOR1",
    );
  });

  it("tolerates null line and originalLine", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([botComment()], { line: null, originalLine: null }),
      ]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads[0]).toMatchObject({ line: null, originalLine: null });
  });

  it("returns category null when the body lost the title shape but kept the marker", async () => {
    const body = `plain text\n\n${formatComment(plannedComment(), "12345", HEAD_SHA)}`;
    const { fetchFn } = recording(() =>
      threadsResponse([threadNode([comment(BOT, body)])]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.category).toBeNull();
  });
});

describe("postReview", () => {
  it("posts one COMMENT review with the planned inline comments", async () => {
    const { fetchFn, calls } = recording(() => json({ id: 99 }, 201));

    const result = await postReview(options({ fetch: fetchFn }), [
      plannedComment(),
      plannedComment({ file: "src/b.ts", line: 20 }),
    ]);

    expect(result).toMatchObject({ posted: 2, failed: [] });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.path).toBe("/repos/o/r/pulls/1/reviews");
    const body = call.body as {
      commit_id: string;
      event: string;
      body: string;
      comments: Array<Record<string, unknown>>;
    };
    expect(body.commit_id).toBe(HEAD_SHA);
    expect(body.event).toBe("COMMENT");
    expect(body.body.length).toBeGreaterThan(0);
    expect(body.comments).toHaveLength(2);
    expect(body.comments[0]?.path).toBe("src/a.ts");
    expect(body.comments[0]?.side).toBe("RIGHT");
    expect(body.comments[0]?.line).toBe(10);
    expect(String(body.comments[0]?.body)).toContain("<!-- bugbot:v1 id=");
    expect(String(body.comments[0]?.body)).toContain("RUN_ID: 12345");
  });

  it("sends start_line and start_side for a multi-line finding", async () => {
    const { fetchFn, calls } = recording(() => json({ id: 99 }, 201));

    await postReview(options({ fetch: fetchFn }), [
      plannedComment({ line: 10, endLine: 14 }),
      plannedComment({ file: "src/b.ts", line: 20, endLine: 20 }),
    ]);

    const body = calls[0]?.body as {
      comments: Array<Record<string, unknown>>;
    };
    expect(body.comments[0]).toMatchObject({
      line: 14,
      start_line: 10,
      start_side: "RIGHT",
    });
    expect(body.comments[1]).not.toHaveProperty("start_line");
    expect(body.comments[1]).not.toHaveProperty("start_side");
    expect(body.comments[1]?.line).toBe(20);
  });

  it("sends nothing for zero comments", async () => {
    const { fetchFn, calls } = recording(() => json({}));

    const result = await postReview(options({ fetch: fetchFn }), []);
    expect(result).toEqual({ posted: 0, failed: [], planned: [] });
    expect(calls).toHaveLength(0);
  });

  it("throws for more than the cap before fetching", async () => {
    const { fetchFn, calls } = recording(() => json({}));
    const comments = Array.from({ length: MAX_POSTED_COMMENTS + 1 }, () =>
      plannedComment(),
    );

    await expect(postReview(options({ fetch: fetchFn }), comments)).rejects.toThrow(
      /too many inline comments/,
    );
    expect(calls).toHaveLength(0);
  });

  it("falls back to one review per comment after a 422 and reports failures", async () => {
    let reviews = 0;
    const { fetchFn, calls } = recording(() => {
      reviews += 1;
      if (reviews === 1) {
        return json({ message: "unprocessable" }, 422);
      }
      if (reviews === 3) {
        return json({ message: "still unprocessable" }, 422);
      }
      return json({ id: reviews }, 201);
    });
    const logs: string[] = [];

    const result = await postReview(
      options({ fetch: fetchFn, log: (line) => logs.push(line) }),
      [
        plannedComment({ file: "a.ts", line: 1 }),
        plannedComment({ file: "b.ts", line: 2 }),
        plannedComment({ file: "c.ts", line: 3 }),
      ],
    );

    expect(result.posted).toBe(2);
    expect(result.failed).toEqual([{ file: "b.ts", line: 2, status: 422 }]);
    expect(result.planned).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(reviewBodies(calls).every((body) => body.event === "COMMENT")).toBe(true);
    const fallbacks = reviewBodies(calls).slice(1);
    expect(fallbacks).toHaveLength(3);
    for (const body of fallbacks) {
      expect((body.comments as unknown[]).length).toBe(1);
    }
    expect(logs[0]).toContain("b.ts:2");
  });
});

describe("safe file names in output (R1-N3)", () => {
  const hostile = "x\n::warning::pwned\\y.ts";

  it("replaces every control character with ? and keeps the rest", () => {
    expect(safeDisplay(hostile)).toBe("x?::warning::pwned\\y.ts");
    expect(safeDisplay("a\rb\u0000c\u001bd\u007fe\u0085f\u2028g\u2029h")).toBe(
      "a?b?c?d?e?f?g?h",
    );
    expect(safeDisplay("src/ünï/ok file.ts")).toBe("src/ünï/ok file.ts");
  });

  it("logs a failed post for a hostile file name on one line", async () => {
    const { fetchFn } = recording(() => json({ message: "unprocessable" }, 422));
    const logs: string[] = [];

    await postReview(
      options({ fetch: fetchFn, log: (line) => logs.push(line) }),
      [plannedComment({ file: hostile, line: 4 })],
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(
      "Bugbot could not post x?::warning::pwned\\y.ts:4 (status 422)",
    );
  });

  it("keeps a hostile path out of the unsafe-path error", async () => {
    const { fetchFn } = recording(() => json({}));

    const cases: Array<[string, string]> = [
      ["a/../x\n::warning::pwned", "a/../x?::warning::pwned"],
      ["/x\n::warning::pwned", "/x?::warning::pwned"],
    ];
    for (const [path, shown] of cases) {
      const error = await readRepositoryFile({
        token: TOKEN,
        repository: "o/r",
        path,
        ref: SHA,
        fetch: fetchFn,
      }).catch((caught: unknown) => caught as Error);

      expect(error.message).toBe(`refusing to read unsafe path: ${shown}`);
    }
  });

  it("escapes control characters in the truncated-files list", () => {
    const body = renderSummary(
      {
        passCount: 1,
        model: "m",
        tokensIn: 0,
        tokensOut: 0,
        posted: 0,
        openComments: 0,
        skipped: {},
        resolved: 0,
        truncated: [hostile],
      },
      TOKEN,
    );

    expect(body).toContain("`x?::warning::pwned\\y.ts`");
    expect(body).not.toContain("\n::warning::");
  });

  it("names every non-zero skipped bucket and keeps the markers", () => {
    const body = renderSummary(
      reviewSummary({
        posted: 1,
        openComments: 3,
        skipped: {
          duplicate: 1,
          belowConfidence: 2,
          lowSeverity: 0,
          notInDiff: 1,
          triageDismissed: 0,
          overCap: 0,
          schemaInvalid: 0,
          outOfScope: 1,
        },
        runs: ["111", "222"],
      }),
    );

    expect(body.startsWith("<!-- bugbot:summary -->")).toBe(true);
    expect(body).toContain("<!-- bugbot:runs 111,222 -->");
    expect(body).toContain("- Posted this pass: 1");
    expect(body).toContain("- Open Bugbot comments: 3");
    expect(body).toContain(
      "- Skipped: 1 duplicate, 2 below confidence, 1 not in diff, 1 out of scope",
    );
    expect(body).not.toContain("- Posted:");
    expect(body).not.toContain("- Skipped: 0");
  });
});

describe("upsertSummary", () => {
  it("creates the summary when absent", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET" ? json([]) : json({ id: 321 }, 201),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("created");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /repos/o/r/issues/1/comments",
      "POST /repos/o/r/issues/1/comments",
    ]);
    const body = (calls[1]?.body as { body: string }).body;
    expect(body.startsWith("<!-- bugbot:summary -->")).toBe(true);
    expect(body).toContain("- Passes: 2");
    expect(body).toContain("- Model: deepseek/deepseek-v4.1-flash-1017");
    expect(body).toContain("- Tokens: 1234 in / 56 out");
    expect(body).toContain("- Posted this pass: 3");
    expect(body).toContain("- Open Bugbot comments: 7");
    expect(body).toContain("- Skipped: 1 duplicate, 1 below confidence");
    expect(body).toContain("- Resolved: 1");
    expect(body.trimEnd().endsWith("Bugbot only comments; it never approves or blocks.")).toBe(
      true,
    );
  });

  it("edits the bot's existing summary in place", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([
            {
              id: 55,
              user: restUser("andura-bugbot[bot]", "Bot"),
              body: "old\n<!-- bugbot:summary -->",
            },
            {
              id: 56,
              user: restUser("a-human", "User"),
              body: "look-alike\n<!-- bugbot:summary -->",
            },
          ])
        : json({ id: 55 }),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("updated");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /repos/o/r/issues/1/comments",
      "PATCH /repos/o/r/issues/comments/55",
    ]);
  });

  it("creates a new summary instead of editing a human's look-alike", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([
            {
              id: 56,
              user: restUser("a-human", "User"),
              body: "look-alike\n<!-- bugbot:summary -->",
            },
          ])
        : json({ id: 321 }, 201),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("created");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(calls[1]?.method).toBe("POST");
  });

  it("caps the truncated list at 50 files with and N more", () => {
    const body = renderSummary(
      reviewSummary({
        truncated: Array.from({ length: 52 }, (_, index) => `file-${index}.ts`),
      }),
    );

    expect(body).toContain("`file-49.ts`");
    expect(body).not.toContain("`file-50.ts`");
    expect(body).toContain("and 2 more");
  });

  it("renders an optional error line and still ends with the fixed sentence", () => {
    const body = renderSummary(
      reviewSummary({ error: `the request failed with ${TOKEN}` }),
      TOKEN,
    );

    expect(body).toContain("Bugbot couldn't review: the request failed with [redacted]");
    expect(body).not.toContain(TOKEN);
    expect(body.trimEnd().endsWith("Bugbot only comments; it never approves or blocks.")).toBe(
      true,
    );
  });

  it("redacts a GitHub-shaped token from the model line via the regex layer", () => {
    const body = renderSummary(
      reviewSummary({ model: `model-${TOKEN}` }),
      "a-different-secret",
    );
    expect(body).not.toContain(TOKEN);
    expect(body).toContain("- Model: model-[redacted]");
  });
});

describe("resolveFixedThreads", () => {
  it("replies and resolves only open threads, leaving skipped and resolved alone", async () => {
    const { fetchFn, calls } = recording((call) => {
      if (call.path.endsWith("/replies")) {
        return json({ id: 1 }, 201);
      }
      return json({
        data: {
          resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
        },
      });
    });

    const result = await resolveFixedThreads(
      options({ fetch: fetchFn }),
      [
        bugbotThread(),
        bugbotThread({ threadId: "PRRT_2", firstCommentId: 1002, state: "skipped" }),
        bugbotThread({
          threadId: "PRRT_3",
          firstCommentId: 1003,
          state: "resolved",
          isResolved: true,
        }),
      ],
      HEAD_SHA,
    );

    expect(result).toMatchObject({ resolved: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/repos/o/r/pulls/1/comments/1001/replies");
    expect(calls[0]?.body).toEqual({ body: "Fixed in 0123456." });
    expect(calls[1]?.path).toBe("/graphql");
    expect((calls[1]?.body as { variables: { threadId: string } }).variables).toEqual({
      threadId: "PRRT_1",
    });
  });

  it("continues after one failing reply", async () => {
    const logs: string[] = [];
    const { fetchFn, calls } = recording((call) => {
      if (call.path.endsWith("/replies")) {
        if (call.path.includes("/1001/")) {
          return json({ message: "nope" }, 500);
        }
        return json({ id: 2 }, 201);
      }
      return json({
        data: {
          resolveReviewThread: { thread: { id: "PRRT_2", isResolved: true } },
        },
      });
    });

    const result = await resolveFixedThreads(
      options({ fetch: fetchFn, log: (line) => logs.push(line) }),
      [
        bugbotThread({ threadId: "PRRT_1", firstCommentId: 1001 }),
        bugbotThread({ threadId: "PRRT_2", firstCommentId: 1002 }),
      ],
      HEAD_SHA,
    );

    expect(result).toMatchObject({ resolved: 1, failed: 1 });
    expect(calls).toHaveLength(3);
    expect(logs[0]).toContain("PRRT_1");
  });
});

describe("retries", () => {
  it("succeeds after a 502 on a GET", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { fetchFn } = recording(() => {
      calls += 1;
      return calls === 1 ? json({ message: "bad gateway" }, 502) : pullResponse();
    });

    const state = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(state.headSha).toBe(HEAD_SHA);
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it("retries a 502 on a PATCH", async () => {
    let calls = 0;
    const { fetchFn } = recording(() => {
      calls += 1;
      return calls === 1
        ? json({ message: "bad gateway" }, 502)
        : json({ id: 77 });
    });

    await finishCheck(options({ fetch: fetchFn }), { id: 77 }, "success", "ok");

    expect(calls).toBe(2);
  });

  it("does not retry a 500", async () => {
    let calls = 0;
    const { fetchFn } = recording(() => {
      calls += 1;
      return json({ message: "server error" }, 500);
    });

    await expect(startCheck(options({ fetch: fetchFn }))).rejects.toMatchObject({
      name: "GitHubError",
      status: 500,
    });
    expect(calls).toBe(1);
  });

  it("gives a GitHubError after three 503s on a GET", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { fetchFn } = recording(() => {
      calls += 1;
      return json({ message: "unavailable" }, 503);
    });

    await expect(
      fetchPullRequest({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: fetchFn,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    ).rejects.toMatchObject({ name: "GitHubError", status: 503 });
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("retries a 403 with Retry-After within the cap", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { fetchFn } = recording(() => {
      calls += 1;
      return calls === 1
        ? json({ message: "slow down" }, 403, { "retry-after": "2" })
        : json({ id: 10 }, 201);
    });

    const handle = await startCheck(
      options({
        fetch: fetchFn,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    );

    expect(handle.id).toBe(10);
    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it("does not retry a 403 without Retry-After", async () => {
    let calls = 0;
    const { fetchFn } = recording(() => {
      calls += 1;
      return json({ message: "forbidden" }, 403);
    });

    await expect(startCheck(options({ fetch: fetchFn }))).rejects.toMatchObject({
      name: "GitHubError",
      status: 403,
    });
    expect(calls).toBe(1);
  });

  it("throws instead of retrying when Retry-After is above the 10 s cap", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { fetchFn } = recording(() => {
      calls += 1;
      return json({ message: "slow down" }, 403, { "retry-after": "120" });
    });

    await expect(
      startCheck(
        options({
          fetch: fetchFn,
          sleep: async (milliseconds) => {
            delays.push(milliseconds);
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "GitHubError", status: 403 });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("throws when REST pagination hits the 20-page cap", async () => {
    const { fetchFn, calls } = recording(() =>
      json([], 200, {
        link: '<https://api.github.com/x?page=2>; rel="next"',
      }),
    );

    await expect(
      upsertSummary(options({ fetch: fetchFn }), reviewSummary()),
    ).rejects.toThrow(/pagination exceeded 20 pages/);

    const gets = calls.filter((call) => call.method === "GET");
    expect(gets).toHaveLength(20);
    expect(gets.map((call) => call.search)).toContain("?per_page=100&page=20");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("throws when GraphQL pagination hits the 20-page cap", async () => {
    let count = 0;
    const { fetchFn, calls } = recording(() => {
      count += 1;
      return threadsResponse([], true, `CURSOR-${count}`);
    });

    await expect(
      listBugbotThreads(options({ fetch: fetchFn })),
    ).rejects.toThrow(/pagination exceeded 20 pages/);
    expect(calls).toHaveLength(20);
  });

  it("redacts the token and caps the message on an API error", async () => {
    const { fetchFn } = recording(() =>
      json({ message: `bad credential ${TOKEN} ${"x".repeat(400)}` }, 401),
    );

    let caught: unknown;
    try {
      await startCheck(options({ fetch: fetchFn }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitHubError);
    const error = caught as GitHubError;
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted]");
    expect(error.message.length).toBeLessThanOrEqual(200);
  });
});

describe("retry safety (S6A-B1)", () => {
  it("sends a POST review exactly once on a 504", async () => {
    const { fetchFn, calls } = recording(() =>
      json({ message: "gateway timeout" }, 504),
    );

    await expect(
      postReview(options({ fetch: fetchFn, sleep: async () => {} }), [
        plannedComment(),
      ]),
    ).rejects.toMatchObject({ name: "GitHubError", status: 504 });
    expect(calls).toHaveLength(1);
  });

  it("sends a POST issue comment exactly once on a 504", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([])
        : json({ message: "gateway timeout" }, 504),
    );

    await expect(
      upsertSummary(options({ fetch: fetchFn, sleep: async () => {} }), reviewSummary()),
    ).rejects.toMatchObject({ name: "GitHubError", status: 504 });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("sends a POST reply exactly once on a 504", async () => {
    const { fetchFn, calls } = recording(() =>
      json({ message: "gateway timeout" }, 504),
    );
    const logs: string[] = [];

    const result = await resolveFixedThreads(
      options({
        fetch: fetchFn,
        sleep: async () => {},
        log: (line) => logs.push(line),
      }),
      [bugbotThread()],
      HEAD_SHA,
    );

    expect(result).toMatchObject({ resolved: 0, failed: 1 });
    expect(calls).toHaveLength(1);
    expect(logs[0]).toContain("PRRT_1");
    expect(logs[0]).toContain("504");
  });

  it("sends a POST check-run exactly once on a 504", async () => {
    const { fetchFn, calls } = recording(() =>
      json({ message: "gateway timeout" }, 504),
    );

    await expect(
      startCheck(options({ fetch: fetchFn, sleep: async () => {} })),
    ).rejects.toMatchObject({ name: "GitHubError", status: 504 });
    expect(calls).toHaveLength(1);
  });

  it("sends the GraphQL mutation exactly once on a 504", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.path.endsWith("/replies")
        ? json({ id: 1 }, 201)
        : json({ message: "gateway timeout" }, 504),
    );
    const logs: string[] = [];

    const result = await resolveFixedThreads(
      options({
        fetch: fetchFn,
        sleep: async () => {},
        log: (line) => logs.push(line),
      }),
      [bugbotThread()],
      HEAD_SHA,
    );

    expect(result).toMatchObject({ resolved: 0, failed: 1 });
    expect(calls).toHaveLength(2);
    expect(logs[0]).toContain("504");
  });

  it("still retries a 504 on a GET", async () => {
    let calls = 0;
    const { fetchFn } = recording(() => {
      calls += 1;
      return calls === 1
        ? json({ message: "gateway timeout" }, 504)
        : pullResponse();
    });

    const state = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
      sleep: async () => {},
    });

    expect(state.headSha).toBe(HEAD_SHA);
    expect(calls).toBe(2);
  });
});

describe("timeouts (S6A-B2)", () => {
  it("rejects a fetch that never resolves", async () => {
    const fetchFn: FetchLike = () => new Promise<Response>(() => {});

    let caught: unknown;
    try {
      await deadline(
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r",
          prNumber: 1,
          fetch: fetchFn,
          sleep: async () => {},
          timeoutMs: 10,
        }),
        1_500,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as Error).message).toMatch(/timed out/);
  });

  it("rejects a body read that never resolves", async () => {
    const fetchFn: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => new Promise<string>(() => {}),
      }) as unknown as Response;

    let caught: unknown;
    try {
      await deadline(
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r",
          prNumber: 1,
          fetch: fetchFn,
          sleep: async () => {},
          timeoutMs: 10,
        }),
        1_500,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as Error).message).toMatch(/timed out/);
  });

  it("does not retry a timed-out POST", async () => {
    let calls = 0;
    const fetchFn: FetchLike = () => {
      calls += 1;
      return new Promise<Response>(() => {});
    };

    await expect(
      deadline(
        startCheck(options({ fetch: fetchFn, timeoutMs: 10 })),
        1_500,
      ),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });
});

describe("dry run", () => {
  it("plans every write and makes no fetch call", async () => {
    const { fetchFn, calls } = recording(() => {
      throw new Error("fetch must not be called for a dry-run write");
    });
    const dry = options({ fetch: fetchFn, dryRun: true });

    const started = await startCheck(dry);
    expect(started.id).toBe(0);
    expect(started.planned).toMatchObject({
      method: "POST",
      path: "/repos/o/r/check-runs",
    });

    const finished = await finishCheck(dry, started, "neutral", "done");
    expect(finished).toMatchObject({
      method: "PATCH",
      path: "/repos/o/r/check-runs/0",
    });

    const skipped = await reportSkipped(dry, "skipped");
    expect(skipped.method).toBe("POST");

    const review = await postReview(dry, [plannedComment()]);
    expect(review.posted).toBe(1);
    expect(review.planned[0]?.body).toMatchObject({ event: "COMMENT" });

    const resolved = await resolveFixedThreads(dry, [bugbotThread()], HEAD_SHA);
    expect(resolved).toMatchObject({ resolved: 1, failed: 0 });
    expect(resolved.planned).toHaveLength(2);

    expect(calls).toHaveLength(0);
  });

  it("still reads, then returns the summary request it would send", async () => {
    const { fetchFn, calls } = recording((call) => {
      if (call.method !== "GET") {
        throw new Error("fetch must not be called for a dry-run write");
      }
      return json([]);
    });

    const result = await upsertSummary(
      options({ fetch: fetchFn, dryRun: true }),
      reviewSummary(),
    );

    expect(result.action).toBe("created");
    expect(result.planned).toMatchObject({
      method: "POST",
      path: "/repos/o/r/issues/1/comments",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("returns exactly the request the real mode sends", async () => {
    const dry = await postReview(
      options({
        fetch: async () => {
          throw new Error("no writes in dry run");
        },
        dryRun: true,
      }),
      [plannedComment()],
    );
    const real = recording(() => json({ id: 1 }, 201));
    const sent = await postReview(options({ fetch: real.fetchFn }), [
      plannedComment(),
    ]);

    expect(dry.planned[0]).toEqual(sent.planned[0]);
    expect(real.calls[0]?.body).toEqual(dry.planned[0]?.body);
  });

  it("reads review threads but never resolves them (S6A-B3)", async () => {
    const { fetchFn, calls } = recording((call) => {
      if (call.path === "/graphql") {
        return threadsResponse([threadNode([botComment()])]);
      }
      throw new Error("fetch must not be called for a dry-run write");
    });
    const dry = options({ fetch: fetchFn, dryRun: true });

    const threads = await listBugbotThreads(dry);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadId).toBe("PRRT_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/graphql");

    const resolved = await resolveFixedThreads(dry, threads, HEAD_SHA);
    expect(resolved).toMatchObject({ resolved: 1, failed: 0 });
    expect(resolved.planned).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });
});

describe("write surface", () => {
  it("sends only allowlisted requests and only COMMENT reviews", async () => {
    const { fetchFn, calls } = recording((call) => {
      if (call.method === "GET") {
        return json([]);
      }
      if (call.path === "/graphql") {
        return json({
          data: {
            resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
          },
        });
      }
      if (call.path.endsWith("/check-runs")) {
        return json({ id: 7 }, 201);
      }
      return json({ id: 8 }, 201);
    });

    const base = options({ fetch: fetchFn });
    const started = await startCheck(base);
    await finishCheck(base, started, "success", "clean");
    await reportSkipped(base, "skipped");
    await postReview(base, [plannedComment()]);
    await upsertSummary(base, reviewSummary());
    await resolveFixedThreads(base, [bugbotThread()], HEAD_SHA);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(() =>
        assertAllowedRequest({
          method: call.method,
          path: call.path,
          body: call.body,
        }),
      ).not.toThrow();
    }

    for (const body of reviewBodies(calls)) {
      expect(body.event).toBe("COMMENT");
    }
  });
});

describe("mutation gaps (S6A-N1)", () => {
  it("M10: ignores a thread whose first comment is human even if a later one is the bot", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([
          comment("a-human", "this thread starts with a human"),
          botComment(),
        ]),
      ]),
    );

    expect(await listBugbotThreads(options({ fetch: fetchFn }))).toEqual([]);
  });

  it("M13: does not trust a prefix login as the bot", async () => {
    const body = formatComment(plannedComment(), "12345", HEAD_SHA);
    for (const login of [
      "andura-bugbot-fan",
      "andura-bugbot2",
      "andura-bugbot-extra",
    ]) {
      const { fetchFn } = recording(() =>
        threadsResponse([threadNode([comment(login, body, 1001, "Bot")])]),
      );
      expect(await listBugbotThreads(options({ fetch: fetchFn }))).toEqual([]);
    }
  });

  it("M13: does not edit a prefix login's summary comment", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([
            {
              id: 61,
              user: restUser("andura-bugbot-fan", "Bot"),
              body: "look-alike\n<!-- bugbot:summary -->",
            },
          ])
        : json({ id: 62 }, 201),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("created");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("M14: ignores a bot thread without a marker", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([threadNode([comment(BOT, "a plain bot comment")])]),
    );

    expect(await listBugbotThreads(options({ fetch: fetchFn }))).toEqual([]);
  });

  it("M33: creates a summary when the bot comment has no marker", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([botSummaryComment(55, "a bot comment without the marker")])
        : json({ id: 56 }, 201),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("created");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("X10: does not fall back when the batch review returns a 5xx", async () => {
    const { fetchFn, calls } = recording(() =>
      json({ message: "server error" }, 500),
    );

    await expect(
      postReview(options({ fetch: fetchFn }), [
        plannedComment(),
        plannedComment({ file: "src/b.ts", line: 20 }),
      ]),
    ).rejects.toMatchObject({ name: "GitHubError", status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("X05: rejects a lowercase comment event at the guard", () => {
    expect(() =>
      assertAllowedRequest({
        method: "POST",
        path: "/repos/o/r/pulls/1/reviews",
        body: { event: "comment" },
      }),
    ).toThrow(/COMMENT/);
  });

  it("X04: parses an HTTP-date Retry-After", async () => {
    let calls = 0;
    const delays: number[] = [];
    const { fetchFn } = recording(() => {
      calls += 1;
      return calls === 1
        ? json({ message: "slow down" }, 403, {
            "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
          })
        : pullResponse();
    });

    const state = await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(state.headSha).toBe(HEAD_SHA);
    expect(calls).toBe(2);
    expect(delays).toEqual([0]);
  });
});

describe("redaction layers (S6A-N1)", () => {
  it("redacts an exact token with no gh prefix and its URL-encoded forms", () => {
    const custom = "tok/en+1=zzzz";

    expect(redact(`a ${custom} b`, custom)).toBe("a [redacted] b");
    expect(redact("a tok%2Fen%2B1%3Dzzzz b", custom)).toBe("a [redacted] b");
    expect(redact("a tok%2fen%2b1%3dzzzz b", custom)).toBe("a [redacted] b");
  });

  it("redacts the API message inside errorDetail", () => {
    const custom = "tok/en+1=zzzz";

    expect(errorDetail(JSON.stringify({ message: `bad ${custom}` }), custom)).toBe(
      ": bad [redacted]",
    );
  });

  it("redacts a network error through capError", async () => {
    const custom = "tok/en+1=zzzz";
    const fetchFn: FetchLike = async () => {
      throw new Error(`connect failed for ${custom}`);
    };

    let caught: unknown;
    try {
      await fetchPullRequest({
        token: custom,
        repository: "o/r",
        prNumber: 1,
        fetch: fetchFn,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GitHubError);
    expect((caught as Error).message).not.toContain(custom);
    expect((caught as Error).message).toContain("[redacted]");
  });
});

describe("check-run redaction (S6A-N2)", () => {
  it("scrubs the finishCheck and reportSkipped summaries", async () => {
    const { fetchFn, calls } = recording(() => json({ id: 77 }, 201));

    await finishCheck(
      options({ fetch: fetchFn }),
      { id: 77 },
      "neutral",
      `failed with ${TOKEN}`,
    );
    await reportSkipped(options({ fetch: fetchFn }), `skipped with ${TOKEN}`);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const summary = (call.body as { output: { summary: string } }).output.summary;
      expect(summary).not.toContain(TOKEN);
      expect(summary).toContain("[redacted]");
    }
  });

  it("scrubs the model line with the options token", () => {
    const body = renderSummary(reviewSummary({ model: `m-${TOKEN}` }), TOKEN);

    expect(body).not.toContain(TOKEN);
    expect(body).toContain("- Model: m-[redacted]");
  });
});

describe("skip detection (S6A-N3)", () => {
  it("accepts every skip spelling", async () => {
    const replies = [
      "won’t fix",
      "wont fix",
      "won't fix",
      "wontfix",
      "skip",
      "@andura-bugbot skip",
      "ok, won’t fix",
      "skip this please, it is intentional",
    ];

    for (const reply of replies) {
      const { fetchFn } = recording(() =>
        threadsResponse([threadNode([botComment(), comment("a-human", reply)])]),
      );
      const threads = await listBugbotThreads(options({ fetch: fetchFn }));
      expect(threads[0]?.state, reply).toBe("skipped");
    }
  });

  it("does not treat a negated, quoted or long off-hand mention as skip", async () => {
    const replies = [
      "you can't skip this",
      "You can't skip this, it is a real bug",
      "you can’t skip this",
      "> skip",
      "please do not skip this one, it matters a lot to us",
      "this is not a skip, please keep looking at it",
    ];

    for (const reply of replies) {
      const { fetchFn } = recording(() =>
        threadsResponse([threadNode([botComment(), comment("a-human", reply)])]),
      );
      const threads = await listBugbotThreads(options({ fetch: fetchFn }));
      expect(threads[0]?.state, reply).toBe("open");
    }
  });
});

describe("pagination truncation (S6A-N4, R1-N2)", () => {
  it("treats a bot thread with more comments than one page as skipped", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([botComment()], {
          comments: {
            pageInfo: { hasNextPage: true },
            nodes: [botComment()],
          },
        }),
      ]),
    );

    const threads = await listBugbotThreads(
      options({ fetch: fetchFn, log: () => undefined }),
    );
    expect(threads).toHaveLength(1);
    expect(threads[0]?.state).toBe("skipped");
  });

  it("ignores a long human-only thread before the comment-page check", async () => {
    const body = formatComment(plannedComment(), "12345", HEAD_SHA);
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([comment("a-human", body)], {
          comments: {
            pageInfo: { hasNextPage: true },
            nodes: [comment("a-human", body)],
          },
        }),
      ]),
    );

    expect(await listBugbotThreads(options({ fetch: fetchFn }))).toEqual([]);
  });
});

describe("bot account type (S6A-N7)", () => {
  it("rejects a plain User named like the bot in GraphQL", async () => {
    const body = formatComment(plannedComment(), "12345", HEAD_SHA);
    const { fetchFn } = recording(() =>
      threadsResponse([threadNode([comment(BOT, body, 1001, "User")])]),
    );

    expect(await listBugbotThreads(options({ fetch: fetchFn }))).toEqual([]);
  });

  it("rejects a plain User named like the bot in a REST summary", async () => {
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([
            {
              id: 71,
              user: restUser(BOT, "User"),
              body: "look-alike\n<!-- bugbot:summary -->",
            },
          ])
        : json({ id: 72 }, 201),
    );

    const result = await upsertSummary(options({ fetch: fetchFn }), reviewSummary());

    expect(result.action).toBe("created");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

describe("blank botLogin", () => {
  it("falls back to the default for an empty or whitespace login", async () => {
    const threads = recording(() =>
      threadsResponse([threadNode([botComment()])]),
    );
    expect(
      await listBugbotThreads(
        options({ fetch: threads.fetchFn, botLogin: "   " }),
      ),
    ).toHaveLength(1);

    const summaries = recording((call) =>
      call.method === "GET"
        ? json([botSummaryComment(55, "old\n<!-- bugbot:summary -->")])
        : json({ id: 55 }),
    );
    const result = await upsertSummary(
      options({ fetch: summaries.fetchFn, botLogin: "" }),
      reviewSummary(),
    );
    expect(result.action).toBe("updated");
  });
});

// --- step 6b additions ----------------------------------------------------

const SHA = HEAD_SHA;

function rawText(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}

describe("allowlist additions (step 6b)", () => {
  it("accepts the diff, contents and check-run reads with their query keys", () => {
    const allowed = [
      {
        method: "GET",
        path: "/repos/o/r/pulls/1",
        accept: "application/vnd.github.diff",
      },
      {
        method: "GET",
        path: "/repos/o/r/contents/src/a.ts",
        query: { ref: SHA },
        accept: "application/vnd.github.raw",
      },
      {
        method: "GET",
        path: `/repos/o/r/commits/${SHA}/check-runs`,
        query: {
          check_name: "bugbot",
          filter: "all",
          per_page: 100,
          page: 1,
        },
      },
      {
        method: "GET",
        path: "/repos/o/r/issues/1/comments",
        query: { per_page: 100, page: 2 },
      },
    ];

    for (const request of allowed) {
      expect(() => assertAllowedRequest(request)).not.toThrow();
    }
  });

  it("rejects traversal, encoded separators, extra query keys and contents writes", () => {
    const rejected = [
      { method: "GET", path: "/repos/o/r/contents/../secrets" },
      { method: "GET", path: "/repos/o/r/contents/a/./b.ts" },
      { method: "GET", path: "/repos/o/r/contents/a/%2e%2e/b.ts" },
      { method: "GET", path: "/repos/o/r/contents/a%2Fb.ts" },
      { method: "GET", path: "/repos/o/r/contents/a%5Cb.ts" },
      { method: "GET", path: "/repos/o/r/contents//a.ts" },
      {
        method: "GET",
        path: "/repos/o/r/contents/a.ts",
        query: { ref: SHA, extra: "1" },
      },
      {
        method: "GET",
        path: "/repos/o/r/contents/a.ts",
        query: { ref: "A".repeat(40) },
      },
      {
        method: "GET",
        path: "/repos/o/r/contents/a.ts",
        query: { ref: "a".repeat(39) },
      },
      {
        method: "GET",
        path: `/repos/o/r/commits/${SHA}/check-runs`,
        query: { check_name: "other" },
      },
      {
        method: "GET",
        path: `/repos/o/r/commits/${SHA}/check-runs`,
        query: { check_name: "bugbot", extra: "1" },
      },
      {
        method: "GET",
        path: `/repos/o/r/commits/${SHA}/check-runs`,
        query: { check_name: "bugbot", filter: "latest" },
      },
      {
        method: "GET",
        path: "/repos/o/r/pulls/1",
        query: { ref: SHA },
      },
      {
        method: "GET",
        path: "/repos/o/r/pulls/1",
        accept: "application/vnd.github.raw",
      },
      {
        method: "GET",
        path: "/repos/o/r/issues/1/comments",
        accept: "application/vnd.github.diff",
      },
      { method: "PUT", path: "/repos/o/r/contents/a.ts" },
      { method: "DELETE", path: "/repos/o/r/contents/a.ts" },
      { method: "POST", path: "/repos/o/r/contents/a.ts" },
    ];

    for (const request of rejected) {
      expect(() => assertAllowedRequest(request)).toThrow();
    }
  });
});

describe("fetchPullRequestDiff", () => {
  it("reads the diff media type and returns the raw body", async () => {
    const { fetchFn, calls } = recording(() => rawText("diff --git a/x b/x\n"));

    const diff = await fetchPullRequestDiff({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
    });

    expect(diff).toBe("diff --git a/x b/x\n");
    expect(calls[0]?.path).toBe("/repos/o/r/pulls/1");
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.diff");
  });

  it("refuses a body over 5 MB and a 406 or 422", async () => {
    const big = recording(() =>
      rawText("x", 200, { "content-length": String(5 * 1024 * 1024 + 1) }),
    );
    await expect(
      fetchPullRequestDiff({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: big.fetchFn,
      }),
    ).rejects.toThrow(/too large/);

    for (const status of [406, 422]) {
      const refused = recording(() => json({ message: "diff too large" }, status));
      await expect(
        fetchPullRequestDiff({
          token: TOKEN,
          repository: "o/r",
          prNumber: 1,
          fetch: refused.fetchFn,
        }),
      ).rejects.toThrow(/too large/);
    }
  });

  it("passes a 500 through as a normal GitHub error", async () => {
    const failed = recording(() => json({ message: "boom" }, 500));
    await expect(
      fetchPullRequestDiff({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: failed.fetchFn,
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("readRepositoryFile", () => {
  it("reads a file at the exact ref with the raw media type", async () => {
    const { fetchFn, calls } = recording(() => rawText("export const a = 1;\n"));

    const content = await readRepositoryFile({
      token: TOKEN,
      repository: "o/r",
      path: "src/a.ts",
      ref: SHA,
      fetch: fetchFn,
    });

    expect(content).toBe("export const a = 1;\n");
    expect(calls[0]?.path).toBe("/repos/o/r/contents/src/a.ts");
    expect(calls[0]?.search).toBe(`?ref=${SHA}`);
    expect(calls[0]?.headers.Accept).toBe("application/vnd.github.raw");
  });

  it("encodes each path segment and never collapses a literal percent", async () => {
    const { fetchFn, calls } = recording(() => rawText("x"));

    await readRepositoryFile({
      token: TOKEN,
      repository: "o/r",
      path: "src/a b#c?d%2Fe.ts",
      ref: SHA,
      fetch: fetchFn,
    });

    expect(calls[0]?.path).toBe(
      "/repos/o/r/contents/src/a%20b%23c%3Fd%252Fe.ts",
    );
  });

  it("returns null for 404, 403 and an over-1-MB body", async () => {
    for (const status of [403, 404, 413]) {
      const missing = recording(() => json({ message: "no" }, status));
      expect(
        await readRepositoryFile({
          token: TOKEN,
          repository: "o/r",
          path: "src/a.ts",
          ref: SHA,
          fetch: missing.fetchFn,
        }),
      ).toBeNull();
    }

    const hugeHeader = recording(() =>
      rawText("x", 200, { "content-length": String(1024 * 1024 + 1) }),
    );
    expect(
      await readRepositoryFile({
        token: TOKEN,
        repository: "o/r",
        path: "src/a.ts",
        ref: SHA,
        fetch: hugeHeader.fetchFn,
      }),
    ).toBeNull();

    const hugeBody = recording(() => rawText("x".repeat(1024 * 1024 + 1)));
    expect(
      await readRepositoryFile({
        token: TOKEN,
        repository: "o/r",
        path: "src/a.ts",
        ref: SHA,
        fetch: hugeBody.fetchFn,
      }),
    ).toBeNull();
  });

  it("refuses unsafe paths before any request", async () => {
    const { fetchFn, calls } = recording(() => {
      throw new Error("fetch must not be called for an unsafe path");
    });

    const unsafe = ["../x", "a/../b", "a/./b", "/a", "a//b", "a\u0000b"];
    for (const path of unsafe) {
      await expect(
        readRepositoryFile({
          token: TOKEN,
          repository: "o/r",
          path,
          ref: SHA,
          fetch: fetchFn,
        }),
      ).rejects.toThrow(/unsafe path/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("listCheckRuns", () => {
  it("returns every bugbot run with its status and asks for filter=all", async () => {
    const { fetchFn, calls } = recording(() =>
      json({
        check_runs: [
          { id: 5, name: "bugbot", external_id: "999", status: "completed" },
          {
            id: 88,
            name: "bugbot",
            external_id: "12345",
            status: "in_progress",
          },
          { id: 99, name: "other", external_id: "12345", status: "in_progress" },
        ],
      }),
    );

    const found = await listCheckRuns(options({ fetch: fetchFn }));

    expect(found).toEqual([
      {
        id: 5,
        status: "completed",
        externalId: "999",
        appId: null,
        conclusion: null,
      },
      {
        id: 88,
        status: "in_progress",
        externalId: "12345",
        appId: null,
        conclusion: null,
      },
    ]);
    expect(calls[0]?.path).toBe(`/repos/o/r/commits/${SHA}/check-runs`);
    expect(calls[0]?.search).toContain("check_name=bugbot");
    expect(calls[0]?.search).toContain("filter=all");
    expect(calls[0]?.search).toContain(`per_page=100`);
  });

  it("reads the app id of each run", async () => {
    const { fetchFn } = recording(() =>
      json({
        check_runs: [
          {
            id: 5,
            name: "bugbot",
            external_id: "1",
            status: "in_progress",
            app: { id: 4242 },
          },
          { id: 6, name: "bugbot", external_id: "2", status: "in_progress", app: {} },
        ],
      }),
    );

    const found = await listCheckRuns(options({ fetch: fetchFn }));

    expect(found.map((run) => run.appId)).toEqual([4242, null]);
  });

  it("returns an empty list when no run matches", async () => {
    const { fetchFn } = recording(() =>
      json({
        check_runs: [
          { id: 5, name: "other", external_id: "999", status: "in_progress" },
        ],
      }),
    );
    expect(await listCheckRuns(options({ fetch: fetchFn }))).toEqual([]);
  });

  it("reads the conclusion and can list another commit (S8D-B3)", async () => {
    const other = "d".repeat(40);
    const { fetchFn, calls } = recording(() =>
      json({
        check_runs: [
          {
            id: 5,
            name: "bugbot",
            external_id: "999",
            status: "completed",
            conclusion: "success",
            app: { id: 4242 },
          },
          {
            id: 6,
            name: "bugbot",
            external_id: "1000",
            status: "completed",
            conclusion: "neutral",
          },
        ],
      }),
    );

    const found = await listCheckRuns(options({ fetch: fetchFn }), other);

    expect(found.map((run) => run.conclusion)).toEqual(["success", "neutral"]);
    expect(calls[0]?.path).toBe(`/repos/o/r/commits/${other}/check-runs`);
  });
});

describe("summary state and pass count", () => {
  it("findSummary returns the bot body and upsertSummary reuses it", async () => {
    const oldBody = "old body\n<!-- bugbot:summary -->";
    const { fetchFn, calls } = recording((call) =>
      call.method === "GET"
        ? json([
            { id: 1, user: restUser("a-human", "User"), body: "<!-- bugbot:summary -->" },
            botSummaryComment(77, oldBody),
          ])
        : json({}),
    );

    const found = await findSummary(options({ fetch: fetchFn }));
    expect(found).toEqual({ id: 77, body: oldBody });

    const result = await upsertSummary(
      options({ fetch: fetchFn }),
      reviewSummary({ runs: ["111", "222"] }),
      { previous: found },
    );

    expect(result.action).toBe("updated");
    expect(result.previousBody).toBe(oldBody);
    const patch = calls.find((call) => call.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain(
      "<!-- bugbot:runs 111,222 -->",
    );
  });

  it("renders the hidden runs line, keeps the last 200 and escapes backticks", () => {
    const many = Array.from({ length: 250 }, (_, index) => String(index + 1));
    const body = renderSummary(
      reviewSummary({ runs: many, truncated: ["a`b.ts"] }),
      TOKEN,
    );

    expect(body).toContain("<!-- bugbot:runs 51,");
    expect(body).toContain(",250 -->");
    expect(body).toContain("`a&#96;b.ts`");
    expect(body).not.toContain("`a`b.ts`");
    expect(body.endsWith("Bugbot only comments; it never approves or blocks.")).toBe(true);
  });

  it("caps the rendered summary below GitHub's comment limit", () => {
    const truncated = Array.from(
      { length: 50 },
      (_, index) => `${index}-${"x".repeat(4000)}`,
    );
    const body = renderSummary(
      reviewSummary({ truncated, error: "x".repeat(500) }),
      TOKEN,
    );

    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("_(summary truncated)_");
    expect(body.endsWith("Bugbot only comments; it never approves or blocks.")).toBe(true);
  });
});

describe("base and GraphQL URLs (S6A-N6)", () => {
  it("requires https for GITHUB_API_URL before any request", async () => {
    const { fetchFn, calls } = recording(() => {
      throw new Error("fetch must not run");
    });

    await expect(
      fetchPullRequest({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: fetchFn,
        env: (name) =>
          name === "GITHUB_API_URL" ? "http://evil.test:8080" : "",
      }),
    ).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("requires https for an explicit baseUrl and GITHUB_GRAPHQL_URL", async () => {
    const { fetchFn, calls } = recording(() => {
      throw new Error("fetch must not run");
    });

    await expect(
      fetchPullRequest({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: fetchFn,
        baseUrl: "http://evil.test:8080",
      }),
    ).rejects.toThrow(/https/);

    await expect(
      listBugbotThreads(
        options({
          fetch: fetchFn,
          env: (name) =>
            name === "GITHUB_GRAPHQL_URL" ? "http://evil.test/graphql" : "",
        }),
      ),
    ).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it("routes REST to GITHUB_API_URL and GraphQL to GITHUB_GRAPHQL_URL", async () => {
    const env = (name: string): string =>
      name === "GITHUB_API_URL"
        ? "https://ghe.example/api/v3"
        : name === "GITHUB_GRAPHQL_URL"
          ? "https://ghe.example/api/graphql"
          : "";

    const rest = recording(() => pullResponse());
    await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: rest.fetchFn,
      env,
    });
    expect(rest.calls[0]?.url).toBe(
      "https://ghe.example/api/v3/repos/o/r/pulls/1",
    );

    const graph = recording(() => threadsResponse([]));
    await listBugbotThreads(options({ fetch: graph.fetchFn, env }));
    expect(graph.calls[0]?.url).toBe("https://ghe.example/api/graphql");
  });
});

describe("review-threads query retries (R1-N1)", () => {
  it("retries a 502 on the thread query but not on the resolve mutation", async () => {
    let attempts = 0;
    const query = recording((call) => {
      attempts += 1;
      if (attempts === 1) {
        return json({ message: "gateway" }, 502);
      }
      return threadsResponse([threadNode([botComment()])]);
    });

    const threads = await listBugbotThreads(
      options({ fetch: query.fetchFn, sleep: async () => {} }),
    );
    expect(threads).toHaveLength(1);
    expect(query.calls).toHaveLength(2);
    expect(String((query.calls[0]?.body as { query: string }).query)).toContain(
      "reviewThreads",
    );

    const mutation = recording(() => json({ message: "gateway" }, 502));
    const result = await resolveFixedThreads(
      options({ fetch: mutation.fetchFn, sleep: async () => {} }),
      [bugbotThread({ hasFixedReply: true })],
      HEAD_SHA,
    );
    expect(result).toMatchObject({ resolved: 0, failed: 1 });
    expect(mutation.calls).toHaveLength(1);
  });

  it("retries a timed-out thread query like a GET", async () => {
    let attempts = 0;
    const fetchFn: FetchLike = () => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(threadsResponse([threadNode([botComment()])]));
    };

    const threads = await deadline(
      listBugbotThreads(
        options({ fetch: fetchFn, sleep: async () => {}, timeoutMs: 10 }),
      ),
      1_500,
    );

    expect(threads).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("resolve idempotency (S6A-N9)", () => {
  it("resolves a thread that already has a bot Fixed in reply without replying", async () => {
    const { fetchFn, calls } = recording((call) => {
      if (call.path === "/graphql") {
        return json({
          data: {
            resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
          },
        });
      }
      return json({ id: 1 });
    });

    const result = await resolveFixedThreads(
      options({ fetch: fetchFn }),
      [bugbotThread({ hasFixedReply: true })],
      HEAD_SHA,
    );

    expect(result).toMatchObject({ resolved: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/graphql");
  });

  it("sets hasFixedReply from a bot reply when listing threads", async () => {
    const { fetchFn } = recording(() =>
      threadsResponse([
        threadNode([botComment(), comment(BOT, "Fixed in abc1234.")]),
      ]),
    );

    const threads = await listBugbotThreads(options({ fetch: fetchFn }));
    expect(threads[0]?.hasFixedReply).toBe(true);
  });
});

describe("timeout test gaps (R1-N4)", () => {
  it("passes an AbortSignal to fetch and aborts it on timeout", async () => {
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchFn: FetchLike = (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      call += 1;
      if (call === 1) {
        return Promise.resolve(pullResponse());
      }
      return new Promise<Response>(() => {});
    };

    await fetchPullRequest({
      token: TOKEN,
      repository: "o/r",
      prNumber: 1,
      fetch: fetchFn,
    });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);

    await expect(
      deadline(
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r",
          prNumber: 1,
          fetch: fetchFn,
          sleep: async () => {},
          timeoutMs: 10,
        }),
        1_500,
      ),
    ).rejects.toThrow(/timed out/);

    const timeoutSignals = signals.slice(1);
    expect(timeoutSignals).toHaveLength(3);
    expect(timeoutSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("clears the timeout timer on success and on error", async () => {
    vi.useFakeTimers();
    try {
      const ok = recording(() => pullResponse());
      await fetchPullRequest({
        token: TOKEN,
        repository: "o/r",
        prNumber: 1,
        fetch: ok.fetchFn,
      });
      expect(vi.getTimerCount()).toBe(0);

      const bad = recording(() => json({ message: "boom" }, 500));
      await expect(
        fetchPullRequest({
          token: TOKEN,
          repository: "o/r",
          prNumber: 1,
          fetch: bad.fetchFn,
        }),
      ).rejects.toThrow(/500/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
