import { describe, expect, it } from "vitest";
import { runPrReview, type PrReviewDeps } from "../src/cli.js";
import {
  enclosingSymbol,
  findingHash,
  marker,
  type Finding,
} from "../src/filter.js";
import type { FetchLike } from "../src/model.js";
import { buildRecheckUser } from "../src/recheck.js";

/**
 * End-to-end tests for `bugbot review` (non-local). One fake fetch serves both
 * GitHub and OpenRouter; nothing here touches the network. The fake tokens are
 * assembled from parts so the repo grep stays clean.
 */

const TOKEN = ["ghs", "TESTTOKEN123"].join("_");
const API_KEY = ["sk", "or-v1", "TESTKEY"].join("-");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLD = "c".repeat(40);

const DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,2 +1,4 @@",
  " export function total(order) {",
  "+  const customer = findCustomer(order.customerId);",
  "+  return customer.name;",
  " }",
  "",
].join("\n");

const HEAD_CART = [
  "export function total(order) {",
  "  const customer = findCustomer(order.customerId);",
  "  return customer.name;",
  "}",
  "",
].join("\n");

const BASE_CART = [
  "export function total(order) {",
  "  return 0;",
  "}",
  "",
].join("\n");

/** A diff with a LEFT (removed) line, for the base-content test. */
const LEFT_DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,3 +1,3 @@",
  " export function total(order) {",
  "-  return 0;",
  "+  const customer = findCustomer(order.customerId);",
  " }",
  "",
].join("\n");

const HEAD_LEFT = [
  "export function total(order) {",
  "  const customer = findCustomer(order.customerId);",
  "  return customer.name;",
  "}",
  "",
].join("\n");

const BASE_LEFT = [
  "export function legacyTotal() {",
  "  return 0;",
  "}",
  "",
].join("\n");

/** A legal Linux file name whose `\` becomes `%5C` in the contents route. */
const BACKSLASH_DIFF = [
  "diff --git a/back\\slash.ts b/back\\slash.ts",
  "--- a/back\\slash.ts",
  "+++ b/back\\slash.ts",
  "@@ -0,0 +1 @@",
  "+x",
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,2 +1,4 @@",
  " export function total(order) {",
  "+  const customer = findCustomer(order.customerId);",
  "+  return customer.name;",
  " }",
  "",
].join("\n");

const FINDING = {
  file: "src/cart.ts",
  line: 3,
  side: "RIGHT",
  severity: "high",
  category: "bug",
  confidence: 0.95,
  reason:
    "findCustomer returns undefined for an unknown customerId and customer.name throws.",
  suggested_fix: "Guard the lookup before reading customer.name.",
  angle: "interrogate:correctness",
  symbol: "total",
  triage: "fix",
};

interface Recorded {
  method: string;
  path: string;
  url: string;
  search: string;
  accept: string;
  body: unknown;
  headers: Record<string, string>;
}

interface RestComment {
  id: number;
  user: { login: string; type: "Bot" | "User" };
  body: string;
}

interface World {
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  draft: boolean;
  fork: boolean;
  labels: string[];
  diff: string;
  diffStatus: number;
  diffMessage: string;
  diffContentLength: number | null;
  files: Record<string, string | null>;
  baseFiles: Record<string, string | null>;
  agentsMd: string | null;
  agentsBase: string | null;
  threads: unknown[];
  comments: RestComment[];
  reviewContent: string;
  reviewStatus: number;
  reviewHangs: boolean;
  modelStatus: number;
  modelMessage: string;
  modelInvalidJson: boolean;
  recheckContent: string;
  recheckStatus: number;
  startCheckHangs: boolean;
  startCheckStatus: number;
  finishCheckStatuses: number[];
  checkRuns: Array<{
    id: number;
    name: string;
    external_id: string | null;
    status?: string;
  }>;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    headSha: HEAD,
    baseSha: BASE,
    title: "Add cart totals",
    body: "A test PR body.",
    draft: false,
    fork: false,
    labels: [],
    diff: DIFF,
    diffStatus: 200,
    diffMessage: "diff failed",
    diffContentLength: null,
    files: { "src/cart.ts": HEAD_CART },
    baseFiles: { "src/cart.ts": BASE_CART },
    agentsMd: "# House rules\n\nBe careful.",
    agentsBase: null,
    threads: [],
    comments: [],
    reviewContent: JSON.stringify({ findings: [FINDING] }),
    reviewStatus: 200,
    reviewHangs: false,
    modelStatus: 200,
    modelMessage: "model failed",
    modelInvalidJson: false,
    recheckContent: JSON.stringify({ results: [] }),
    recheckStatus: 200,
    startCheckHangs: false,
    startCheckStatus: 200,
    finishCheckStatuses: [],
    checkRuns: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain", ...headers },
  });
}

function completion(content: string): Response {
  return json({
    id: "gen-test",
    model: "deepseek/test",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 123, completion_tokens: 45 },
  });
}

function botComment(id: number, body: string): Record<string, unknown> {
  return {
    databaseId: id,
    author: { login: "andura-bugbot", __typename: "Bot" },
    body,
  };
}

function humanComment(id: number, body: string): Record<string, unknown> {
  return {
    databaseId: id,
    author: { login: "a-human", __typename: "User" },
    body,
  };
}

function threadNode(
  comments: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "PRRT_1",
    isResolved: false,
    path: "src/cart.ts",
    line: 3,
    originalLine: 3,
    diffSide: "RIGHT",
    comments: { nodes: comments },
    ...overrides,
  };
}

function recordedFetch(world: World): {
  fetchFn: FetchLike;
  calls: Recorded[];
} {
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
      accept: String((init?.headers as Record<string, string>)?.["Accept"] ?? ""),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);

    if (url.host === "openrouter.ai") {
      const messages = (body as { messages: Array<{ content: string }> }).messages;
      if (messages[0]!.content.includes("re-check")) {
        if (world.recheckStatus !== 200) {
          return json({ error: { message: "recheck upstream failed" } }, world.recheckStatus);
        }
        return completion(world.recheckContent);
      }
      if (world.modelStatus !== 200) {
        return json({ error: { message: world.modelMessage } }, world.modelStatus);
      }
      if (world.modelInvalidJson) {
        return completion("this is not json");
      }
      return completion(world.reviewContent);
    }

    if (url.host !== "api.github.com") {
      throw new Error(`unexpected host ${url.host}`);
    }

    if (call.method === "GET" && call.path === "/repos/o/r/pulls/1") {
      if (call.accept === "application/vnd.github.diff") {
        if (world.diffStatus !== 200) {
          return json({ message: world.diffMessage }, world.diffStatus);
        }
        return text(
          world.diff,
          200,
          world.diffContentLength === null
            ? {}
            : { "content-length": String(world.diffContentLength) },
        );
      }
      return json({
        number: 1,
        title: world.title,
        body: world.body,
        draft: world.draft,
        head: {
          sha: world.headSha,
          repo: { full_name: world.fork ? "someone/fork" : "o/r" },
        },
        base: { sha: world.baseSha, repo: { full_name: "o/r" } },
        labels: world.labels.map((name) => ({ name })),
      });
    }

    if (call.method === "GET" && call.path.startsWith("/repos/o/r/contents/")) {
      const path = decodeURIComponent(call.path.slice("/repos/o/r/contents/".length));
      const ref = url.searchParams.get("ref");
      if (path === "AGENTS.md") {
        const value = ref === world.headSha ? world.agentsMd : world.agentsBase;
        return value === null ? json({ message: "Not Found" }, 404) : text(value);
      }
      const source = ref === world.headSha ? world.files : world.baseFiles;
      const value = source[path];
      return value === null || value === undefined
        ? json({ message: "Not Found" }, 404)
        : text(value);
    }

    if (call.method === "GET" && call.path === "/repos/o/r/issues/1/comments") {
      return json(world.comments);
    }

    if (call.method === "POST" && call.path === "/repos/o/r/issues/1/comments") {
      const id = 500 + world.comments.length;
      world.comments.push({
        id,
        user: { login: "andura-bugbot", type: "Bot" },
        body: String((body as { body: string }).body),
      });
      return json({ id }, 201);
    }

    if (call.method === "PATCH" && call.path.startsWith("/repos/o/r/issues/comments/")) {
      const id = Number.parseInt(call.path.slice("/repos/o/r/issues/comments/".length), 10);
      const comment = world.comments.find((item) => item.id === id);
      if (comment !== undefined) {
        comment.body = String((body as { body: string }).body);
      }
      return json({});
    }

    if (call.method === "POST" && call.path === "/repos/o/r/check-runs") {
      if (world.startCheckHangs) {
        return new Promise<Response>(() => {});
      }
      if (world.startCheckStatus !== 200) {
        return json({ message: "check create failed" }, world.startCheckStatus);
      }
      return json({ id: 77 }, 201);
    }

    if (call.method === "PATCH" && call.path.startsWith("/repos/o/r/check-runs/")) {
      const status = world.finishCheckStatuses.shift() ?? 200;
      return status === 200
        ? json({})
        : json({ message: "finish failed" }, status);
    }

    if (
      call.method === "GET" &&
      /^\/repos\/o\/r\/commits\/[0-9a-f]{40}\/check-runs$/.test(call.path)
    ) {
      return json({ check_runs: world.checkRuns });
    }

    if (call.method === "POST" && call.path === "/repos/o/r/pulls/1/reviews") {
      if (world.reviewHangs) {
        return new Promise<Response>(() => {});
      }
      if (world.reviewStatus !== 200) {
        return json({ message: "review rejected" }, world.reviewStatus);
      }
      return json({ id: 900 }, 201);
    }

    if (
      call.method === "POST" &&
      /^\/repos\/o\/r\/pulls\/1\/comments\/[0-9]+\/replies$/.test(call.path)
    ) {
      return json({ id: 901 }, 201);
    }

    if (call.method === "POST" && call.path === "/graphql") {
      const query = String((body as { query: string }).query);
      if (query.includes("reviewThreads")) {
        return json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: world.threads,
                },
              },
            },
          },
        });
      }
      if (query.includes("resolveReviewThread")) {
        return json({
          data: {
            resolveReviewThread: {
              thread: { id: "PRRT_1", isResolved: true },
            },
          },
        });
      }
      throw new Error("unexpected GraphQL document");
    }

    throw new Error(`unexpected request ${call.method} ${call.path}`);
  };

  return { fetchFn, calls };
}

function envWith(values: Record<string, string>): (name: string) => string {
  return (name) => values[name] ?? "";
}

const BASE_ENV: Record<string, string> = {
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
  OPENROUTER_API_KEY: API_KEY,
  BUGBOT_MODEL: "deepseek/test",
  BUGBOT_MAX_TOKENS: "120000",
  BUGBOT_MIN_CONFIDENCE: "0.8",
  BUGBOT_COMMENT_SICKO: "false",
  BUGBOT_DRY_RUN: "false",
  BUGBOT_DRAFT_LABEL: "bugbot",
  BUGBOT_PR_DRAFT: "false",
  BUGBOT_PR_FORK: "false",
  BUGBOT_PR_LABELS: "[]",
};

interface RunResult {
  result: Awaited<ReturnType<typeof runPrReview>>;
  calls: Recorded[];
  logs: string[];
}

async function runReview(
  world: World,
  env: Record<string, string> = {},
  extraDeps: Partial<PrReviewDeps> = {},
  runId = "111",
  eventHeadSha = HEAD,
): Promise<RunResult> {
  const { fetchFn, calls } = recordedFetch(world);
  const logs: string[] = [];
  const result = await runPrReview(
    {
      repository: "o/r",
      prNumber: 1,
      runId,
      token: TOKEN,
      eventHeadSha,
    },
    {
      fetch: fetchFn,
      sleep: async () => {},
      env: envWith({ ...BASE_ENV, ...env }),
      log: (line) => logs.push(line),
      timeoutMs: 50,
      modelTimeoutMs: 50,
      ...extraDeps,
    },
  );
  return { result, calls, logs };
}

function callsWhere(
  calls: readonly Recorded[],
  predicate: (call: Recorded) => boolean,
): Recorded[] {
  return calls.filter(predicate);
}

function reviewCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(calls, (call) => call.path === "/repos/o/r/pulls/1/reviews");
}

function replyCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(calls, (call) => call.path.includes("/comments/") && call.path.endsWith("/replies"));
}

function resolveCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(
    calls,
    (call) =>
      call.path === "/graphql" &&
      String((call.body as { query?: string }).query ?? "").includes(
        "resolveReviewThread",
      ),
  );
}

function threadCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(
    calls,
    (call) =>
      call.path === "/graphql" &&
      String((call.body as { query?: string }).query ?? "").includes(
        "reviewThreads",
      ),
  );
}

function modelCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(calls, (call) => call.url.includes("openrouter.ai"));
}

function recheckModelCalls(calls: readonly Recorded[]): Recorded[] {
  return modelCalls(calls).filter((call) =>
    String(
      (call.body as { messages?: Array<{ content?: string }> }).messages?.[0]
        ?.content ?? "",
    ).includes("re-check"),
  );
}

function mainModelCalls(calls: readonly Recorded[]): Recorded[] {
  return modelCalls(calls).filter(
    (call) => !recheckModelCalls([call]).length,
  );
}

function checkPatches(
  calls: readonly Recorded[],
  id: number,
): Recorded[] {
  return callsWhere(
    calls,
    (call) =>
      call.method === "PATCH" && call.path === `/repos/o/r/check-runs/${id}`,
  );
}

function messageContent(call: Recorded, index: number): string {
  return String(
    (
      call.body as {
        messages?: Array<{ content?: string }>;
      }
    ).messages?.[index]?.content ?? "",
  );
}

function summaryBody(world: World): string {
  const comment = world.comments.find((item) => item.body.includes("<!-- bugbot:summary -->"));
  return comment?.body ?? "";
}

describe("runPrReview pass 1", () => {
  it("posts one COMMENT review, creates the summary and finishes success", async () => {
    const world = makeWorld();
    const { result, calls, logs } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });

    const reviews = reviewCalls(calls);
    expect(reviews).toHaveLength(1);
    const body = reviews[0]!.body as {
      event: string;
      commit_id: string;
      comments: Array<{ body: string; path: string; line: number }>;
    };
    expect(body.event).toBe("COMMENT");
    expect(body.commit_id).toBe(HEAD);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]!.path).toBe("src/cart.ts");
    expect(body.comments[0]!.line).toBe(3);
    expect(body.comments[0]!.body).toContain("<!-- bugbot:v1 id=");
    expect(body.comments[0]!.body).toContain("RUN_ID: 111");

    const summaryPosts = callsWhere(
      calls,
      (call) =>
        call.method === "POST" &&
        call.path === "/repos/o/r/issues/1/comments",
    );
    expect(summaryPosts).toHaveLength(1);
    const summary = String((summaryPosts[0]!.body as { body: string }).body);
    expect(summary).toContain("<!-- bugbot:runs 111 -->");
    expect(summary).toContain("- Passes: 1");
    expect(summary).toContain("- Posted: 1");
    expect(summary).toContain("Bugbot only comments; it never approves or blocks.");

    const start = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect(start).toHaveLength(1);
    expect((start[0]!.body as { status: string }).status).toBe("in_progress");

    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect(finish).toHaveLength(1);
    expect((finish[0]!.body as { status: string }).status).toBe("completed");
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
    expect(logs.some((line) => line.includes("couldn't review"))).toBe(false);
  });

  it("reviews the API head when BUGBOT_HEAD_SHA differs and logs it", async () => {
    const world = makeWorld();
    const differing = await runReview(world, {}, {}, "444", "d".repeat(40));

    expect(
      differing.logs.some((line) => line.includes("differs from the API head")),
    ).toBe(true);
    const start = callsWhere(
      differing.calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect((start[0]!.body as { head_sha: string }).head_sha).toBe(HEAD);
  });
});

describe("runPrReview post failures (S6B-B1)", () => {
  it("ends neutral and shows the failed count when every review POST is 422", async () => {
    const world = makeWorld({ reviewStatus: 422 });
    const { result, calls } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "neutral" });
    expect(result.error).toMatch(/could not be posted/);
    // The batch attempt plus one fallback per comment.
    expect(reviewCalls(calls)).toHaveLength(2);

    const summary = summaryBody(world);
    expect(summary).toContain("- Posted: 0");
    expect(summary).toContain("- Failed to post: 1");
    expect(summary).not.toContain("No findings this pass.");

    const finish = checkPatches(calls, 77);
    expect(finish).toHaveLength(1);
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
  });

  it("does not count an ambiguous timed-out post as posted and ends neutral", async () => {
    const world = makeWorld({ reviewHangs: true });
    const { result, calls, logs } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "neutral" });
    expect(logs.some((line) => line.includes("timed out"))).toBe(true);

    const summary = summaryBody(world);
    expect(summary).toContain("- Posted: 0");
    expect(summary).toContain("- Failed to post: 1");
    expect(summary).not.toContain("No findings this pass.");

    const finish = checkPatches(calls, 77);
    expect(finish).toHaveLength(1);
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
  });
});

describe("runPrReview pass 2 (same findings)", () => {
  it("posts no duplicate and edits the summary in place with pass count 2", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstReview = reviewCalls(first.calls)[0]!;
    const firstBody = (firstReview.body as { comments: Array<{ body: string }> })
      .comments[0]!.body;

    world.threads = [threadNode([botComment(1001, firstBody)])];
    const second = await runReview(world, {}, {}, "222");

    expect(second.result).toMatchObject({ exitCode: 0, conclusion: "success" });
    expect(reviewCalls(second.calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Passes: 2");
    expect(summaryBody(world)).toContain("<!-- bugbot:runs 111,222 -->");
    expect(summaryBody(world)).toContain("- Posted: 0");
    expect(threadCalls(second.calls)).toHaveLength(1);

    const summaryCreates = callsWhere(
      second.calls,
      (call) =>
        call.method === "POST" &&
        call.path === "/repos/o/r/issues/1/comments",
    );
    expect(summaryCreates).toHaveLength(0);
    const summaryEdits = callsWhere(
      second.calls,
      (call) =>
        call.method === "PATCH" &&
        call.path.startsWith("/repos/o/r/issues/comments/"),
    );
    expect(summaryEdits).toHaveLength(1);

    const finish = callsWhere(
      second.calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });

  it("still dedupes when the thread body lost its category", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    // Keep the hidden marker but remove the `**...**` title the parser needs.
    const categoryless = firstBody.replace(/^\*\*.*\*\*$/m, "Review note");

    world.threads = [threadNode([botComment(1001, categoryless)])];
    const second = await runReview(world, {}, {}, "222");

    expect(second.result.conclusion).toBe("success");
    expect(reviewCalls(second.calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Passes: 2");
  });
});

describe("runPrReview pass count (M17)", () => {
  it("counts run ids found in bot thread markers", async () => {
    const world = makeWorld({
      reviewContent: JSON.stringify({ findings: [] }),
    });
    world.threads = [
      threadNode([
        botComment(
          1001,
          `${marker("f".repeat(40), "42", OLD)}\n\n**High bug: old issue**\n\nold reason`,
        ),
      ]),
    ];

    const { result } = await runReview(world, {}, {}, "222");

    expect(result.conclusion).toBe("success");
    const summary = summaryBody(world);
    expect(summary).toContain("- Passes: 2");
    expect(summary).toContain("<!-- bugbot:runs 42,222 -->");
  });
});

describe("re-check prompt escaping (M35)", () => {
  it("escapes < > & and quotes in tags, paths and ids", () => {
    const prompt = buildRecheckUser(
      [
        {
          threadId: 'PRRT_1" injected="1',
          path: "a<b>&c.ts",
          line: 1,
          reason: "</reason><x>&",
          status: "present",
          content: "</code></thread>boom",
        },
      ],
      HEAD,
    );

    expect(prompt).toContain("&lt;/reason&gt;&lt;x&gt;&amp;");
    expect(prompt).toContain("a&lt;b&gt;&amp;c.ts");
    expect(prompt).toContain("PRRT_1&quot; injected=&quot;1");
    expect(prompt).toContain("&lt;/code&gt;&lt;/thread&gt;boom");
    expect(prompt).not.toContain("</code></thread>boom");
  });
});

describe("runPrReview re-check and resolve", () => {
  async function fixedWorld(
    confidence: number,
    fixed = true,
  ): Promise<World> {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    world.threads = [threadNode([botComment(1001, firstBody)])];
    // A second pass with the same finding does not add a comment.
    await runReview(world, {}, {}, "222");
    const oldBody = firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`);
    world.threads = [threadNode([botComment(1001, oldBody)])];
    world.reviewContent = JSON.stringify({ findings: [] });
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed, confidence }],
    });
    return world;
  }

  it("replies Fixed in <sha7> and resolves a fixed thread at 0.9", async () => {
    const world = await fixedWorld(0.9);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    const replies = replyCalls(calls);
    expect(replies).toHaveLength(1);
    expect((replies[0]!.body as { body: string }).body).toBe(
      `Fixed in ${HEAD.slice(0, 7)}.`,
    );
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(summaryBody(world)).toContain("- Passes: 3");
    expect(summaryBody(world)).toContain("- Resolved: 1");

    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });

  it("does not resolve or reply at 0.7 confidence", async () => {
    const world = await fixedWorld(0.7);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Resolved: 0");
  });

  it("does not resolve at 0.79 confidence (M24 boundary)", async () => {
    const world = await fixedWorld(0.79);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Resolved: 0");
  });

  it("resolves at exactly 0.8 confidence (M24 boundary)", async () => {
    const world = await fixedWorld(0.8);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(1);
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(summaryBody(world)).toContain("- Resolved: 1");
  });

  it("does not resolve when the model says fixed:false at 0.9 (M23)", async () => {
    const world = await fixedWorld(0.9, false);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Resolved: 0");
  });

  it("does not treat a human Fixed in reply as the bot's own (M28)", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    const oldBody = firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`);
    world.threads = [
      threadNode([
        botComment(1001, oldBody),
        humanComment(1002, "Fixed in abc1234."),
      ]),
    ];
    world.reviewContent = JSON.stringify({ findings: [] });
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    // A human reply must not satisfy S6A-N9, so the bot still replies once.
    expect(replyCalls(calls)).toHaveLength(1);
    expect(resolveCalls(calls)).toHaveLength(1);
  });

  it("leaves an outdated thread (line null) out of the re-check (S6B-N5a)", async () => {
    const world = await fixedWorld(0.9);
    world.threads = world.threads.map((node) => {
      const record = node as Record<string, unknown>;
      return { ...record, line: null, originalLine: 3 };
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  it("never resolves a thread whose hash the main call re-reported (S6B-N5b)", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    world.threads = [
      threadNode([
        botComment(1001, firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`)),
      ]),
    ];
    // The main call reports the same finding again: it is a cross-pass
    // duplicate, and the thread must stay open rather than be resolved.
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Skipped: 1");
    expect(summary).toContain("- Resolved: 0");
  });

  it("re-checks only the 15 oldest eligible threads (M09)", async () => {
    const world = makeWorld({ reviewContent: JSON.stringify({ findings: [] }) });
    world.threads = Array.from({ length: 20 }, (_, index) =>
      threadNode(
        [
          botComment(
            1000 + index,
            `${marker(
              `${String(index).padStart(2, "0")}${"a".repeat(38)}`,
              "7",
              OLD,
            )}\n\n**High bug: old issue ${index}**\n\nold reason ${index}`,
          ),
        ],
        { id: `PRRT_${index}` },
      ),
    );
    world.recheckContent = JSON.stringify({
      results: Array.from({ length: 20 }, (_, index) => ({
        thread: `PRRT_${index}`,
        fixed: true,
        confidence: 0.9,
      })),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked.match(/<thread id="PRRT_/g)).toHaveLength(15);
    expect(asked).toContain('id="PRRT_14"');
    expect(asked).not.toContain('id="PRRT_15"');
    expect(replyCalls(calls)).toHaveLength(15);
    expect(resolveCalls(calls)).toHaveLength(15);
  });

  it("never resolves a human won't-fix thread and never re-posts its hash", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    world.threads = [
      threadNode([botComment(1001, firstBody), humanComment(1002, "won't fix, intended")]),
    ];

    const second = await runReview(world, {}, {}, "222");

    expect(second.result.conclusion).toBe("success");
    expect(reviewCalls(second.calls)).toHaveLength(0);
    expect(replyCalls(second.calls)).toHaveLength(0);
    expect(resolveCalls(second.calls)).toHaveLength(0);
    expect(threadCalls(second.calls)).toHaveLength(1);
  });

  it("resolves a half-finished thread without a second reply", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    const oldBody = firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`);
    world.threads = [
      threadNode([botComment(1001, oldBody), botComment(1002, "Fixed in abc1234.")]),
    ];
    world.reviewContent = JSON.stringify({ findings: [] });
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(1);
  });

  it("logs a failed re-check and still succeeds with nothing resolved", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    world.threads = [
      threadNode([botComment(1001, firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`))]),
    ];
    world.reviewContent = JSON.stringify({ findings: [] });
    world.recheckStatus = 500;

    const { result, calls, logs } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(resolveCalls(calls)).toHaveLength(0);
    expect(logs.some((line) => line.includes("re-check failed"))).toBe(true);
    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });
});

describe("runPrReview failures", () => {
  const cases: Array<{
    name: string;
    setup: (world: World) => void;
    env?: Record<string, string>;
    reason: RegExp;
  }> = [
    {
      name: "model error",
      setup: (world) => {
        world.modelStatus = 500;
      },
      reason: /model failed/,
    },
    {
      name: "bad model JSON",
      setup: (world) => {
        world.modelInvalidJson = true;
      },
      reason: /not JSON/,
    },
    {
      name: "missing OpenRouter key",
      setup: () => {},
      env: { OPENROUTER_API_KEY: "" },
      reason: /OPENROUTER_API_KEY is not set/,
    },
    {
      name: "diff too large",
      setup: (world) => {
        world.diffContentLength = 6 * 1024 * 1024;
      },
      reason: /too large/,
    },
    {
      name: "GitHub 500 on the diff",
      setup: (world) => {
        world.diffStatus = 500;
      },
      reason: /returned 500/,
    },
  ];

  for (const item of cases) {
    it(`${item.name} ends neutral, exits 0 and writes the reason`, async () => {
      const world = makeWorld();
      item.setup(world);
      const { result, calls } = await runReview(world, item.env ?? {});

      expect(result.exitCode).toBe(0);
      expect(result.conclusion).toBe("neutral");
      expect(result.error).toMatch(item.reason);

      const finish = callsWhere(
        calls,
        (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
      );
      expect(finish).toHaveLength(1);
      expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("neutral");
      expect(summaryBody(world)).toContain("Bugbot couldn't review:");
      expect(summaryBody(world)).toMatch(item.reason);
    });
  }
});

describe("runPrReview lost check handle", () => {
  it("finds the run by external_id and finishes it, with no second create", async () => {
    const world = makeWorld({
      startCheckHangs: true,
      checkRuns: [{ id: 88, name: "bugbot", external_id: "111", status: "in_progress" }],
    });
    const { result, calls, logs } = await runReview(world);

    expect(result.exitCode).toBe(0);
    expect(result.conclusion).toBe("neutral");
    expect(logs.some((line) => line.includes("could not start the check run"))).toBe(true);

    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect(creates).toHaveLength(1);
    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/88",
    );
    expect(finish).toHaveLength(1);
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("neutral");

    const lookup = callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path === `/repos/o/r/commits/${HEAD}/check-runs`,
    );
    expect(lookup).toHaveLength(1);
    expect(lookup[0]!.search).toContain("check_name=bugbot");
  });

  it("creates a completed neutral run when the lookup finds none", async () => {
    const world = makeWorld({ startCheckHangs: true, checkRuns: [] });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("neutral");
    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    const inProgress = creates.filter(
      (call) => (call.body as { status?: string }).status === "in_progress",
    );
    const completed = creates.filter(
      (call) => (call.body as { status?: string }).status === "completed",
    );
    expect(inProgress).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect((completed[0]!.body as { conclusion: string }).conclusion).toBe("neutral");
  });
});

describe("runPrReview check lifecycle (S6B-N2)", () => {
  it("retries a 500 from the finish PATCH and completes the check", async () => {
    const world = makeWorld({ finishCheckStatuses: [500, 200] });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const finish = checkPatches(calls, 77);
    expect(finish).toHaveLength(2);
    expect((finish[1]!.body as { conclusion: string }).conclusion).toBe(
      "success",
    );
    expect(logs.some((line) => line.includes("could not finish"))).toBe(false);
  });

  it("creates one completed neutral check when the finish keeps failing", async () => {
    const world = makeWorld({ finishCheckStatuses: [500, 500, 500] });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 77)).toHaveLength(3);

    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect(creates).toHaveLength(2);
    const completed = creates.filter(
      (call) => (call.body as { status?: string }).status === "completed",
    );
    expect(completed).toHaveLength(1);
    expect((completed[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
    expect(
      logs.some((line) => line.includes("could not finish the check run")),
    ).toBe(true);
  });

  it("completes a stale in_progress check from another run at pass start", async () => {
    const world = makeWorld({
      checkRuns: [
        { id: 50, name: "bugbot", external_id: "999", status: "in_progress" },
        { id: 51, name: "bugbot", external_id: "111", status: "in_progress" },
      ],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const lookups = callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path === `/repos/o/r/commits/${HEAD}/check-runs`,
    );
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(lookups[0]!.search).toContain("filter=all");

    const stale = checkPatches(calls, 50);
    expect(stale).toHaveLength(1);
    expect((stale[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
    // This pass's own run must be left alone.
    expect(checkPatches(calls, 51)).toHaveLength(0);
  });

  it("finishes every in_progress run for this run id when the handle is lost", async () => {
    const world = makeWorld({
      startCheckHangs: true,
      checkRuns: [
        { id: 50, name: "bugbot", external_id: "111", status: "in_progress" },
        { id: 51, name: "bugbot", external_id: "111", status: "in_progress" },
        { id: 52, name: "bugbot", external_id: "111", status: "completed" },
      ],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("neutral");
    expect(checkPatches(calls, 50)).toHaveLength(1);
    expect(checkPatches(calls, 51)).toHaveLength(1);
    expect(checkPatches(calls, 52)).toHaveLength(0);

    const lookups = callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path === `/repos/o/r/commits/${HEAD}/check-runs`,
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.search).toContain("filter=all");
  });
});

describe("runPrReview gate", () => {
  it("skips a draft without the label and makes no model call", async () => {
    const world = makeWorld({ draft: true, labels: ["needs-review"] });
    const { result, calls } = await runReview(world, {
      BUGBOT_PR_DRAFT: "true",
      BUGBOT_PR_LABELS: JSON.stringify(["needs-review"]),
    });

    expect(result).toMatchObject({ exitCode: 0, conclusion: "skipped" });
    expect(callsWhere(calls, (call) => call.url.includes("openrouter.ai"))).toHaveLength(0);
    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect(creates).toHaveLength(1);
    expect((creates[0]!.body as { status: string }).status).toBe("completed");
    expect((creates[0]!.body as { conclusion: string }).conclusion).toBe("neutral");
    expect(
      String((creates[0]!.body as { output: { summary: string } }).output.summary),
    ).toContain("Bugbot skipped: draft");
  });

  it("skips a fork and makes no model call", async () => {
    const world = makeWorld({ fork: true });
    const { result, calls } = await runReview(world, { BUGBOT_PR_FORK: "true" });

    expect(result).toMatchObject({ exitCode: 0, conclusion: "skipped" });
    expect(callsWhere(calls, (call) => call.url.includes("openrouter.ai"))).toHaveLength(0);
  });

  it("reviews a draft that carries the configured label", async () => {
    const world = makeWorld({ draft: true, labels: ["review-me"] });
    const { result, calls } = await runReview(world, {
      BUGBOT_PR_DRAFT: "true",
      BUGBOT_PR_LABELS: JSON.stringify(["review-me"]),
      BUGBOT_DRAFT_LABEL: "review-me",
    });

    expect(result.conclusion).toBe("success");
    expect(callsWhere(calls, (call) => call.url.includes("openrouter.ai"))).toHaveLength(1);
    expect(summaryBody(world)).toContain("- Passes: 1");
  });
});

describe("runPrReview dry run", () => {
  it("calls the model, sends no GitHub write, and prints every plan", async () => {
    const world = makeWorld();
    const { result, calls, logs } = await runReview(world, { BUGBOT_DRY_RUN: "true" });

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    const modelCalls = callsWhere(calls, (call) => call.url.includes("openrouter.ai"));
    expect(modelCalls).toHaveLength(1);

    const writes = callsWhere(
      calls,
      (call) =>
        call.url.includes("api.github.com") &&
        call.method !== "GET" &&
        !(
          call.path === "/graphql" &&
          String((call.body as { query?: string }).query ?? "").includes("reviewThreads")
        ),
    );
    expect(writes).toHaveLength(0);

    expect(logs).toContainEqual(expect.stringContaining("Dry run plan: POST /repos/o/r/pulls/1/reviews"));
    expect(logs).toContainEqual(expect.stringContaining("Dry run plan: POST /repos/o/r/check-runs"));
    expect(logs).toContainEqual(expect.stringContaining("Dry run plan: PATCH /repos/o/r/check-runs/0"));
    expect(logs).toContainEqual(expect.stringContaining("Dry run plan: POST /repos/o/r/issues/1/comments"));
    expect(summaryBody(world)).toBe("");
  });
});

describe("runPrReview contents reads", () => {
  it("never requests a path outside the diff (except AGENTS.md)", async () => {
    const world = makeWorld();
    const { calls } = await runReview(world);
    const contents = callsWhere(calls, (call) => call.path.startsWith("/repos/o/r/contents/"));
    expect(contents.length).toBeGreaterThan(0);

    const paths = contents.map((call) =>
      decodeURIComponent(call.path.slice("/repos/o/r/contents/".length)),
    );
    for (const path of paths) {
      expect(["src/cart.ts", "AGENTS.md"]).toContain(path);
    }
    const headReads = contents.filter((call) => call.search.includes(`ref=${HEAD}`));
    expect(headReads.some((call) => call.path.endsWith("/src/cart.ts"))).toBe(true);
  });

  it("rejects a diff path containing .. before any contents request", async () => {
    const evilDiff = [
      "diff --git a/../evil.ts b/../evil.ts",
      "--- a/../evil.ts",
      "+++ b/../evil.ts",
      "@@ -0,0 +1 @@",
      "+stolen",
      "",
    ].join("\n");
    const world = makeWorld({ diff: evilDiff });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("neutral");
    expect(result.error).toMatch(/unsafe path/);
    expect(
      callsWhere(calls, (call) => call.path.includes("/contents/")),
    ).toHaveLength(0);
  });

  it("skips a refused file name and reviews the rest (S6B-N4)", async () => {
    const world = makeWorld({
      diff: BACKSLASH_DIFF,
      files: { "src/cart.ts": HEAD_CART },
    });
    const { result, calls, logs } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    expect(reviewCalls(calls)).toHaveLength(1);
    const comments = (
      reviewCalls(calls)[0]!.body as { comments: Array<{ path: string }> }
    ).comments;
    expect(comments.map((comment) => comment.path)).toEqual(["src/cart.ts"]);
    expect(
      logs.some(
        (line) =>
          line.includes("skipping") && line.includes("back\\slash.ts"),
      ),
    ).toBe(true);
    // The refused path is never sent to fetch.
    expect(
      callsWhere(calls, (call) => call.path.includes("back%5Cslash.ts")),
    ).toHaveLength(0);
  });

  it("hashes a LEFT finding with the base content symbol (M19)", async () => {
    const leftFinding: Finding = {
      file: "src/cart.ts",
      line: 2,
      side: "LEFT",
      severity: "high",
      category: "bug",
      confidence: 0.95,
      reason: "legacyTotal can return zero and the caller divides by it.",
      suggested_fix: "Return a non-zero total or guard the division.",
      angle: "interrogate:correctness",
      symbol: "total",
      triage: "fix",
    };
    const world = makeWorld({
      diff: LEFT_DIFF,
      files: { "src/cart.ts": HEAD_LEFT },
      baseFiles: { "src/cart.ts": BASE_LEFT },
      reviewContent: JSON.stringify({ findings: [leftFinding] }),
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const reviews = reviewCalls(calls);
    expect(reviews).toHaveLength(1);
    const body = (
      reviews[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    const expected = findingHash(leftFinding, "legacyTotal");
    expect(enclosingSymbol(BASE_LEFT, 2)).toBe("legacyTotal");
    expect(body).toContain(`id=${expected}`);

    const baseReads = callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path.endsWith("/contents/src/cart.ts") &&
        call.search.includes(`ref=${BASE}`),
    );
    expect(baseReads).toHaveLength(1);
  });

  it("falls back to AGENTS.md from the base sha (M20)", async () => {
    const world = makeWorld({ agentsMd: null, agentsBase: "# base agents" });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const main = mainModelCalls(calls);
    expect(main).toHaveLength(1);
    expect(messageContent(main[0]!, 1)).toContain("# base agents");
    const agentsBaseReads = callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path.endsWith("/contents/AGENTS.md") &&
        call.search.includes(`ref=${BASE}`),
    );
    expect(agentsBaseReads).toHaveLength(1);
  });
});

describe("runPrReview secrets", () => {
  it("never lets either token into a request body, log, summary or error", async () => {
    const success = makeWorld();
    const successRun = await runReview(success);

    const diffFailure = makeWorld({
      diffStatus: 500,
      diffMessage: `request failed for ${TOKEN}`,
    });
    const diffRun = await runReview(diffFailure);

    const modelFailure = makeWorld({
      modelStatus: 500,
      modelMessage: `upstream rejected ${API_KEY}`,
    });
    const modelRun = await runReview(modelFailure);

    const dryWorld = makeWorld();
    const dryRun = await runReview(dryWorld, { BUGBOT_DRY_RUN: "true" });

    const bodies: string[] = [];
    for (const call of [
      ...successRun.calls,
      ...diffRun.calls,
      ...modelRun.calls,
      ...dryRun.calls,
    ]) {
      bodies.push(JSON.stringify(call.body ?? null));
    }
    for (const comment of success.comments) {
      bodies.push(comment.body);
    }
    for (const comment of diffFailure.comments) {
      bodies.push(comment.body);
    }
    const logs = [
      ...successRun.logs,
      ...diffRun.logs,
      ...modelRun.logs,
      ...dryRun.logs,
    ];
    const errors = [
      successRun.result.error ?? "",
      diffRun.result.error ?? "",
      modelRun.result.error ?? "",
      dryRun.result.error ?? "",
    ];

    for (const text of [...bodies, ...logs, ...errors]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(API_KEY);
    }
  });
});
