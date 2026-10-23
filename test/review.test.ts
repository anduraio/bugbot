import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** The GitHub App that owns this pass's check run in the fake world. */
const APP_ID = 4242;
/** Another app that also happens to name its check `bugbot`. */
const OTHER_APP_ID = 9191;

/** A successful bugbot check on the `before` commit (S8D-B3). */
const BEFORE_SUCCESS = {
  id: 90,
  name: "bugbot",
  external_id: "50",
  status: "completed",
  conclusion: "success",
  app: { id: APP_ID },
};

/** The reviewer's small fixture: a file whose lines 2..9 are all new. */
const P_HEAD_DIFF = [
  "diff --git a/src/p.ts b/src/p.ts",
  "--- a/src/p.ts",
  "+++ b/src/p.ts",
  "@@ -1,2 +1,10 @@",
  " export function p() {",
  "+  const a = 1;",
  "+  const b = 2;",
  "+  const c = 3;",
  "+  const d = 4;",
  "+  const e = 5;",
  "+  const f = 6;",
  "+  const g = 7;",
  "+  const h = 8;",
  " }",
  "",
].join("\n");

const P_HEAD = [
  "export function p() {",
  "  const a = 1;",
  "  const b = 2;",
  "  const c = 3;",
  "  const d = 4;",
  "  const e = 5;",
  "  const f = 6;",
  "  const g = 7;",
  "  const h = 8;",
  "}",
  "",
].join("\n");

const P_BASE = "export function p() {\n}\n";

/** N3: base line 10 was removed; an earlier push shifted it to before line 4. */
const N3_BASE = `${Array.from({ length: 9 }, () => "  filler();").join("\n")}\n  removed();\n`;
const N3_HEAD = `${Array.from({ length: 9 }, () => "  filler();").join("\n")}\n`;
const N3_PR_DIFF = [
  "diff --git a/src/p.ts b/src/p.ts",
  "--- a/src/p.ts",
  "+++ b/src/p.ts",
  "@@ -10,1 +9,0 @@",
  "-  removed();",
  "",
].join("\n");
const N3_COMPARE_DIFF = [
  "diff --git a/src/p.ts b/src/p.ts",
  "--- a/src/p.ts",
  "+++ b/src/p.ts",
  "@@ -4,1 +9,0 @@",
  "-  removed();",
  "",
].join("\n");

/**
 * The L1 file name: a newline, then a workflow command, then a backslash. Git
 * writes it quoted, with `\n` and `\\` as escapes, and the parser decodes it.
 */
const HOSTILE_NAME = "x\n::warning::pwned\\y.ts";
const HOSTILE_QUOTED = String.raw`x\n::warning::pwned\\y.ts`;
const HOSTILE_DIFF = [
  `diff --git "a/${HOSTILE_QUOTED}" "b/${HOSTILE_QUOTED}"`,
  `--- "a/${HOSTILE_QUOTED}"`,
  `+++ "b/${HOSTILE_QUOTED}"`,
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

const LIVE_FIRST_REASON =
  "The discount rounds down before tax, so the total is off by one cent for every order.";
const LIVE_REWORDED_REASON =
  "Rounding happens before tax is applied; each order total can be one cent too low.";

/** Push 1: the off-by-one at line 7. Push 2 only touches the doc line. */
const LIVE_DIFF = [
  "diff --git a/src/discount.ts b/src/discount.ts",
  "--- a/src/discount.ts",
  "+++ b/src/discount.ts",
  "@@ -1,8 +1,8 @@",
  " export function applyDiscount(total: number): number {",
  "   // Applies a ten percent discount.",
  "   const discounted = total * 0.9;",
  "   if (discounted < 0) {",
  "     return 0;",
  "   }",
  "-  return discounted;",
  "+  return Math.round(discounted * 100) / 100;",
  " }",
  "",
].join("\n");

const LIVE_HEAD = [
  "export function applyDiscount(total: number): number {",
  "  // Applies a ten percent discount.",
  "  const discounted = total * 0.9;",
  "  if (discounted < 0) {",
  "    return 0;",
  "  }",
  "  return Math.round(discounted * 100) / 100;",
  "}",
  "",
].join("\n");

const LIVE_BASE = LIVE_HEAD.replace(
  "return Math.round(discounted * 100) / 100;",
  "return discounted;",
);

/**
 * The live step 8d replay: the first pass commented on old line 7. A later push
 * fixed the slice bound on the line above, so GitHub calls the thread outdated
 * (`line` null, `originalLine` 7) while the head still has the fixed code.
 */
const PAGINATION_OLD = [
  "export function page<T>(items: T[], start: number, pageSize: number): T[] {",
  "  const safeStart = start;",
  "  if (start < 0) {",
  "    start = 0;",
  "  }",
  "  if (pageSize <= 0) return [];",
  "  return items.slice(safeStart, pageSize);",
  "}",
  "",
].join("\n");

const PAGINATION_HEAD = [
  "export function page<T>(items: T[], start: number, pageSize: number): T[] {",
  "  const safeStart = start;",
  "  if (start < 0) {",
  "    start = 0;",
  "  }",
  "  if (pageSize <= 0) return [];",
  "  const end = start + pageSize;",
  "  return items.slice(safeStart, end);",
  "}",
  "",
].join("\n");

const PAGINATION_DIFF = [
  "diff --git a/src/pagination.ts b/src/pagination.ts",
  "--- a/src/pagination.ts",
  "+++ b/src/pagination.ts",
  "@@ -1,8 +1,9 @@",
  " export function page<T>(items: T[], start: number, pageSize: number): T[] {",
  "   const safeStart = start;",
  "   if (start < 0) {",
  "     start = 0;",
  "   }",
  "   if (pageSize <= 0) return [];",
  "-  return items.slice(safeStart, pageSize);",
  "+  const end = start + pageSize;",
  "+  return items.slice(safeStart, end);",
  " }",
  "",
].join("\n");

/** A deleted file whose last line carried an outdated thread. */
const DELETED_DIFF = [
  "diff --git a/src/legacy.ts b/src/legacy.ts",
  "deleted file mode 100644",
  "--- a/src/legacy.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const legacy = 1;",
  "-export const old = 2;",
  "",
].join("\n");

/** A one-line change that puts a long head file in the diff. */
const LONG_DIFF = [
  "diff --git a/src/long.ts b/src/long.ts",
  "--- a/src/long.ts",
  "+++ b/src/long.ts",
  "@@ -1,1 +1,1 @@",
  "-const line1 = 0;",
  "+const line1 = 1;",
  "",
].join("\n");

const LONG_HEAD = `${Array.from(
  { length: 420 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
).join("\n")}\n`;

/** A one-line change that puts a very large head file in the diff. */
const BIG_DIFF = [
  "diff --git a/src/big.ts b/src/big.ts",
  "--- a/src/big.ts",
  "+++ b/src/big.ts",
  "@@ -1,1 +1,1 @@",
  "-const line1 = 0;",
  "+const line1 = 1;",
  "",
].join("\n");

const SHORT_HEAD = `${Array.from(
  { length: 100 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
).join("\n")}\n`;

/** The increments of a synchronize pass: only the doc line changed. */
const SYNC_DIFF = [
  "diff --git a/src/discount.ts b/src/discount.ts",
  "--- a/src/discount.ts",
  "+++ b/src/discount.ts",
  "@@ -1,4 +1,4 @@",
  " export function applyDiscount(total: number): number {",
  "-  // Applies a ten percent discount.",
  "+  // Applies a ten percent discount to the subtotal.",
  "   const discounted = total * 0.9;",
  "   if (discounted < 0) {",
  "",
].join("\n");

interface Recorded {
  method: string;
  path: string;
  url: string;
  search: string;
  accept: string;
  body: unknown;
  headers: Record<string, string>;
}interface RestComment {
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
  compareStatus: string;
  compareDiff: string;
  compareStatusFailure: number;
  threads: unknown[];
  comments: RestComment[];
  reviewContent: string;
  reviewStatus: number;
  reviewHangs: boolean;
  modelStatus: number;
  modelMessage: string;
  modelInvalidJson: boolean;
  /** Main model calls that return an empty `length` stop before the normal one. */
  modelEmptyLengths: number;
  /** Answers a main model call from its user message; undefined falls through. */
  modelReply?: (user: string) => Response | undefined;
  recheckContent: string;
  recheckStatus: number;
  /** A re-check reply whose 200 content is not JSON (three failed attempts). */
  recheckInvalidJson: boolean;
  /** Re-check calls that return an empty `length` stop before the normal one. */
  recheckEmptyLengths: number;
  /** First comment ids whose reply POST answers 500. */
  replyFailures: number[];
  startCheckHangs: boolean;
  startCheckStatus: number;
  finishCheckStatuses: number[];
  /** The next N check-run PATCH calls never answer (a timeout). */
  finishCheckHangs: number;
  /** A status for every PATCH to one check-run id. */
  finishCheckStatusById: Record<number, number>;
  /** App id in the startCheck response; null leaves `app` out. */
  startCheckApp: number | null;
  checkRuns: Array<{
    id: number;
    name: string;
    external_id: string | null;
    status?: string;
    conclusion?: string;
    app?: { id: number };
  }>;
  /** Runs returned for a check-run lookup on a commit other than the head. */
  beforeCheckRuns: Array<{
    id: number;
    name: string;
    external_id: string | null;
    status?: string;
    conclusion?: string;
    app?: { id: number };
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
    compareStatus: "ahead",
    compareDiff: "",
    compareStatusFailure: 200,
    threads: [],
    comments: [],
    reviewContent: JSON.stringify({ findings: [FINDING] }),
    reviewStatus: 200,
    reviewHangs: false,
    modelStatus: 200,
    modelMessage: "model failed",
    modelInvalidJson: false,
    modelEmptyLengths: 0,
    recheckContent: JSON.stringify({ results: [] }),
    recheckStatus: 200,
    recheckInvalidJson: false,
    recheckEmptyLengths: 0,
    replyFailures: [],
    startCheckHangs: false,
    startCheckStatus: 200,
    finishCheckStatuses: [],
    finishCheckHangs: 0,
    finishCheckStatusById: {},
    startCheckApp: APP_ID,
    checkRuns: [],
    beforeCheckRuns: [],
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
        if (world.recheckInvalidJson) {
          return completion("this is not json");
        }
        if (world.recheckEmptyLengths > 0) {
          world.recheckEmptyLengths -= 1;
          return json({
            id: "gen-test",
            model: "deepseek/test",
            choices: [
              {
                index: 0,
                finish_reason: "length",
                native_finish_reason: "length",
                message: {
                  role: "assistant",
                  content: "",
                  reasoning: "hidden re-check reasoning",
                },
              },
            ],
            usage: {
              prompt_tokens: 900,
              completion_tokens: 16_000,
              completion_tokens_details: { reasoning_tokens: 15_000 },
            },
          });
        }
        if (world.recheckStatus !== 200) {
          return json({ error: { message: "recheck upstream failed" } }, world.recheckStatus);
        }
        return completion(world.recheckContent);
      }
      const custom = world.modelReply?.(String(messages[1]?.content ?? ""));
      if (custom !== undefined) {
        return custom;
      }
      if (world.modelStatus !== 200) {
        return json({ error: { message: world.modelMessage } }, world.modelStatus);
      }
      if (world.modelEmptyLengths > 0) {
        world.modelEmptyLengths -= 1;
        return json({
          id: "gen-test",
          model: "deepseek/test",
          choices: [
            {
              index: 0,
              finish_reason: "length",
              native_finish_reason: "length",
              message: {
                role: "assistant",
                content: "",
                reasoning: "hidden reasoning text",
              },
            },
          ],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 8_000,
            completion_tokens_details: { reasoning_tokens: 7_000 },
          },
        });
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

    if (
      call.method === "GET" &&
      /^\/repos\/o\/r\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(call.path)
    ) {
      if (call.accept === "application/vnd.github.diff") {
        return text(world.compareDiff);
      }
      if (world.compareStatusFailure !== 200) {
        return json({ message: "compare failed" }, world.compareStatusFailure);
      }
      return json({ status: world.compareStatus });
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
      return json(
        world.startCheckApp === null
          ? { id: 77 }
          : { id: 77, app: { id: world.startCheckApp } },
        201,
      );
    }

    if (call.method === "PATCH" && call.path.startsWith("/repos/o/r/check-runs/")) {
      if (world.finishCheckHangs > 0) {
        world.finishCheckHangs -= 1;
        return new Promise<Response>(() => {});
      }
      const id = Number.parseInt(call.path.slice("/repos/o/r/check-runs/".length), 10);
      const status =
        world.finishCheckStatusById[id] ?? world.finishCheckStatuses.shift() ?? 200;
      return status === 200
        ? json({})
        : json({ message: "finish failed" }, status);
    }

    if (
      call.method === "GET" &&
      /^\/repos\/o\/r\/commits\/[0-9a-f]{40}\/check-runs$/.test(call.path)
    ) {
      const sha = call.path.split("/")[5];
      return json({
        check_runs:
          sha === world.headSha ? world.checkRuns : world.beforeCheckRuns,
      });
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
      const id = Number(
        /\/comments\/([0-9]+)\/replies$/.exec(call.path)?.[1] ?? 0,
      );
      if (world.replyFailures.includes(id)) {
        return json({ message: "reply rejected" }, 500);
      }
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
      throw new Error("unexpected GraphQL document");
    }

    throw new Error(`unexpected request ${call.method} ${call.path}`);
  };

  return { fetchFn, calls };
}

function envWith(values: Record<string, string>): (name: string) => string {
  return (name) => values[name] ?? "";
}

const eventDirs: string[] = [];

afterEach(() => {
  for (const dir of eventDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a throwaway GitHub event payload and returns its path. */
function eventPath(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "bugbot-event-"));
  eventDirs.push(dir);
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return path;
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

function mutationCalls(calls: readonly Recorded[]): Recorded[] {
  return callsWhere(
    calls,
    (call) =>
      call.path === "/graphql" &&
      /\bmutation\b/.test(
        String((call.body as { query?: string }).query ?? ""),
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
    expect(summary).toContain("- Posted this pass: 1");
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

  it("passes BUGBOT_MAX_OUTPUT_TOKENS to the model request", async () => {
    const world = makeWorld();
    const { calls } = await runReview(world, {
      BUGBOT_MAX_OUTPUT_TOKENS: "1234",
    });

    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(1);
    expect((requests[0]!.body as { max_tokens: number }).max_tokens).toBe(1_234);
    // DeepSeek is effort-only, so effort high is sent explicitly.
    expect(
      (requests[0]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ effort: "high" });
  });

  it("passes BUGBOT_REASONING_EFFORT to the model request (fix5b)", async () => {
    const world = makeWorld();
    const { calls } = await runReview(world, {
      BUGBOT_REASONING_EFFORT: "low",
    });

    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(1);
    expect(
      (requests[0]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ effort: "low" });
  });

  it("turns reasoning off on the one length retry (fix5b)", async () => {
    const world = makeWorld({ modelEmptyLengths: 1 });
    const { calls } = await runReview(world);

    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(2);
    expect(
      (requests[0]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ effort: "high" });
    expect((requests[0]!.body as { max_tokens: number }).max_tokens).toBe(
      64_000,
    );
    expect(
      (requests[1]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ effort: "none" });
    expect((requests[1]!.body as { max_tokens: number }).max_tokens).toBe(
      64_000,
    );
  });

  it("passes BUGBOT_REASONING_MAX_TOKENS to an allow-listed model", async () => {
    const world = makeWorld();
    const { calls } = await runReview(world, {
      BUGBOT_MODEL: "anthropic/claude-sonnet-4",
      BUGBOT_REASONING_MAX_TOKENS: "3000",
    });

    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(1);
    expect(
      (requests[0]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ max_tokens: 3_000 });
  });

  it("keeps a successful call's usage when the reply fails to parse (F23-RV1-B1)", async () => {
    const world = makeWorld({ reviewContent: JSON.stringify({ nope: 1 }) });
    const { result, logs } = await runReview(world);

    expect(result.exitCode).toBe(0);
    expect(result.conclusion).toBe("neutral");
    expect(result.error).toContain(
      'model response must be {"findings":[...]} or a JSON array',
    );
    expect(logs.some((line) => line.includes("Tokens: 0 in / 0 out"))).toBe(
      false,
    );
    expect(summaryBody(world)).toContain("- Tokens: 123 in / 45 out");
  });
});

describe("BUGBOT_MAX_OUTPUT_TOKENS validation (F23-RV1-N4, fix5b)", () => {
  const invalid = [
    "abc",
    "0",
    "-5",
    "8000.5",
    "999",
    "128001",
    "99999999999999999999",
    "8e3",
  ];

  for (const value of invalid) {
    it(`rejects ${JSON.stringify(value)} before any request`, async () => {
      const world = makeWorld();
      const { result, calls, logs } = await runReview(world, {
        BUGBOT_MAX_OUTPUT_TOKENS: value,
      });

      expect(result).toMatchObject({ exitCode: 0, conclusion: "none" });
      expect(result.error).toContain(
        "BUGBOT_MAX_OUTPUT_TOKENS must be a whole number from 1000 to 128000",
      );
      // No GitHub request and no model call: the pass fails before both.
      expect(calls).toHaveLength(0);
      expect(
        logs.some((line) =>
          line.includes("BUGBOT_MAX_OUTPUT_TOKENS must be a whole number"),
        ),
      ).toBe(true);
    });
  }

  for (const value of ["1000", "64000", "128000"]) {
    it(`accepts the boundary value ${value}`, async () => {
      const world = makeWorld();
      const { calls } = await runReview(world, {
        BUGBOT_MAX_OUTPUT_TOKENS: value,
      });

      const requests = mainModelCalls(calls);
      expect(requests).toHaveLength(1);
      expect((requests[0]!.body as { max_tokens: number }).max_tokens).toBe(
        Number(value),
      );
    });
  }
});

describe("BUGBOT_REASONING_MAX_TOKENS validation (fix5, fix5b)", () => {
  const invalid = [
    "abc",
    "0",
    "1023",
    "64001",
    "8000.5",
    "64000",
  ];

  for (const value of invalid) {
    it(`rejects ${JSON.stringify(value)} before any request`, async () => {
      const world = makeWorld();
      const { result, calls, logs } = await runReview(world, {
        BUGBOT_REASONING_MAX_TOKENS: value,
      });

      expect(result).toMatchObject({ exitCode: 0, conclusion: "none" });
      expect(result.error).toContain(
        value === "64000"
          ? "BUGBOT_REASONING_MAX_TOKENS must be strictly below the 64000-token output ceiling"
          : "BUGBOT_REASONING_MAX_TOKENS must be a whole number from 1024 to 64000",
      );
      // No GitHub request and no model call: the pass fails before both.
      expect(calls).toHaveLength(0);
      expect(
        logs.some((line) => line.includes("BUGBOT_REASONING_MAX_TOKENS")),
      ).toBe(true);
    });
  }

  for (const value of ["1024", "31999", "63999"]) {
    it(`accepts the boundary value ${value}`, async () => {
      const world = makeWorld();
      const { calls } = await runReview(world, {
        BUGBOT_MODEL: "qwen/qwen3-235b-a22b",
        BUGBOT_REASONING_MAX_TOKENS: value,
      });

      const requests = mainModelCalls(calls);
      expect(requests).toHaveLength(1);
      expect(
        (requests[0]!.body as { reasoning?: unknown }).reasoning,
      ).toEqual({ max_tokens: Number(value) });
    });
  }

  it("rejects a budget at or above a raised output ceiling", async () => {
    const world = makeWorld();
    const { result, calls } = await runReview(world, {
      BUGBOT_MAX_OUTPUT_TOKENS: "10000",
      BUGBOT_REASONING_MAX_TOKENS: "10000",
    });

    expect(result).toMatchObject({ exitCode: 0, conclusion: "none" });
    expect(result.error).toContain(
      "BUGBOT_REASONING_MAX_TOKENS must be strictly below the 10000-token output ceiling",
    );
    expect(calls).toHaveLength(0);
  });

  it("sends effort high when neither effort nor budget is configured (fix5b)", async () => {
    const world = makeWorld();
    const { calls } = await runReview(world, {
      BUGBOT_MODEL: "anthropic/claude-sonnet-4",
    });

    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(1);
    expect(
      (requests[0]!.body as { reasoning?: unknown }).reasoning,
    ).toEqual({ effort: "high" });
    expect((requests[0]!.body as { max_tokens: number }).max_tokens).toBe(
      64_000,
    );
  });
});

describe("BUGBOT_REASONING_EFFORT validation (fix5b)", () => {
  const invalid = ["auto", "HIGHEST", "0", "medium,high"];

  for (const value of invalid) {
    it(`rejects ${JSON.stringify(value)} before any request`, async () => {
      const world = makeWorld();
      const { result, calls, logs } = await runReview(world, {
        BUGBOT_REASONING_EFFORT: value,
      });

      expect(result).toMatchObject({ exitCode: 0, conclusion: "none" });
      expect(result.error).toContain(
        "BUGBOT_REASONING_EFFORT must be one of max, xhigh, high, medium, low, minimal, none",
      );
      expect(calls).toHaveLength(0);
      expect(
        logs.some((line) => line.includes("BUGBOT_REASONING_EFFORT")),
      ).toBe(true);
    });
  }

  for (const value of [
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "none",
  ]) {
    it(`accepts ${value}`, async () => {
      const world = makeWorld();
      const { calls } = await runReview(world, {
        BUGBOT_REASONING_EFFORT: value,
      });

      const requests = mainModelCalls(calls);
      expect(requests).toHaveLength(1);
      expect(
        (requests[0]!.body as { reasoning?: unknown }).reasoning,
      ).toEqual({ effort: value });
    });
  }
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
    expect(summary).toContain("- Posted this pass: 0");
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
    expect(summary).toContain("- Posted this pass: 0");
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
    expect(summaryBody(world)).toContain("- Posted this pass: 0");
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

describe("runPrReview step 8c dedupe and incremental scope", () => {
  const liveFinding = (overrides: Partial<typeof FINDING> = {}) => ({
    ...FINDING,
    file: "src/discount.ts",
    line: 7,
    reason: LIVE_FIRST_REASON,
    suggested_fix: "Round after applying tax.",
    ...overrides,
  });

  function liveWorld(overrides: Partial<World> = {}): World {
    return makeWorld({
      diff: LIVE_DIFF,
      files: { "src/discount.ts": LIVE_HEAD },
      baseFiles: { "src/discount.ts": LIVE_BASE },
      reviewContent: JSON.stringify({ findings: [liveFinding()] }),
      ...overrides,
    });
  }

  function compareCalls(calls: readonly Recorded[]): Recorded[] {
    return callsWhere(calls, (call) => call.path.includes("/compare/"));
  }

  function pFinding(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      file: "src/p.ts",
      line: 3,
      side: "RIGHT",
      severity: "high",
      category: "bug",
      confidence: 0.95,
      reason: "x",
      suggested_fix: "y",
      angle: "interrogate:correctness",
      symbol: "p",
      triage: "fix",
      ...overrides,
    };
  }

  function pWorld(findings: unknown[], overrides: Partial<World> = {}): World {
    return makeWorld({
      diff: P_HEAD_DIFF,
      files: { "src/p.ts": P_HEAD },
      baseFiles: { "src/p.ts": P_BASE },
      reviewContent: JSON.stringify({ findings }),
      ...overrides,
    });
  }

  function pThread(
    line: number | null,
    reason: string,
    hash = "d".repeat(40),
    id = "PRRT_P1",
  ): Record<string, unknown> {
    return threadNode(
      [
        botComment(
          7001,
          `${marker(hash, "100", OLD)}\n\n**High bug: ${reason}**\n\n${reason}`,
        ),
      ],
      { id, path: "src/p.ts", line, originalLine: 6 },
    );
  }

  function postedLines(calls: readonly Recorded[]): Array<{
    path: string;
    line: number;
    side?: string;
  }> {
    return reviewCalls(calls).flatMap(
      (call) =>
        (call.body as { comments: Array<{ path: string; line: number; side?: string }> })
          .comments,
    );
  }

  it("does not repost a reworded finding at the same F:7 on a second push (live case)", async () => {
    const world = liveWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;

    world.threads = [
      threadNode([botComment(2001, firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`))], {
        path: "src/discount.ts",
        line: 7,
        originalLine: 7,
      }),
    ];
    world.reviewContent = JSON.stringify({
      findings: [liveFinding({ reason: LIVE_REWORDED_REASON })],
    });

    const second = await runReview(world, {}, {}, "222");

    expect(second.result.conclusion).toBe("success");
    expect(reviewCalls(second.calls)).toHaveLength(0);
    expect(recheckModelCalls(second.calls)).toHaveLength(0);
    expect(mutationCalls(second.calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 0");
    expect(summary).toContain("- Open Bugbot comments: 1");
    expect(summary).toContain("- Skipped: 1 duplicate");

    // With the incremental scope active, the same repeat is still counted as a
    // duplicate: cross-pass dedupe runs before the scope test (S8D-R1-N1).
    const path = eventPath({ action: "synchronize", before: OLD, after: HEAD });
    world.compareStatus = "ahead";
    world.compareDiff = SYNC_DIFF;
    world.beforeCheckRuns = [BEFORE_SUCCESS];
    const third = await runReview(world, { GITHUB_EVENT_PATH: path }, {}, "333");
    expect(reviewCalls(third.calls)).toHaveLength(0);
    expect(recheckModelCalls(third.calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Skipped: 1 duplicate");
    expect(summaryBody(world)).not.toContain("out of scope");
  });

  it("posts the sibling template bug and replies to its fixed neighbour (S8D-R1-N1)", async () => {
    const fixedReason =
      "`user.profile` can be undefined here, so reading `user.profile.name` throws a TypeError.";
    const newReason =
      "`order.customer` can be undefined here, so reading `order.customer.email` throws a TypeError.";
    const threadBody = `**High bug: ${fixedReason}**\n\n${fixedReason}\n\n**Suggested fix:**\nGuard the read.\n\n${marker("d".repeat(40), "100", OLD)}`;
    const world = pWorld([pFinding({ line: 4, reason: newReason })], {
      threads: [
        threadNode([botComment(7001, threadBody)], {
          id: "PRRT_P1",
          path: "src/p.ts",
          line: 3,
          originalLine: 3,
          diffSide: "RIGHT",
        }),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_P1", fixed: true, confidence: 0.95 }],
      }),
    });

    const { calls } = await runReview(world, {}, {}, "222");

    expect(postedLines(calls).map((comment) => comment.line)).toEqual([4]);
    expect(recheckModelCalls(calls)).toHaveLength(1);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Posted this pass: 1");
    expect(summaryBody(world)).not.toContain("duplicate");
  });

  it("pins the bare-word diff text wiring in the main and re-check passes (S8D-R2-N5)", async () => {
    const diff = [
      "diff --git a/src/p.ts b/src/p.ts",
      "--- a/src/p.ts",
      "+++ b/src/p.ts",
      "@@ -1,2 +1,4 @@",
      " export function p() {",
      '+  db.query("SELECT * FROM t WHERE id = " + id);',
      '+  res.send("<p>" + name + "</p>");',
      " }",
      "",
    ].join("\n");
    const head = [
      "export function p() {",
      '  db.query("SELECT * FROM t WHERE id = " + id);',
      '  res.send("<p>" + name + "</p>");',
      "}",
      "",
    ].join("\n");
    const sqlReason =
      "The id parameter is concatenated into the SQL query string, so a crafted value can run arbitrary SQL.";
    const xssReason =
      "The name parameter is concatenated into the HTML response without escaping, so a crafted value can run arbitrary script.";
    const world = makeWorld({
      diff,
      files: { "src/p.ts": head },
      baseFiles: { "src/p.ts": "export function p() {\n}\n" },
      reviewContent: JSON.stringify({
        findings: [pFinding({ line: 3, reason: xssReason })],
      }),
      threads: [
        threadNode(
          [
            botComment(
              7001,
              `**High bug: ${sqlReason}**\n\n${sqlReason}\n\n${marker("d".repeat(40), "100", OLD)}`,
            ),
          ],
          {
            id: "PRRT_P1",
            path: "src/p.ts",
            line: 2,
            originalLine: 2,
            diffSide: "RIGHT",
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_P1", fixed: true, confidence: 0.95 }],
      }),
    });

    const { calls } = await runReview(world, {}, {}, "222");

    // Without the main wiring the real sibling bug (xss next to the fixed
    // sqli thread) is dropped; without the re-check wiring the fixed thread
    // is treated as re-reported and never marked fixed.
    expect(postedLines(calls).map((comment) => comment.line)).toEqual([3]);
    expect(recheckModelCalls(calls)).toHaveLength(1);
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("posts only in-hunk findings on synchronize when before is an ancestor", async () => {
    const path = eventPath({
      action: "synchronize",
      before: OLD,
      after: HEAD,
    });
    const world = liveWorld({
      compareStatus: "ahead",
      compareDiff: SYNC_DIFF,
      beforeCheckRuns: [BEFORE_SUCCESS],
    });

    const { result, calls, logs } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(0);
    expect(compareCalls(calls)).toHaveLength(2);
    expect(logs).toContainEqual(
      expect.stringContaining("incremental review"),
    );
    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 0");
    expect(summary).toContain("- Skipped: 1 out of scope");
  });

  it("keeps the full PR diff when a force-push is not an ancestor", async () => {
    const path = eventPath({
      action: "synchronize",
      before: OLD,
      after: HEAD,
    });
    const world = liveWorld({ compareStatus: "diverged", compareDiff: "" });

    const { result, calls } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(1);
    expect(compareCalls(calls)).toHaveLength(1);
    expect(compareCalls(calls)[0]!.accept).toBe("application/vnd.github+json");
    expect(summaryBody(world)).toContain("- Posted this pass: 1");
  });

  it("keeps the full PR diff on reopened", async () => {
    const path = eventPath({
      action: "reopened",
      before: OLD,
      after: HEAD,
    });
    const world = liveWorld();

    const { result, calls } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(1);
    expect(compareCalls(calls)).toHaveLength(0);
  });

  it("reports posted this pass, open comments and each skipped bucket", async () => {
    const world = makeWorld({
      reviewContent: JSON.stringify({
        findings: [
          FINDING,
          { ...FINDING, line: 2, confidence: 0.5, reason: "Too unsure to post." },
          { ...FINDING, line: 99, reason: "Outside the diff." },
        ],
      }),
      threads: [
        threadNode(
          [
            botComment(
              3001,
              `${marker("e".repeat(40), "100", OLD)}\n\n**High bug: An older unrelated issue.**\n\nThis is unrelated.`,
            ),
          ],
          { id: "PRRT_OLD", line: 999, originalLine: 999 },
        ),
      ],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(1);
    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 1");
    expect(summary).toContain("- Open Bugbot comments: 2");
    expect(summary).toContain("- Skipped: 1 below confidence, 1 not in diff");
  });

  it("posts a distinct bug near an open comment (S8D-B1 probe P2b)", async () => {
    const world = pWorld(
      [
        pFinding({
          line: 5,
          reason:
            "Division by zero when the list is empty crashes the report builder.",
        }),
      ],
      {
        threads: [
          pThread(
            3,
            "Off by one in the loop bound skips the last element.",
          ),
        ],
      },
    );

    const { calls } = await runReview(world, {}, {}, "222");

    expect(postedLines(calls).map((comment) => comment.line)).toEqual([5]);
    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 1");
    expect(summary).not.toContain("duplicate");
  });

  it("applies the incremental scope before in-pass dedupe (S8D-B2 probe P2d)", async () => {
    const path = eventPath({ action: "synchronize", before: OLD, after: HEAD });
    const compareDiff = [
      "diff --git a/src/p.ts b/src/p.ts",
      "--- a/src/p.ts",
      "+++ b/src/p.ts",
      "@@ -6,1 +6,1 @@",
      "-  const e = 0;",
      "+  const e = 5;",
      "",
    ].join("\n");
    const world = pWorld(
      [
        pFinding({
          line: 3,
          severity: "high",
          reason: "Loop bound is wrong in the report builder.",
        }),
        pFinding({
          line: 6,
          severity: "medium",
          reason: "Division by zero crashes the report builder.",
        }),
      ],
      {
        compareStatus: "ahead",
        compareDiff,
        beforeCheckRuns: [BEFORE_SUCCESS],
      },
    );

    const { result, calls } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    expect(result.conclusion).toBe("success");
    expect(postedLines(calls).map((comment) => comment.line)).toEqual([6]);
    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 1");
    expect(summary).toContain("- Skipped: 1 out of scope");
    expect(summary).not.toContain("duplicate");
  });

  it("only narrows when before's own bugbot check succeeded (S8D-B3 probe P3d)", async () => {
    const path = eventPath({ action: "synchronize", before: OLD, after: HEAD });
    const compareDiff = [
      "diff --git a/src/p.ts b/src/p.ts",
      "--- a/src/p.ts",
      "+++ b/src/p.ts",
      "@@ -8,1 +8,1 @@",
      "-  const h = 0;",
      "+  const h = 8;",
      "",
    ].join("\n");
    const findingFromPush2 = pFinding({
      line: 3,
      reason: "Real bug from push 2: loop bound is wrong.",
    });

    // The intermediate push was never reviewed (no check run on `before`).
    const unreviewed = pWorld([findingFromPush2], {
      compareStatus: "ahead",
      compareDiff,
      beforeCheckRuns: [],
    });
    const first = await runReview(
      unreviewed,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );
    expect(postedLines(first.calls).map((comment) => comment.line)).toEqual([3]);
    expect(
      first.calls.filter(
        (call) => call.path === `/repos/o/r/commits/${OLD}/check-runs`,
      ),
    ).toHaveLength(1);
    expect(first.logs).toContainEqual(
      expect.stringContaining(`full review; ${OLD.slice(0, 7)} was not reviewed`),
    );

    // A successful check from this app is the only thing that narrows.
    const reviewed = pWorld([findingFromPush2], {
      compareStatus: "ahead",
      compareDiff,
      beforeCheckRuns: [BEFORE_SUCCESS],
    });
    const second = await runReview(
      reviewed,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );
    expect(reviewCalls(second.calls)).toHaveLength(0);
    expect(second.logs).toContainEqual(
      expect.stringContaining("incremental review"),
    );
    expect(summaryBody(reviewed)).toContain("- Skipped: 1 out of scope");

    // Another app's success, or a cancelled/neutral result, is not enough.
    for (const runs of [
      [{ ...BEFORE_SUCCESS, app: { id: OTHER_APP_ID } }],
      [{ ...BEFORE_SUCCESS, conclusion: "cancelled" }],
      [{ ...BEFORE_SUCCESS, conclusion: "neutral" }],
      [{ ...BEFORE_SUCCESS, status: "in_progress", conclusion: undefined }],
    ]) {
      const world = pWorld([findingFromPush2], {
        compareStatus: "ahead",
        compareDiff,
        beforeCheckRuns: runs,
      });
      const { calls } = await runReview(
        world,
        { GITHUB_EVENT_PATH: path },
        {},
        "333",
      );
      expect(postedLines(calls).map((comment) => comment.line)).toEqual([3]);
    }

    // A hostile conclusion is escaped in the log, never printed raw (N2 shape).
    const hostile = pWorld([findingFromPush2], {
      compareStatus: "ahead",
      compareDiff,
      beforeCheckRuns: [
        { ...BEFORE_SUCCESS, conclusion: "neutral\n::error::pwned" },
      ],
    });
    const hostileRun = await runReview(
      hostile,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );
    expect(postedLines(hostileRun.calls).map((comment) => comment.line)).toEqual([
      3,
    ]);
    expect(
      hostileRun.logs.some((line) => line.includes("(neutral?::error::pwned)")),
    ).toBe(true);
    expect(hostileRun.logs.filter((line) => line.startsWith("::"))).toHaveLength(
      0,
    );

    // A stale synchronize event (after is not the API head) keeps the full
    // diff, so the compare and the before lookup are never called.
    const stalePath = eventPath({
      action: "synchronize",
      before: OLD,
      after: "9".repeat(40),
    });
    const stale = pWorld([findingFromPush2], {
      compareStatus: "ahead",
      compareDiff,
      beforeCheckRuns: [BEFORE_SUCCESS],
    });
    const staleRun = await runReview(
      stale,
      { GITHUB_EVENT_PATH: stalePath },
      {},
      "333",
    );
    expect(postedLines(staleRun.calls).map((comment) => comment.line)).toEqual([
      3,
    ]);
    expect(compareCalls(staleRun.calls)).toHaveLength(0);
  });

  it("keeps the last known open count when the pass fails before the threads (S8D-B4 probe P5b)", async () => {
    const previousBody = [
      "<!-- bugbot:summary -->",
      "<!-- bugbot:runs 111 -->",
      "## Bugbot review",
      "",
      "- Passes: 1",
      "- Open Bugbot comments: 2",
      "",
    ].join("\n");
    const world = pWorld([], {
      modelStatus: 500,
      threads: [pThread(3, "Still open.")],
      comments: [
        {
          id: 5001,
          user: { login: "andura-bugbot", type: "Bot" as const },
          body: previousBody,
        },
      ],
    });

    const { result } = await runReview(world, {}, {}, "222");

    expect(result.conclusion).toBe("neutral");
    const summary = summaryBody(world);
    expect(summary).toContain("- Open Bugbot comments: 2");
    expect(summary).not.toContain("- Open Bugbot comments: 0");

    const noHistory = pWorld([], { modelStatus: 500 });
    await runReview(noHistory, {}, {}, "222");
    expect(summaryBody(noHistory)).toContain("- Open Bugbot comments: unknown");
  });

  it("checks a LEFT finding against the base-side line numbers of the hunks (N3)", async () => {
    const path = eventPath({ action: "synchronize", before: OLD, after: HEAD });
    const world = makeWorld({
      diff: N3_PR_DIFF,
      files: { "src/p.ts": N3_HEAD },
      baseFiles: { "src/p.ts": N3_BASE },
      compareStatus: "ahead",
      compareDiff: N3_COMPARE_DIFF,
      beforeCheckRuns: [BEFORE_SUCCESS],
      reviewContent: JSON.stringify({
        findings: [
          pFinding({
            line: 10,
            side: "LEFT",
            reason: "Removed guard on the tail element.",
          }),
        ],
      }),
    });

    const { calls } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    expect(reviewCalls(calls)).toHaveLength(1);
    expect(postedLines(calls)).toMatchObject([{ line: 10, side: "LEFT" }]);
    expect(summaryBody(world)).toContain("- Posted this pass: 1");
  });

  it("escapes the compare status so it cannot start a workflow command (N2)", async () => {
    const path = eventPath({ action: "synchronize", before: OLD, after: HEAD });
    const world = pWorld([pFinding({ line: 3 })], {
      compareStatus: "ahead\n::error::injected",
    });

    const { logs } = await runReview(
      world,
      { GITHUB_EVENT_PATH: path },
      {},
      "333",
    );

    const lines = logs.join("\n").split("\n");
    expect(lines.some((line) => line.startsWith("::error::injected"))).toBe(
      false,
    );
    expect(lines).toContainEqual(
      expect.stringContaining("ahead?::error::injected"),
    );
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

describe("runPrReview re-check and replies", () => {
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

  it("replies Looks fixed as of <sha7> and leaves a fixed thread open at 0.9", async () => {
    const world = await fixedWorld(0.9);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    const replies = replyCalls(calls);
    expect(replies).toHaveLength(1);
    expect((replies[0]!.body as { body: string }).body).toBe(
      `Looks fixed as of ${HEAD.slice(0, 7)}.`,
    );
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Passes: 3");
    expect(summaryBody(world)).toContain("- Marked fixed this pass: 1");
    // The thread is still unresolved, but it has a fixed reply: it is marked
    // fixed, so it must not count as open.
    expect(summaryBody(world)).toContain("- Open Bugbot comments: 0");

    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });

  it("counts usage from a failed re-check call (F23-RV1-N6)", async () => {
    const world = await fixedWorld(0.9);
    world.recheckInvalidJson = true;
    const { result, calls, logs } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(3);
    expect(
      logs.some((line) =>
        line.includes("re-check failed, leaving threads open"),
      ),
    ).toBe(true);
    expect(replyCalls(calls)).toHaveLength(0);
    // Main 123/45 plus three failed re-check replies at 123/45 each.
    expect(summaryBody(world)).toContain("- Tokens: 492 in / 180 out");
  });

  it("sends the re-check at its own 16000 cap with the configured effort (F5-RV1-N3)", async () => {
    const world = await fixedWorld(0.9);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    const rechecks = recheckModelCalls(calls);
    expect(rechecks).toHaveLength(1);
    const body = rechecks[0]!.body as {
      max_tokens: number;
      reasoning?: unknown;
    };
    expect(body.max_tokens).toBe(16_000);
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("keeps the reasoning-off fallback on the re-check (F5-RV1-N3)", async () => {
    const world = await fixedWorld(0.9);
    world.recheckEmptyLengths = 1;
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    const rechecks = recheckModelCalls(calls);
    expect(rechecks).toHaveLength(2);
    expect(
      rechecks.map((call) => {
        const body = call.body as {
          max_tokens: number;
          reasoning?: unknown;
        };
        return [body.max_tokens, body.reasoning];
      }),
    ).toEqual([
      [16_000, { effort: "high" }],
      [16_000, { effort: "none" }],
    ]);
    expect(replyCalls(calls)).toHaveLength(1);
  });

  it("clamps the re-check reasoning budget to 1024 (F5-RV1-N4)", async () => {
    const world = await fixedWorld(0.9);
    const { result, calls } = await runReview(
      world,
      {
        BUGBOT_MODEL: "anthropic/claude-sonnet-4",
        BUGBOT_REASONING_MAX_TOKENS: "8000",
      },
      {},
      "333",
    );

    expect(result.conclusion).toBe("success");
    const rechecks = recheckModelCalls(calls);
    expect(rechecks).toHaveLength(1);
    const body = rechecks[0]!.body as {
      max_tokens: number;
      reasoning?: unknown;
    };
    expect(body.max_tokens).toBe(16_000);
    expect(body.reasoning).toEqual({ max_tokens: 1_024 });
  });

  it("does not reply at 0.7 confidence", async () => {
    const world = await fixedWorld(0.7);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Marked fixed this pass: 0");
  });

  it("does not reply at 0.79 confidence (M24 boundary)", async () => {
    const world = await fixedWorld(0.79);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Marked fixed this pass: 0");
  });

  it("replies at exactly 0.8 confidence (M24 boundary)", async () => {
    const world = await fixedWorld(0.8);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(1);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Marked fixed this pass: 1");
  });

  it("does not reply when the model says fixed:false at 0.9 (M23)", async () => {
    const world = await fixedWorld(0.9, false);
    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Marked fixed this pass: 0");
  });

  it("does not treat a human fixed reply as the bot's own (M28)", async () => {
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
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("re-checks an outdated thread at originalLine and replies (S8D-B1)", async () => {
    const world = makeWorld({
      diff: PAGINATION_DIFF,
      files: { "src/pagination.ts": PAGINATION_HEAD },
      baseFiles: { "src/pagination.ts": PAGINATION_OLD },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: page end**\n\n\`slice\` receives \`start\` and \`pageSize\`; the \`end\` bound is missing.\n\n${marker("d".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_OUTDATED",
            path: "src/pagination.ts",
            line: null,
            originalLine: 7,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_OUTDATED", fixed: true, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked).toContain('id="PRRT_OUTDATED"');
    expect(asked).toContain("const end = start + pageSize;");
    expect(asked).toContain("outdated");
    expect(asked).toContain("commit it was posted on");
    expect(replyCalls(calls)).toHaveLength(1);
    expect((replyCalls(calls)[0]!.body as { body: string }).body).toBe(
      `Looks fixed as of ${HEAD.slice(0, 7)}.`,
    );
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("keeps an outdated thread open when the re-check says not fixed", async () => {
    const world = makeWorld({
      diff: PAGINATION_DIFF,
      files: { "src/pagination.ts": PAGINATION_HEAD },
      baseFiles: { "src/pagination.ts": PAGINATION_OLD },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: page end**\n\n\`slice\` receives \`start\` and \`pageSize\`; the \`end\` bound is missing.\n\n${marker("d".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_OUTDATED",
            path: "src/pagination.ts",
            line: null,
            originalLine: 7,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_OUTDATED", fixed: false, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("never re-checks an outdated thread the main call re-reported", async () => {
    const world = makeWorld({
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: cart total**\n\nfindCustomer returns undefined and reading customer.name throws.\n\n${marker("e".repeat(40), "7", OLD)}`,
            ),
          ],
          { line: null, originalLine: 3 },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(0);
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(summaryBody(world)).toContain("- Skipped: 1 duplicate");
  });

  it("re-checks a deleted file's outdated thread with status deleted", async () => {
    const world = makeWorld({
      diff: DELETED_DIFF,
      files: {},
      baseFiles: {
        "src/legacy.ts": "export const legacy = 1;\nexport const old = 2;\n",
      },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: legacy export**\n\nThe export is read after the module is gone.\n\n${marker("f".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_DELETED",
            path: "src/legacy.ts",
            line: null,
            originalLine: 2,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_DELETED", fixed: false, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked).toContain('id="PRRT_DELETED"');
    expect(asked).toContain("file deleted at head");
    expect(asked).toContain("outdated");
  });

  it("skips a thread with neither line nor originalLine", async () => {
    const world = makeWorld({
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: nowhere**\n\nNo line at all.\n\n${marker("1".repeat(40), "7", OLD)}`,
            ),
          ],
          { line: null, originalLine: null },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("gives a long outdated file a window around originalLine, a short one the whole file", async () => {
    const longWorld = makeWorld({
      diff: LONG_DIFF,
      files: { "src/long.ts": LONG_HEAD },
      baseFiles: { "src/long.ts": "const line1 = 0;\n" },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: long file**\n\nSomething on line 210.\n\n${marker("2".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_LONG",
            path: "src/long.ts",
            line: null,
            originalLine: 210,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_LONG", fixed: false, confidence: 0.9 }],
      }),
    });

    const long = await runReview(longWorld, {}, {}, "333");
    const askedLong = messageContent(recheckModelCalls(long.calls)[0]!, 1);
    expect(askedLong).toContain("lines 130-290 of 420:");
    expect(askedLong).not.toContain("lines 1-420 of 420:");

    const shortWorld = makeWorld({
      diff: LONG_DIFF,
      files: { "src/long.ts": SHORT_HEAD },
      baseFiles: { "src/long.ts": "const line1 = 0;\n" },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: short file**\n\nSomething on line 50.\n\n${marker("3".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_SHORT",
            path: "src/long.ts",
            line: null,
            originalLine: 50,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_SHORT", fixed: false, confidence: 0.9 }],
      }),
    });

    const short = await runReview(shortWorld, {}, {}, "333");
    const askedShort = messageContent(recheckModelCalls(short.calls)[0]!, 1);
    expect(askedShort).toContain("lines 1-100 of 100:");
    expect(askedShort).toContain("const line1 = 1;");
    expect(askedShort).toContain("const line100 = 100;");
  });

  it("anchors a current thread on line, not originalLine, with a 40-line window (M3, M12)", async () => {
    const world = makeWorld({
      diff: LONG_DIFF,
      files: { "src/long.ts": LONG_HEAD },
      baseFiles: { "src/long.ts": "const line1 = 0;\n" },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `**High bug: shifted line**\n\nSomething on the current line.\n\n${marker("4".repeat(40), "7", OLD)}`,
            ),
          ],
          {
            id: "PRRT_SHIFTED",
            path: "src/long.ts",
            line: 250,
            originalLine: 7,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_SHIFTED", fixed: false, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked).toContain("<line>250</line>");
    expect(asked).not.toContain("<outdated>");
    // A current thread keeps the 40-line window around its current line; it is
    // not anchored on the old originalLine and not shown the whole file.
    expect(asked).toContain("lines 210-290 of 420:");
    expect(asked).not.toContain("lines 1-420 of 420:");
  });

  it("forwards the first comment's diffHunk into the re-check prompt (M8)", async () => {
    const hunk = [
      "@@ -1,3 +1,4 @@",
      "   if (pageSize <= 0) return [];",
      "-  return items.slice(safeStart, pageSize);",
      "+  const end = start + pageSize;",
      "+  return items.slice(safeStart, end);",
      " // UNIQUE-HUNK-MARKER",
    ].join("\n");
    const world = makeWorld({
      diff: PAGINATION_DIFF,
      files: { "src/pagination.ts": PAGINATION_HEAD },
      baseFiles: { "src/pagination.ts": PAGINATION_OLD },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            {
              ...botComment(
                1001,
                `**High bug: page end**\n\nThe \`end\` bound is missing.\n\n${marker("5".repeat(40), "7", OLD)}`,
              ),
              diffHunk: hunk,
            },
          ],
          {
            id: "PRRT_HUNK",
            path: "src/pagination.ts",
            line: null,
            originalLine: 7,
          },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [{ thread: "PRRT_HUNK", fixed: false, confidence: 0.9 }],
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked).toContain("<diff_hunk>");
    expect(asked).toContain("UNIQUE-HUNK-MARKER");
  });

  it("bounds the re-check on 15 outdated threads on one large file (S8D-RV1-N2)", async () => {
    const content = `${Array.from(
      { length: 400 },
      (_, index) => `const line${index + 1} = "${"x".repeat(360)}";`,
    ).join("\n")}\n`;
    const world = makeWorld({
      diff: BIG_DIFF,
      files: { "src/big.ts": content },
      baseFiles: { "src/big.ts": "const line1 = 0;\n" },
      reviewContent: JSON.stringify({ findings: [] }),
      threads: Array.from({ length: 15 }, (_, index) =>
        threadNode(
          [
            botComment(
              1000 + index,
              `**High bug: old issue ${index}**\n\nold reason ${index} ${"r".repeat(4_000)}\n\n${marker(
                `${String(index).padStart(2, "0")}${"a".repeat(38)}`,
                "7",
                OLD,
              )}`,
            ),
          ],
          {
            id: `PRRT_${index}`,
            path: "src/big.ts",
            line: null,
            originalLine: 210,
          },
        ),
      ),
      recheckContent: JSON.stringify({
        results: Array.from({ length: 15 }, (_, index) => ({
          thread: `PRRT_${index}`,
          fixed: true,
          confidence: 0.9,
        })),
      }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked.length).toBeLessThanOrEqual(200_000);
    // One file block for the path, not one copy per thread.
    expect(asked.match(/const line1 = "/g) ?? []).toHaveLength(1);
    const ids = [...asked.matchAll(/<thread id="(PRRT_\d+)"/g)].map(
      (match) => match[1],
    );
    // Oldest first, and the threads that do not fit stay out of this pass.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(15);
    expect(ids).toEqual(
      Array.from({ length: ids.length }, (_, index) => `PRRT_${index}`),
    );
    expect(asked).not.toContain(`id="PRRT_${ids.length}"`);
    // Only the threads in the request get a reply; the rest stay open.
    expect(replyCalls(calls)).toHaveLength(ids.length);
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("asks about open threads only and ignores an unknown thread id (M07, M18)", async () => {
    const world = makeWorld({ reviewContent: JSON.stringify({ findings: [] }) });
    const body = (id: string, hashChar: string) =>
      `${marker(hashChar.repeat(40), "7", OLD)}\n\n**High bug: issue ${id}**\n\nreason ${id}`;
    world.threads = [
      threadNode([botComment(1001, body("open", "1"))], { id: "PRRT_OPEN" }),
      threadNode([botComment(1002, body("done", "2"))], {
        id: "PRRT_RESOLVED",
        isResolved: true,
      }),
      threadNode(
        [botComment(1003, body("skip", "3")), humanComment(1004, "won't fix")],
        { id: "PRRT_SKIPPED" },
      ),
    ];
    // The model claims every thread, plus one it was never asked about, is fixed.
    world.recheckContent = JSON.stringify({
      results: ["PRRT_OPEN", "PRRT_RESOLVED", "PRRT_SKIPPED", "PRRT_UNKNOWN"].map(
        (thread) => ({ thread, fixed: true, confidence: 0.95 }),
      ),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(1);
    const asked = messageContent(recheckModelCalls(calls)[0]!, 1);
    expect(asked.match(/<thread id="/g)).toHaveLength(1);
    expect(asked).toContain('id="PRRT_OPEN"');
    expect(asked).not.toContain("PRRT_RESOLVED");
    expect(asked).not.toContain("PRRT_SKIPPED");

    expect(replyCalls(calls)).toHaveLength(1);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)[0]!.path).toBe(
      "/repos/o/r/pulls/1/comments/1001/replies",
    );
  });

  it("never replies to a thread whose hash the main call re-reported (S6B-N5b)", async () => {
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
    // duplicate, and the thread must stay open rather than be marked fixed.
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(reviewCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Skipped: 1 duplicate");
    expect(summary).toContain("- Marked fixed this pass: 0");
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
    expect(mutationCalls(calls)).toHaveLength(0);
  });

  it("never replies to a human won't-fix thread and never re-posts its hash", async () => {
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
    expect(mutationCalls(second.calls)).toHaveLength(0);
    expect(threadCalls(second.calls)).toHaveLength(1);
  });

  it("treats an old Fixed in reply as marked fixed with no second reply or re-check", async () => {
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
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Marked fixed this pass: 0");
    expect(summary).toContain("- Open Bugbot comments: 0");
  });

  it("logs a failed re-check and still succeeds with nothing marked fixed", async () => {
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
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(logs.some((line) => line.includes("re-check failed"))).toBe(true);
    const finish = callsWhere(
      calls,
      (call) => call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    expect((finish[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });

  it("never sends a GraphQL mutation during a pass that replies", async () => {
    const world = await fixedWorld(0.9);
    const { calls, logs } = await runReview(world, {}, {}, "333");

    expect(replyCalls(calls)).toHaveLength(1);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(logs.some((line) => line.includes("could not reply"))).toBe(false);
  });

  it("skips a thread already marked fixed by the new wording", async () => {
    const world = makeWorld();
    const first = await runReview(world);
    const firstBody = (
      reviewCalls(first.calls)[0]!.body as { comments: Array<{ body: string }> }
    ).comments[0]!.body;
    const oldBody = firstBody.replace(`sha=${HEAD}`, `sha=${OLD}`);
    world.threads = [
      threadNode([
        botComment(1001, oldBody),
        botComment(1002, "Looks fixed as of abc1234."),
      ]),
    ];
    world.reviewContent = JSON.stringify({ findings: [] });
    world.recheckContent = JSON.stringify({
      results: [{ thread: "PRRT_1", fixed: true, confidence: 0.9 }],
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Marked fixed this pass: 0");
    expect(summary).toContain("- Open Bugbot comments: 0");
  });

  it("keeps dedupe against a marked-fixed thread but not count it open", async () => {
    const world = makeWorld({
      threads: [
        threadNode([
          botComment(
            1001,
            `**High bug: cart total**\n\nfindCustomer returns undefined for an unknown customerId and customer.name throws.\n\n${marker("e".repeat(40), "7", OLD)}`,
          ),
          botComment(1002, "Looks fixed as of abc1234."),
        ]),
      ],
      reviewContent: JSON.stringify({ findings: [FINDING] }),
    });

    const { result, calls } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    // Same path, category and line: the marked-fixed thread still swallows the
    // reworded finding, exactly like an open thread.
    expect(reviewCalls(calls)).toHaveLength(0);
    expect(recheckModelCalls(calls)).toHaveLength(0);
    expect(replyCalls(calls)).toHaveLength(0);
    expect(mutationCalls(calls)).toHaveLength(0);
    const summary = summaryBody(world);
    expect(summary).toContain("- Skipped: 1 duplicate");
    expect(summary).toContain("- Marked fixed this pass: 0");
    expect(summary).toContain("- Open Bugbot comments: 0");
  });

  it("keeps replying after one failed reply and counts only the posted ones", async () => {
    const world = makeWorld({
      reviewContent: JSON.stringify({ findings: [] }),
      threads: [
        threadNode(
          [
            botComment(
              1001,
              `${marker("1".repeat(40), "7", OLD)}\n\n**High bug: first**\n\nfirst reason`,
            ),
          ],
          { id: "PRRT_A", line: 2, originalLine: 2 },
        ),
        threadNode(
          [
            botComment(
              1002,
              `${marker("2".repeat(40), "7", OLD)}\n\n**High bug: second**\n\nsecond reason`,
            ),
          ],
          { id: "PRRT_B", line: 3, originalLine: 3 },
        ),
      ],
      recheckContent: JSON.stringify({
        results: [
          { thread: "PRRT_A", fixed: true, confidence: 0.9 },
          { thread: "PRRT_B", fixed: true, confidence: 0.9 },
        ],
      }),
      replyFailures: [1001],
    });

    const { result, calls, logs } = await runReview(world, {}, {}, "333");

    expect(result.conclusion).toBe("success");
    expect(replyCalls(calls)).toHaveLength(2);
    expect(mutationCalls(calls)).toHaveLength(0);
    expect(logs.some((line) => line.includes("Bugbot could not reply on PRRT_A:"))).toBe(
      true,
    );
    const summary = summaryBody(world);
    expect(summary).toContain("- Marked fixed this pass: 1");
    // PRRT_A is still open and unmarked; PRRT_B is marked fixed.
    expect(summary).toContain("- Open Bugbot comments: 1");
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

  it("counts usage from empty length replies and names the cause", async () => {
    const world = makeWorld({ modelEmptyLengths: 3 });
    const { result, calls, logs } = await runReview(world);

    expect(result.exitCode).toBe(0);
    expect(result.conclusion).toBe("neutral");
    expect(result.error).toContain(
      "whole 64000-token output budget on reasoning",
    );

    const summary = summaryBody(world);
    expect(summary).toContain("- Tokens: 1800 in / 16000 out");
    expect(summary).toContain("Bugbot couldn't review:");
    expect(summary).toContain("whole 64000-token output budget on reasoning");
    expect(summary).toContain("- Reasoning: #1 effort=high cap 64000");
    expect(summary).toContain("#2 effort=none cap 64000");

    const finish = callsWhere(
      calls,
      (call) =>
        call.method === "PATCH" && call.path === "/repos/o/r/check-runs/77",
    );
    const output = (finish[0]!.body as { output: { summary: string } }).output
      .summary;
    expect(output).toContain("Reasoning: #1 effort=high cap 64000");
    expect(output).toContain("#2 effort=none cap 64000");
    expect(logs.some((line) => line.includes(" finish_reason=length"))).toBe(true);
    expect(logs.some((line) => line.includes("hidden reasoning text"))).toBe(
      false,
    );
  });
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
  it("retries a finish PATCH that timed out and completes the check (F4)", async () => {
    // Three hangs use up the request-level timeout retries, so only the
    // finishCheck-level retry can still complete the check.
    const world = makeWorld({ finishCheckHangs: 3 });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const finish = checkPatches(calls, 77);
    expect(finish).toHaveLength(4);
    expect((finish[3]!.body as { conclusion: string }).conclusion).toBe(
      "success",
    );
    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    expect(creates).toHaveLength(1);
    expect(logs.some((line) => line.includes("could not finish"))).toBe(false);
  });

  it("neither creates nor PATCHes when the lost handle's only match is completed (F17)", async () => {
    const world = makeWorld({
      startCheckHangs: true,
      checkRuns: [
        { id: 52, name: "bugbot", external_id: "111", status: "completed" },
      ],
    });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("neutral");
    const creates = callsWhere(
      calls,
      (call) => call.method === "POST" && call.path === "/repos/o/r/check-runs",
    );
    // Only the lost in_progress create; no completed neutral one.
    expect(creates).toHaveLength(1);
    expect((creates[0]!.body as { status?: string }).status).toBe(
      "in_progress",
    );
    expect(
      callsWhere(
        calls,
        (call) =>
          call.method === "PATCH" && call.path.startsWith("/repos/o/r/check-runs/"),
      ),
    ).toHaveLength(0);
    expect(logs.some((line) => line.includes("already completed"))).toBe(true);
  });

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

  const stale = (
    id: number,
    externalId: string | null,
    extra: { status?: string; app?: number } = {},
  ) => ({
    id,
    name: "bugbot",
    external_id: externalId,
    status: extra.status ?? "in_progress",
    app: { id: extra.app ?? APP_ID },
  });

  function checkLookups(calls: readonly Recorded[]): Recorded[] {
    return callsWhere(
      calls,
      (call) =>
        call.method === "GET" &&
        call.path === `/repos/o/r/commits/${HEAD}/check-runs`,
    );
  }

  it("completes a stale in_progress check from an earlier run at pass start", async () => {
    const world = makeWorld({ checkRuns: [stale(50, "99")] });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const lookups = checkLookups(calls);
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(lookups[0]!.search).toContain("filter=all");

    const patches = checkPatches(calls, 50);
    expect(patches).toHaveLength(1);
    expect((patches[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
  });

  it("skips this pass's own check by id, and completes a ghost of the same run id (R1-N1, S1a)", async () => {
    // 77 is the check this pass just created (same external_id as the ghost).
    const world = makeWorld({
      checkRuns: [stale(77, "111"), stale(62, "111")],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    const ghost = checkPatches(calls, 62);
    expect(ghost).toHaveLength(1);
    expect((ghost[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
    // The own check gets exactly one PATCH, the final success one.
    const own = checkPatches(calls, 77);
    expect(own).toHaveLength(1);
    expect((own[0]!.body as { conclusion: string }).conclusion).toBe("success");
  });

  it("leaves a newer run's in_progress check alone (R1-N2)", async () => {
    const world = makeWorld({
      checkRuns: [stale(61, "222"), stale(63, "50")],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 61)).toHaveLength(0);
    expect(checkPatches(calls, 63)).toHaveLength(1);
  });

  it("leaves a run with a missing or non-numeric external_id alone (R1-N2)", async () => {
    const world = makeWorld({
      checkRuns: [stale(64, null), stale(65, "not-a-number"), stale(66, "50")],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 64)).toHaveLength(0);
    expect(checkPatches(calls, 65)).toHaveLength(0);
    expect(checkPatches(calls, 66)).toHaveLength(1);
  });

  it("leaves another app's bugbot check alone (R1-N2)", async () => {
    const world = makeWorld({
      checkRuns: [stale(60, "50", { app: OTHER_APP_ID }), stale(63, "50")],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 60)).toHaveLength(0);
    expect(checkPatches(calls, 63)).toHaveLength(1);
  });

  it("leaves a run with no app alone (R1-N2)", async () => {
    const noApp = { id: 67, name: "bugbot", external_id: "50", status: "in_progress" };
    const world = makeWorld({ checkRuns: [noApp] });
    const { calls } = await runReview(world);

    expect(checkPatches(calls, 67)).toHaveLength(0);
  });

  it("still completes the next stale run when one PATCH is refused (R1-N2)", async () => {
    const world = makeWorld({
      checkRuns: [stale(60, "50"), stale(63, "50")],
      finishCheckStatusById: { 60: 403 },
    });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 60)).toHaveLength(1);
    const next = checkPatches(calls, 63);
    expect(next).toHaveLength(1);
    expect((next[0]!.body as { conclusion: string }).conclusion).toBe(
      "neutral",
    );
    expect(
      logs.some((line) => line.includes("could not complete stale check run 60")),
    ).toBe(true);
  });

  it("never PATCHes a completed run (F2)", async () => {
    const world = makeWorld({
      checkRuns: [
        stale(64, "50", { status: "completed" }),
        stale(65, "111", { status: "completed" }),
        stale(66, "50", { status: "queued" }),
      ],
    });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkPatches(calls, 64)).toHaveLength(0);
    expect(checkPatches(calls, 65)).toHaveLength(0);
    expect(checkPatches(calls, 66)).toHaveLength(0);
  });

  it("skips the cleanup with a log line when the check's app is unknown (R1-N2)", async () => {
    const world = makeWorld({
      startCheckApp: null,
      checkRuns: [stale(63, "50")],
    });
    const { result, calls, logs } = await runReview(world);

    expect(result.conclusion).toBe("success");
    expect(checkLookups(calls)).toHaveLength(0);
    expect(checkPatches(calls, 63)).toHaveLength(0);
    expect(logs.some((line) => line.includes("app is unknown"))).toBe(true);
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

  it("prints no line that starts with :: for a hostile file name (R1-N3, L1)", async () => {
    const world = makeWorld({
      diff: HOSTILE_DIFF,
      files: { "src/cart.ts": HEAD_CART },
    });
    const { result, logs } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    const skipping = logs.filter((line) => line.includes("skipping"));
    expect(skipping).toHaveLength(1);
    expect(skipping[0]).toContain("x?::warning::pwned\\y.ts");
    for (const line of logs) {
      for (const part of line.split(/\r\n|\r|\n/)) {
        expect(part.startsWith("::")).toBe(false);
      }
      expect(/[\u0000-\u0009\u000b-\u001f]/.test(line)).toBe(false);
      expect(line).not.toContain(HOSTILE_NAME);
    }
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

/** A PR of six files with 220 added lines each: 1320 changed lines. */
const PARTS_FILES = Array.from({ length: 6 }, (_value, index) => `src/part${index + 1}.ts`);
const PARTS_LINES = Array.from(
  { length: 220 },
  (_value, index) => `export const value${index + 1} = compute(${index + 1});`,
);
const PARTS_DIFF = PARTS_FILES.map((file) =>
  [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${PARTS_LINES.length} @@`,
    ...PARTS_LINES.map((line) => `+${line}`),
  ].join("\n"),
).join("\n") + "\n";
const PARTS_CONTENT = `${PARTS_LINES.join("\n")}\n`;

function partsWorld(overrides: Partial<World> = {}): World {
  return makeWorld({
    diff: PARTS_DIFF,
    files: Object.fromEntries(PARTS_FILES.map((file) => [file, PARTS_CONTENT])),
    baseFiles: {},
    ...overrides,
  });
}

function partsFinding(file: string): Record<string, unknown> {
  return {
    ...FINDING,
    file,
    line: 3,
    symbol: "",
    reason: `compute(3) in ${file} is called before compute is defined, so the module throws on import.`,
  };
}

/** The diff block of a model user message: which files a part holds. */
function diffBlock(user: string): string {
  return /<diff>([\s\S]*?)<\/diff>/.exec(user)?.[1] ?? "";
}

describe("runPrReview big pull requests in parts", () => {
  it("splits a 1320-line PR into parts and posts the merged findings", async () => {
    const world = partsWorld({
      modelReply: (user) => {
        const diff = diffBlock(user);
        const file = PARTS_FILES.find((candidate) => diff.includes(`+++ b/${candidate}`));
        return completion(JSON.stringify({ findings: file === undefined ? [] : [partsFinding(file)] }));
      },
    });
    const { result, calls, logs } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    const requests = mainModelCalls(calls);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(messageContent(request, 1)).toContain("<review_part>");
    }
    // Every file is in exactly one part.
    for (const file of PARTS_FILES) {
      expect(
        requests.filter((request) => diffBlock(messageContent(request, 1)).includes(`+++ b/${file}`)),
      ).toHaveLength(1);
    }

    const reviews = reviewCalls(calls);
    expect(reviews).toHaveLength(1);
    const comments = (reviews[0]!.body as { comments: Array<{ path: string }> }).comments;
    expect(comments.map((comment) => comment.path).sort()).toEqual(["src/part1.ts", "src/part5.ts"]);

    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 2");
    expect(summary).toContain("- Parts: 2 of 2 reviewed");
    expect(summary).toContain("- Tokens: 246 in / 90 out");
    expect(logs).toContain("Bugbot: reviewing 2 parts");
    expect(logs.some((line) => line.startsWith("Bugbot: tokens_in=246 tokens_out=90"))).toBe(true);
  });

  it("keeps the complete findings of a reply cut off mid-JSON, with no retry", async () => {
    const world = partsWorld({
      modelReply: (user) => {
        const diff = diffBlock(user);
        const file = PARTS_FILES.find((candidate) => diff.includes(`+++ b/${candidate}`)) ?? "";
        const whole = JSON.stringify(partsFinding(file));
        return json({
          id: "gen-test",
          model: "deepseek/test",
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: {
                role: "assistant",
                content: `{"findings":[${whole},{"file":"${file}","line":9,"reason":"cut of`,
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 64_000, cost: 0.05 },
        });
      },
    });
    const { result, calls } = await runReview(world);

    expect(result).toMatchObject({ exitCode: 0, conclusion: "success" });
    expect(mainModelCalls(calls)).toHaveLength(2);
    const reviews = reviewCalls(calls);
    expect((reviews[0]!.body as { comments: unknown[] }).comments).toHaveLength(2);

    const summary = summaryBody(world);
    expect(summary).toContain("part 1 reply was cut off; kept its 1 complete finding");
    expect(summary).toContain("- Cost: $0.1000");
  });

  it("posts the reviewed parts and flags the failed one when a part fails", async () => {
    const world = partsWorld({
      modelReply: (user) => {
        const diff = diffBlock(user);
        if (diff.includes("+++ b/src/part5.ts")) {
          return json({ error: { message: "upstream exploded" } }, 400);
        }
        return completion(JSON.stringify({ findings: [partsFinding("src/part1.ts")] }));
      },
    });
    const { result, calls } = await runReview(world);

    expect(result).toMatchObject({
      exitCode: 0,
      conclusion: "neutral",
      error: "1 of 2 review parts failed",
    });
    expect(reviewCalls(calls)).toHaveLength(1);

    const summary = summaryBody(world);
    expect(summary).toContain("- Posted this pass: 1");
    expect(summary).toMatch(/- Parts: 1 of 2 reviewed; part 2 \(src\/part5\.ts, src\/part6\.ts\) failed: OpenRouter returned 400: upstream exploded/);

    const finish = checkPatches(calls, 77);
    const output = (finish.at(-1)!.body as { conclusion: string; output: { title: string } });
    expect(output.conclusion).toBe("neutral");
    expect(output.output.title).toBe("Bugbot reviewed only part of this PR");
  });

  it("retries a failed part on big_pr_model", async () => {
    const world = partsWorld({
      modelReply: (user) => {
        const diff = diffBlock(user);
        if (diff.includes("+++ b/src/part5.ts")) {
          return json({ error: { message: "bad part" } }, 400);
        }
        return completion(JSON.stringify({ findings: [] }));
      },
    });
    let bigCalls = 0;
    const { result, calls } = await runReview(world, { BUGBOT_BIG_PR_MODEL: "google/gemini-test" });
    for (const call of mainModelCalls(calls)) {
      if ((call.body as { model: string }).model === "google/gemini-test") {
        bigCalls += 1;
      }
    }

    // The fake fails every request for part 2, whichever model is asked.
    expect(bigCalls).toBe(1);
    expect(result.conclusion).toBe("neutral");
  });

  it("names the failure in the check title when every part fails", async () => {
    const world = partsWorld({ modelStatus: 400, modelMessage: "no such model" });
    const { result, calls } = await runReview(world);

    expect(result.conclusion).toBe("neutral");
    expect(result.error).toContain("all 2 review parts failed; part 1: OpenRouter returned 400: no such model");
    const summary = summaryBody(world);
    expect(summary).toContain("Bugbot couldn't review: all 2 review parts failed");
    expect(summary).toContain("- Parts: 0 of 2 reviewed");
    const finish = checkPatches(calls, 77);
    expect((finish.at(-1)!.body as { output: { title: string } }).output.title).toBe(
      "Bugbot couldn't review",
    );
  });
});
