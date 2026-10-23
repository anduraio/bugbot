import {
  MAX_POSTED_COMMENTS,
  formatComment,
  parseMarker,
  type Category,
  type DiffSide,
  type ParsedMarker,
  type PlannedComment,
} from "./filter.js";
import type { PullRequestState } from "./gate.js";
import type { FetchLike, Sleep } from "./model.js";

/**
 * GitHub output: inline comments, the summary comment, the `bugbot` check run
 * and replies for fixed threads.
 *
 * Every request goes through `request()`, which checks a small allowlist
 * BEFORE calling fetch. There is deliberately no code path that can build a
 * merge, approve, dismiss or requested-reviewer request: those routes are not
 * in the allowlist, review events must be exactly `COMMENT`, and only the one
 * GraphQL document below is accepted. Bugbot stays comment-only: it replies
 * that a thread looks fixed and leaves resolving to a person.
 */

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_BOT_LOGIN = "andura-bugbot";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const FINISH_CHECK_ATTEMPTS = 3;
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_PAGES = 20;
const MAX_CHECK_SUMMARY = 60_000;
const MAX_SUMMARY_CHARS = 60_000;
const MAX_ERROR_CHARS = 200;
const MAX_TRUNCATED_FILES = 50;
const MAX_RUN_IDS = 200;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_CONTENTS_BYTES = 1024 * 1024;
const SUMMARY_MARKER = "<!-- bugbot:summary -->";
const RUNS_MARKER_PREFIX = "<!-- bugbot:runs ";
const COMMENT_ONLY_NOTE = "Bugbot only comments; it never approves or blocks.";
const ACCEPT_JSON = "application/vnd.github+json";
const ACCEPT_DIFF = "application/vnd.github.diff";
const ACCEPT_RAW = "application/vnd.github.raw";
const REVIEW_BODY =
  "Bugbot review. Inline comments only; it never approves or blocks.";

/**
 * Skip replies: the keyword must open the reply (after @mentions), or the whole
 * reply must be short. The curly apostrophe is what macOS and mobile keyboards
 * send; `wontfix`, `wont fix` and `won't fix` are all accepted.
 */
const SKIP_AT_START = /^(?:skip\b|won[’']?t\s*fix\b|wontfix\b)/i;
const SKIP_ANYWHERE = /\b(?:skip|won[’']?t\s*fix|wontfix)\b/i;
const NEGATED_SKIP =
  /\b(?:can(?:not|['’]t)|don(?:['’]t)|not|never)\b[^.!?\n]*\b(?:skip|won[’']?t\s*fix|wontfix)\b/i;
const MENTION_PREFIX = /^(?:@[A-Za-z0-9-]+\s*)+/;
const SHORT_REPLY_CHARS = 40;

const REVIEW_THREADS_QUERY = `query BugbotReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          diffSide
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { databaseId author { login __typename } body diffHunk }
          }
        }
      }
    }
  }
}`;

/** The only GraphQL document this file may send. */
const GRAPHQL_DOCUMENTS: ReadonlySet<string> = new Set([REVIEW_THREADS_QUERY]);

type HttpMethod = "GET" | "POST" | "PATCH";

/** One request, as it appears in a dry-run plan and in test recordings. */
export interface PlannedRequest {
  readonly method: HttpMethod;
  /** API path only, for example `/repos/o/r/pulls/1`. */
  readonly path: string;
  readonly body?: unknown;
}

interface AllowedRoute {
  readonly method: HttpMethod;
  readonly pattern: RegExp;
  /** A pull review must carry `event: "COMMENT"`. */
  readonly review?: boolean;
  /** The only alternate media type this route may ask for. */
  readonly media?: "diff" | "raw";
  /** Path is a contents blob and gets strict segment validation. */
  readonly contents?: boolean;
  /** Query keys this route may carry, with the only accepted value shape. */
  readonly query?: Readonly<Record<string, QueryRule>>;
}

type QueryRule = "hex-sha" | "bugbot" | "positive-integer" | "all";

const OWNER_NAME = "[A-Za-z0-9-]+/[A-Za-z0-9._-]+";

/**
 * The complete write/read surface. Anything else throws before fetch.
 * Deliberately absent: merge, approve, review dismissals and requested
 * reviewers. The tests assert these rejections with no fetch call.
 */
const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  {
    method: "GET",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/pulls/[1-9][0-9]*$`),
    media: "diff",
  },
  {
    // The before..after comparison for an incremental synchronize pass. JSON
    // gives ancestry, the diff media type gives the changed hunks.
    method: "GET",
    pattern: new RegExp(
      `^/repos/${OWNER_NAME}/compare/[0-9a-f]{40}\\.\\.\\.[0-9a-f]{40}$`,
    ),
    media: "diff",
  },
  {
    method: "GET",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/issues/[1-9][0-9]*/comments$`),
    query: { per_page: "positive-integer", page: "positive-integer" },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/issues/[1-9][0-9]*/comments$`),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/issues/comments/[1-9][0-9]*$`),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/pulls/[1-9][0-9]*/reviews$`),
    review: true,
  },
  {
    method: "POST",
    pattern: new RegExp(
      `^/repos/${OWNER_NAME}/pulls/[1-9][0-9]*/comments/[1-9][0-9]*/replies$`,
    ),
  },
  {
    method: "POST",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/check-runs$`),
  },
  {
    method: "PATCH",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/check-runs/[0-9]+$`),
  },
  {
    method: "GET",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/commits/[0-9a-f]{40}/check-runs$`),
    query: {
      check_name: "bugbot",
      filter: "all",
      per_page: "positive-integer",
      page: "positive-integer",
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/repos/${OWNER_NAME}/contents/(?:[^/]+/)*[^/]+$`),
    media: "raw",
    contents: true,
    query: { ref: "hex-sha" },
  },
  {
    method: "POST",
    pattern: /^\/graphql$/,
  },
];

export interface GuardedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number>>;
  readonly accept?: string;
}

/**
 * Throws unless the request is one of the allowlisted operations. This is the
 * single gate before every fetch; it rejects the method and path first, then
 * the query keys, media type, review event and GraphQL document.
 */
export function assertAllowedRequest(request: GuardedRequest): void {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "PATCH") {
    throw new Error(`GitHub request not allowed: ${method} ${request.path}`);
  }

  const route = ALLOWED_ROUTES.find(
    (candidate) =>
      candidate.method === method && candidate.pattern.test(request.path),
  );
  if (route === undefined) {
    throw new Error(`GitHub request not allowed: ${method} ${request.path}`);
  }

  const repository = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(request.path);
  if (
    repository !== null &&
    (isDotOnly(repository[1] ?? "") || isDotOnly(repository[2] ?? ""))
  ) {
    throw new Error("GitHub request not allowed: invalid repository");
  }

  validateQuery(route, request.query ?? {});
  validateMedia(route, request.accept);

  if (route.contents === true) {
    validateContentsPath(request.path);
  }

  const body = asRecord(request.body);
  if (body !== null && "event" in body && body.event !== "COMMENT") {
    throw new Error("GitHub review event must be COMMENT");
  }

  if (route.review === true && (body === null || body.event !== "COMMENT")) {
    throw new Error("GitHub review event must be COMMENT");
  }

  if (request.path === "/graphql") {
    const query = body === null ? null : asString(body.query);
    if (query === null || !GRAPHQL_DOCUMENTS.has(query)) {
      throw new Error("GitHub GraphQL operation not allowed");
    }
  }
}

/** Only the allowlisted query keys, with the only value shape each accepts. */
function validateQuery(
  route: AllowedRoute,
  query: Readonly<Record<string, string | number>>,
): void {
  const allowed = route.query ?? {};
  for (const [key, value] of Object.entries(query)) {
    const rule = allowed[key];
    if (rule === undefined) {
      throw new Error(`GitHub request not allowed: query parameter ${key}`);
    }

    const raw = String(value);
    const valid =
      rule === "hex-sha"
        ? /^[0-9a-f]{40}$/.test(raw)
        : rule === "bugbot"
          ? raw === "bugbot"
          : rule === "all"
            ? raw === "all"
            : /^[1-9][0-9]*$/.test(raw);
    if (!valid) {
      throw new Error(`GitHub request not allowed: invalid ${key}`);
    }
  }
}

/** The JSON media type everywhere, except the two documented raw reads. */
function validateMedia(route: AllowedRoute, accept: string | undefined): void {
  if (accept === undefined || accept === ACCEPT_JSON) {
    return;
  }
  if (accept === ACCEPT_DIFF && route.media === "diff") {
    return;
  }
  if (accept === ACCEPT_RAW && route.media === "raw") {
    return;
  }
  throw new Error("GitHub request not allowed: unsupported Accept header");
}

/**
 * Contents paths come from a parsed diff, so they are untrusted. Every segment
 * is a literal file name: no empty, `.` or `..` segment, no leading slash, no
 * NUL, and no percent-encoded separator or dot that could normalise away.
 */
function validateContentsPath(path: string): void {
  const marker = "/contents/";
  const index = path.indexOf(marker);
  if (index < 0 || path.includes("\u0000")) {
    throw new Error("GitHub request not allowed: unsafe contents path");
  }

  const rest = path.slice(index + marker.length);
  if (rest === "" || rest.startsWith("/") || rest.endsWith("/")) {
    throw new Error("GitHub request not allowed: unsafe contents path");
  }

  for (const segment of rest.split("/")) {
    const lower = segment.toLowerCase();
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      lower.includes("%2f") ||
      lower.includes("%2e") ||
      lower.includes("%5c")
    ) {
      throw new Error("GitHub request not allowed: unsafe contents path");
    }
  }
}

/** A safe GitHub failure: never carries the token or a response body. */
export class GitHubError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export interface GitHubTransportOptions {
  /** Injectable fetch, so tests make no network call. */
  fetch?: FetchLike;
  /** Injectable sleep, so tests do not wait for backoff. */
  sleep?: Sleep;
  /** Environment lookup for GITHUB_API_URL / GITHUB_GRAPHQL_URL. */
  env?: (name: string) => string;
  /** API base URL. Defaults to GITHUB_API_URL, then https://api.github.com. */
  baseUrl?: string;
  /** GraphQL URL. Defaults to GITHUB_GRAPHQL_URL, then `<base>/graphql`. */
  graphqlUrl?: string;
  /** Per-attempt timeout covering fetch and the body read. Default 30 s. */
  timeoutMs?: number;
  /** Build the request (and return it) without sending any write. */
  dryRun?: boolean;
  /** Login of the GitHub App, with or without a trailing `[bot]`. */
  botLogin?: string;
  /** Where failures are logged. Defaults to console.error. */
  log?: (line: string) => void;
}

export interface PullRequestQuery extends GitHubTransportOptions {
  token: string;
  /** "owner/name" of the repository under review. */
  repository: string;
  prNumber: number;
}

/**
 * Reads the PR head SHA, draft and fork state, and labels. The CLI calls this
 * only when the triggering event has no pull_request payload (workflow_dispatch
 * or a direct action.yml call), then re-applies the draft/fork gate before
 * posting.
 */
export async function fetchPullRequest(
  query: PullRequestQuery,
): Promise<PullRequestState> {
  validateRepository(query.repository);
  validatePrNumber(query.prNumber);
  const context = transport(query);

  const response = await request(context, {
    method: "GET",
    path: pullPath(query.repository, query.prNumber),
  });
  const payload = asRecord(response.json);
  if (payload === null) {
    throw new GitHubError(
      "GitHub pull request response was not an object",
      response.status,
    );
  }

  const head = asRecord(payload.head);
  const headSha = head === null ? null : asString(head.sha);
  if (headSha === null) {
    throw new GitHubError(
      "GitHub pull request response had no head SHA",
      response.status,
    );
  }

  const headRepo = head === null ? null : asRecord(head.repo);
  const base = asRecord(payload.base);
  const baseRepo = base === null ? null : asRecord(base.repo);
  const headFullName = headRepo === null ? null : asString(headRepo.full_name);
  const baseFullName = baseRepo === null ? null : asString(baseRepo.full_name);

  const labels: string[] = [];
  for (const label of asArray(payload.labels)) {
    const record = asRecord(label);
    const name = record === null ? null : asString(record.name);
    if (name !== null) {
      labels.push(name);
    }
  }

  return {
    number: query.prNumber,
    headSha,
    draft: payload.draft === true,
    fork:
      headFullName === null ||
      baseFullName === null ||
      headFullName !== baseFullName,
    labels,
  };
}

export interface PullRequestDetails extends PullRequestState {
  /** Base commit SHA of the PR, for content reads at the old side. */
  baseSha: string;
  title: string;
  body: string;
}

/**
 * The full PR record the non-local review needs: base and head SHAs plus the
 * title and body. The gate may come from the event payload, but these values
 * always come from the API at review time.
 */
export async function fetchPullRequestDetails(
  query: PullRequestQuery,
): Promise<PullRequestDetails> {
  validateRepository(query.repository);
  validatePrNumber(query.prNumber);
  const context = transport(query);

  const response = await request(context, {
    method: "GET",
    path: pullPath(query.repository, query.prNumber),
  });
  const payload = asRecord(response.json);
  if (payload === null) {
    throw new GitHubError(
      "GitHub pull request response was not an object",
      response.status,
    );
  }

  const head = asRecord(payload.head);
  const headSha = head === null ? null : asString(head.sha);
  if (headSha === null) {
    throw new GitHubError(
      "GitHub pull request response had no head SHA",
      response.status,
    );
  }

  const base = asRecord(payload.base);
  const baseSha = base === null ? null : asString(base.sha);
  if (baseSha === null) {
    throw new GitHubError(
      "GitHub pull request response had no base SHA",
      response.status,
    );
  }

  const headRepo = head === null ? null : asRecord(head.repo);
  const baseRepo = base === null ? null : asRecord(base.repo);
  const headFullName = headRepo === null ? null : asString(headRepo.full_name);
  const baseFullName = baseRepo === null ? null : asString(baseRepo.full_name);

  const labels: string[] = [];
  for (const label of asArray(payload.labels)) {
    const record = asRecord(label);
    const name = record === null ? null : asString(record.name);
    if (name !== null) {
      labels.push(name);
    }
  }

  return {
    number: query.prNumber,
    headSha,
    baseSha,
    title: asString(payload.title) ?? "",
    body: asString(payload.body) ?? "",
    draft: payload.draft === true,
    fork:
      headFullName === null ||
      baseFullName === null ||
      headFullName !== baseFullName,
    labels,
  };
}

/**
 * Reads the PR diff at the exact SHAs GitHub reports. It never touches a
 * checkout. The body is capped at 5 MB; over that, or a 406/422 "too large",
 * the pass ends neutral with a clear reason instead of sending a partial diff.
 */
export async function fetchPullRequestDiff(
  query: PullRequestQuery,
): Promise<string> {
  validateRepository(query.repository);
  validatePrNumber(query.prNumber);
  const context = transport(query);

  let response: RequestResult;
  try {
    response = await request(context, {
      method: "GET",
      path: pullPath(query.repository, query.prNumber),
      accept: ACCEPT_DIFF,
      raw: true,
    });
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.status === 406 || error.status === 422)
    ) {
      throw new GitHubError(
        "pull request diff is too large to review (GitHub returned 406/422)",
        error.status,
      );
    }
    throw error;
  }

  if (
    (response.contentLength !== null &&
      response.contentLength > MAX_DIFF_BYTES) ||
    response.text.length > MAX_DIFF_BYTES
  ) {
    throw new GitHubError("pull request diff is too large to review (over 5 MB)");
  }

  return response.text;
}

export interface CompareQuery extends GitHubTransportOptions {
  token: string;
  /** "owner/name" of the repository under review. */
  repository: string;
  /** The commit before the push. */
  baseSha: string;
  /** The commit after the push, normally the PR head. */
  headSha: string;
}

/**
 * GitHub's compare status for base..head. `ahead` means head contains base
 * (base is an ancestor), `diverged` means a force-push, `behind` means the
 * event is stale. Step 8c only narrows to the new commits on `ahead`.
 */
export async function compareCommitStatus(
  query: CompareQuery,
): Promise<string> {
  validateRepository(query.repository);
  validateHeadSha(query.baseSha, "baseSha");
  validateHeadSha(query.headSha, "headSha");
  const context = transport(query);

  const response = await request(context, {
    method: "GET",
    path: comparePath(query.repository, query.baseSha, query.headSha),
  });
  const payload = asRecord(response.json);
  const status = payload === null ? null : asString(payload.status);
  if (status === null) {
    throw new GitHubError(
      "GitHub compare response had no status",
      response.status,
    );
  }

  return status;
}

/**
 * Reads the unified diff for before..after. Same 5 MB cap as the PR diff, so
 * a hostile range ends the incremental narrowing and the caller reviews the
 * full PR diff instead of a partial one.
 */
export async function fetchCompareDiff(query: CompareQuery): Promise<string> {
  validateRepository(query.repository);
  validateHeadSha(query.baseSha, "baseSha");
  validateHeadSha(query.headSha, "headSha");
  const context = transport(query);

  let response: RequestResult;
  try {
    response = await request(context, {
      method: "GET",
      path: comparePath(query.repository, query.baseSha, query.headSha),
      accept: ACCEPT_DIFF,
      raw: true,
    });
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.status === 406 || error.status === 422)
    ) {
      throw new GitHubError(
        "compare diff is too large to review (GitHub returned 406/422)",
        error.status,
      );
    }
    throw error;
  }

  if (
    (response.contentLength !== null &&
      response.contentLength > MAX_DIFF_BYTES) ||
    response.text.length > MAX_DIFF_BYTES
  ) {
    throw new GitHubError("compare diff is too large to review (over 5 MB)");
  }

  return response.text;
}

export interface ContentsQuery extends GitHubTransportOptions {
  token: string;
  /** "owner/name" of the repository under review. */
  repository: string;
  /** Repo-relative file path, with `/` separators. */
  path: string;
  /** Exact commit SHA. */
  ref: string;
}

/**
 * Reads one file at one commit through the contents API. A 404 (absent at that
 * commit), a 403 (GitHub refuses a blob over 1 MB), or any body over 1 MB
 * returns null, so the caller can skip it. Unsafe paths throw before a request.
 */
export async function readRepositoryFile(
  query: ContentsQuery,
): Promise<string | null> {
  validateRepository(query.repository);
  validateHeadSha(query.ref, "ref");
  const context = transport(query);
  const path = contentsPath(query.repository, query.path);

  let response: RequestResult;
  try {
    response = await request(context, {
      method: "GET",
      path,
      query: { ref: query.ref },
      accept: ACCEPT_RAW,
      raw: true,
    });
  } catch (error) {
    if (
      error instanceof GitHubError &&
      (error.status === 403 || error.status === 404 || error.status === 413)
    ) {
      return null;
    }
    throw error;
  }

  if (
    (response.contentLength !== null &&
      response.contentLength > MAX_CONTENTS_BYTES) ||
    response.text.length > MAX_CONTENTS_BYTES ||
    response.text.includes("\u0000")
  ) {
    return null;
  }

  return response.text;
}

export interface GitHubOptions extends GitHubTransportOptions {
  /** Short-lived GitHub App token minted by actions/create-github-app-token. */
  token: string;
  /** "owner/name" of the repository under review. */
  repository: string;
  prNumber: number;
  headSha: string;
  runId: string;
}

export interface CheckRunHandle {
  id: number;
  /** The GitHub App that created the run; null or absent when unknown. */
  appId?: number | null;
  /** The request that created (or, in a dry run, would create) the run. */
  planned?: PlannedRequest;
}

/** One `bugbot` check run on a commit, as the lookup sees it. */
export interface CheckRunInfo {
  id: number;
  status: string | null;
  externalId: string | null;
  /** The GitHub App that owns the run; null when the response had none. */
  appId: number | null;
  /** `success`, `neutral`, ... once completed; null while it runs. */
  conclusion: string | null;
}

/** A neutral check never fails the PR. Bugbot has no failure conclusion. */
export type CheckConclusion = "neutral" | "success";

export interface BugbotThread {
  threadId: string;
  firstCommentId: number;
  path: string;
  /** Null when GitHub no longer maps the thread to a diff line. */
  line: number | null;
  originalLine: number | null;
  side: DiffSide | null;
  isResolved: boolean;
  marker: ParsedMarker;
  category: Category | null;
  reason: string;
  state: "open" | "resolved" | "skipped";
  /**
   * True when a bot reply already starts "Fixed in " (older passes) or
   * "Looks fixed as of " (step 8f). Such a thread is marked fixed: it is not
   * re-checked, not counted open, and never gets a second fixed reply.
   */
  hasFixedReply?: boolean;
  /**
   * The first comment's original diff hunk, when GitHub returned one. Optional
   * so older recorded data and responses without the field still work (S8D-B3).
   */
  diffHunk?: string | null;
}

export interface ParsedThreadBody {
  category: Category | null;
  reason: string;
}

export interface FailedComment {
  file: string;
  line: number;
  status: number;
}

export interface PostReviewResult {
  posted: number;
  failed: readonly FailedComment[];
  /** Every review request sent, or planned when `dryRun` is set. */
  planned: readonly PlannedRequest[];
}

export interface SummaryResult {
  action: "created" | "updated";
  planned: PlannedRequest;
  /** The summary body that was there before, for pass-count bookkeeping. */
  previousBody: string | null;
}

/** One bot summary comment found on the PR. */
export interface SummaryComment {
  id: number;
  body: string;
}

export interface ReplyThreadsResult {
  /** Replies posted this pass; each one marks its thread fixed for a person. */
  replied: number;
  failed: number;
  planned: readonly PlannedRequest[];
}

/** Non-zero skip buckets, named in the summary (step 8c). */
export interface SkippedCounts {
  duplicate?: number;
  belowConfidence?: number;
  lowSeverity?: number;
  notInDiff?: number;
  triageDismissed?: number;
  overCap?: number;
  schemaInvalid?: number;
  outOfScope?: number;
}

export interface ReviewSummary {
  passCount: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /**
   * Safe per-attempt reasoning settings and token counts for the main model
   * call, for example `#1 effort=high cap 64000 (...)`.
   */
  reasoning?: string;
  /** Inline comments posted by this pass only. */
  posted: number;
  /**
   * Open Bugbot threads after this pass: existing plus this pass's posts.
   * `unknown` when the pass failed before the thread list was read and no
   * earlier summary had a count to keep (S8D-B4).
   */
  openComments: number | "unknown";
  skipped: SkippedCounts;
  /** Replies posted this pass, each marking a fixed thread for a person. */
  markedFixed: number;
  /** Findings that did not land as inline comments (S6B-B1). */
  failed?: number;
  truncated: readonly string[];
  /** Run ids for the hidden pass-count line, oldest first. */
  runs?: readonly string[];
  /** Optional one-line failure shown as "Bugbot couldn't review: <reason>". */
  error?: string;
}

/**
 * Records the in-progress `bugbot` check for this pass, so babysitters see a
 * pending check while the review runs.
 */
export async function startCheck(
  options: GitHubOptions,
): Promise<CheckRunHandle> {
  validateOptions(options);
  const context = transport(options);

  const response = await request(context, {
    method: "POST",
    path: repoPath(options.repository, "check-runs"),
    body: {
      name: "bugbot",
      head_sha: options.headSha,
      status: "in_progress",
      external_id: options.runId,
    },
  });

  if (options.dryRun === true) {
    return { id: 0, planned: response.plan };
  }

  const payload = asRecord(response.json);
  const id = payload === null ? null : asNumber(payload.id);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubError(
      "GitHub check run response had no id",
      response.status,
    );
  }

  return { id, appId: appIdOf(payload?.app), planned: response.plan };
}

/**
 * Completes a check run with `neutral` or `success` only. Any other conclusion
 * is rejected here, before a request, so Bugbot can never fail a PR.
 *
 * The PATCH is idempotent, so a 5xx or a timeout is retried a bounded number
 * of times. A caller that still sees a failure must fall back to creating one
 * completed neutral run, or the check can stay in_progress forever.
 */
export async function finishCheck(
  options: GitHubOptions,
  check: CheckRunHandle,
  conclusion: CheckConclusion,
  summary: string,
): Promise<PlannedRequest> {
  validateOptions(options);
  if (conclusion !== "neutral" && conclusion !== "success") {
    throw new Error("Bugbot check conclusion must be neutral or success");
  }

  const context = transport(options);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request(context, {
        method: "PATCH",
        path: repoPath(options.repository, `check-runs/${check.id}`),
        body: {
          status: "completed",
          conclusion,
          output: {
            title: "Bugbot",
            summary: redact(summary, options.token).slice(0, MAX_CHECK_SUMMARY),
          },
        },
      });

      return response.plan;
    } catch (error) {
      if (!(error instanceof GitHubError)) {
        throw error;
      }
      const status = error.status;
      const retryable = status === null || status >= 500;
      if (!retryable || attempt + 1 >= FINISH_CHECK_ATTEMPTS) {
        throw error;
      }
      await context.sleep(500 * 2 ** attempt);
    }
  }
}

/**
 * Records the completed neutral `bugbot` check and summary for a draft or
 * fork PR Bugbot chose not to review.
 */
export async function reportSkipped(
  options: GitHubOptions,
  summary: string,
): Promise<PlannedRequest> {
  validateOptions(options);
  const context = transport(options);

  const response = await request(context, {
    method: "POST",
    path: repoPath(options.repository, "check-runs"),
    body: {
      name: "bugbot",
      head_sha: options.headSha,
      status: "completed",
      conclusion: "neutral",
      external_id: options.runId,
      output: {
        title: "Bugbot",
        summary: redact(summary, options.token).slice(0, MAX_CHECK_SUMMARY),
      },
    },
  });

  return response.plan;
}

/**
 * Lists every `bugbot` check run on a commit (the head SHA by default) with
 * `filter=all`, so a run hidden behind a newer one on the same commit is still
 * visible. The caller matches `external_id` to this pass, finishes every
 * still-`in_progress` match (S6B-N2), completes stale runs from other passes,
 * and reads `conclusion` to decide whether the `before` commit was reviewed
 * (S8D-B3).
 */
export async function listCheckRuns(
  options: GitHubOptions,
  sha: string = options.headSha,
): Promise<readonly CheckRunInfo[]> {
  validateOptions(options);
  validateHeadSha(sha, "sha");
  const context = transport(options);
  const runs: CheckRunInfo[] = [];

  let page = 1;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const response = await request(context, {
      method: "GET",
      path: repoPath(options.repository, `commits/${sha}/check-runs`),
      query: {
        check_name: "bugbot",
        filter: "all",
        per_page: 100,
        page,
      },
    });

    const payload = asRecord(response.json);
    for (const item of asArray(payload?.check_runs)) {
      const run = asRecord(item);
      if (run === null) {
        continue;
      }
      const name = asString(run.name);
      const id = positiveInteger(run.id);
      if (name === "bugbot" && id !== null) {
        runs.push({
          id,
          status: asString(run.status),
          externalId: asString(run.external_id),
          appId: appIdOf(run.app),
          conclusion: asString(run.conclusion),
        });
      }
    }

    if (!response.hasNext) {
      return runs;
    }
    page += 1;
  }

  throw new GitHubError(
    `GitHub check-run pagination exceeded ${MAX_PAGES} pages`,
  );
}

/**
 * Parses the visible shape `formatComment` writes: a bold title line, a blank
 * line, then the reason paragraph. A body that does not have that shape keeps
 * `category: null` rather than guessing. The hidden marker is ignored here.
 */
export function parseThreadBody(body: string): ParsedThreadBody {
  const lines = body.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") {
    index += 1;
  }

  const title = lines[index] ?? "";
  const titleMatch = /^\*\*(.+)\*\*\s*$/.exec(title);
  if (titleMatch === null) {
    return { category: null, reason: "" };
  }

  const inner = titleMatch[1] ?? "";
  const label = /^[A-Za-z]+ ([a-z-]+):/.exec(inner);
  const rawCategory = label?.[1] ?? "";
  const category = isCategory(rawCategory) ? rawCategory : null;

  let reason = lines.slice(index + 1).join("\n");
  const cuts = [
    reason.indexOf("\n\n**Suggested fix:**"),
    reason.indexOf("\n<!-- bugbot:v1 "),
    reason.indexOf("\nRUN_ID:"),
  ].filter((position) => position >= 0);
  if (cuts.length > 0) {
    reason = reason.slice(0, Math.min(...cuts));
  }

  return { category, reason: reason.trim() };
}

/**
 * Lists Bugbot's review threads with their state. A thread counts only when its
 * FIRST comment is authored by the bot AND carries a valid marker: a look-alike
 * marker copied into a human comment is ignored, and a deleted user (null
 * author) is never the bot.
 */
export async function listBugbotThreads(
  options: GitHubOptions,
): Promise<readonly BugbotThread[]> {
  validateOptions(options);
  const context = transport(options);
  const [owner, name] = splitRepository(options.repository);

  const threads: BugbotThread[] = [];
  const botLogin = botLoginOf(options.botLogin);
  const log = logger(options);
  let after: string | null = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await graphqlRequest(
      context,
      REVIEW_THREADS_QUERY,
      { owner, name, number: options.prNumber, after },
    );
    const reviewThreads = asRecord(
      nested(result.data, "repository", "pullRequest", "reviewThreads"),
    );
    if (reviewThreads === null) {
      throw new GitHubError("GitHub GraphQL response had no review threads");
    }

    for (const node of asArray(reviewThreads.nodes)) {
      // Parse first: a human-first thread is ignored even when it has more
      // comments than one page, so a long conversation cannot block the PR.
      const thread = parseThreadNode(node, botLogin);
      if (thread === null) {
        continue;
      }
      if (threadCommentsHaveNextPage(node)) {
        log(
          `Bugbot: thread ${thread.threadId} has more comments than one page; treating it as skipped`,
        );
        threads.push({ ...thread, state: "skipped" });
        continue;
      }
      threads.push(thread);
    }

    const pageInfo = asRecord(reviewThreads.pageInfo);
    const hasNextPage = pageInfo !== null && pageInfo.hasNextPage === true;
    const endCursor = pageInfo === null ? null : asString(pageInfo.endCursor);
    if (!hasNextPage || endCursor === null || endCursor === "") {
      complete = true;
      break;
    }
    after = endCursor;
  }

  if (!complete) {
    throw new GitHubError(
      `GitHub review thread pagination exceeded ${MAX_PAGES} pages`,
    );
  }

  return threads;
}

/**
 * Posts one review with `event: "COMMENT"` and the planned inline comments.
 * A 422 on the batch falls back to one review per comment, so one bad anchor
 * cannot drop every finding. Returns what was posted and what failed.
 */
export async function postReview(
  options: GitHubOptions,
  comments: readonly PlannedComment[],
): Promise<PostReviewResult> {
  validateOptions(options);
  if (comments.length > MAX_POSTED_COMMENTS) {
    throw new Error(
      `too many inline comments: ${comments.length} exceeds ${MAX_POSTED_COMMENTS}`,
    );
  }
  if (comments.length === 0) {
    return { posted: 0, failed: [], planned: [] };
  }

  const context = transport(options);
  const planned: PlannedRequest[] = [];
  const reviewRequest: PlannedRequest = {
    method: "POST",
    path: pullPath(options.repository, options.prNumber, "reviews"),
    body: {
      commit_id: options.headSha,
      event: "COMMENT",
      body: REVIEW_BODY,
      comments: comments.map((comment) => inlineComment(comment, options)),
    },
  };

  try {
    const response = await request(context, reviewRequest);
    return { posted: comments.length, failed: [], planned: [response.plan] };
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) {
      throw error;
    }
  }

  const log = logger(options);
  const failed: FailedComment[] = [];
  let posted = 0;

  for (const comment of comments) {
    try {
      const response = await request(context, {
        method: "POST",
        path: pullPath(options.repository, options.prNumber, "reviews"),
        body: {
          commit_id: options.headSha,
          event: "COMMENT",
          body: REVIEW_BODY,
          comments: [inlineComment(comment, options)],
        },
      });
      planned.push(response.plan);
      posted += 1;
    } catch (error) {
      const status = error instanceof GitHubError ? (error.status ?? 0) : 0;
      failed.push({ file: comment.file, line: comment.line, status });
      log(
        `Bugbot could not post ${safeDisplay(comment.file)}:${comment.line} (status ${status})`,
      );
    }
  }

  return { posted, failed, planned };
}

/**
 * Finds the bot-authored summary comment, or null when the PR has none.
 * Only a comment by the bot carrying the marker counts; a human's look-alike
 * marker is ignored.
 */
export async function findSummary(
  options: GitHubOptions,
): Promise<SummaryComment | null> {
  validateOptions(options);
  const context = transport(options);
  const botLogin = botLoginOf(options.botLogin);

  let found: SummaryComment | null = null;
  let hasNext = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(context, {
      method: "GET",
      path: repoPath(
        options.repository,
        `issues/${options.prNumber}/comments`,
      ),
      query: { per_page: 100, page },
    });

    if (!Array.isArray(response.json)) {
      throw new GitHubError(
        "GitHub issue comments response was not an array",
        response.status,
      );
    }

    for (const item of response.json) {
      const comment = asRecord(item);
      if (comment === null) {
        continue;
      }
      const user = asRecord(comment.user);
      if (!isBotAuthor(user, botLogin, "rest")) {
        continue;
      }
      const text = asString(comment.body) ?? "";
      if (!text.includes(SUMMARY_MARKER)) {
        continue;
      }
      const id = asNumber(comment.id);
      if (id !== null && Number.isSafeInteger(id) && id > 0) {
        found = { id, body: text };
        break;
      }
    }

    hasNext = response.hasNext;
    if (found !== null || !hasNext) {
      break;
    }
  }

  if (found === null && hasNext) {
    throw new GitHubError(
      `GitHub issue comment pagination exceeded ${MAX_PAGES} pages`,
    );
  }

  return found;
}

export interface UpsertSummaryOptions {
  /**
   * A summary the caller already read. Omit to scan the comments; pass null
   * when the caller knows there is none yet.
   */
  previous?: SummaryComment | null;
}

/**
 * Creates or edits the single summary comment, marked `<!-- bugbot:summary -->`.
 * Only a comment by the bot is edited; a human's look-alike marker is ignored.
 */
export async function upsertSummary(
  options: GitHubOptions,
  summary: ReviewSummary,
  extra: UpsertSummaryOptions = {},
): Promise<SummaryResult> {
  validateOptions(options);
  const context = transport(options);
  const body = renderSummary(summary, options.token);
  const previous =
    extra.previous === undefined ? await findSummary(options) : extra.previous;

  if (previous !== null) {
    const response = await request(context, {
      method: "PATCH",
      path: repoPath(options.repository, `issues/comments/${previous.id}`),
      body: { body },
    });
    return {
      action: "updated",
      planned: response.plan,
      previousBody: previous.body,
    };
  }

  const response = await request(context, {
    method: "POST",
    path: repoPath(options.repository, `issues/${options.prNumber}/comments`),
    body: { body },
  });
  return { action: "created", planned: response.plan, previousBody: null };
}

/**
 * Makes a diff path or file name safe to print. A legal git path can carry a
 * newline or carriage return, and a line that starts with `::` is a workflow
 * command in an Actions log. Every control character becomes `?`, so no output
 * line can be started or split by a file name (R1-N3).
 */
export function safeDisplay(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
}

/** Escapes a backtick so a hostile file name cannot close a code span. */
function escapeBacktick(text: string): string {
  return text.replaceAll("`", "&#96;");
}

const SKIPPED_LABELS: ReadonlyArray<readonly [keyof SkippedCounts, string]> = [
  ["duplicate", "duplicate"],
  ["belowConfidence", "below confidence"],
  ["lowSeverity", "low severity"],
  ["notInDiff", "not in diff"],
  ["triageDismissed", "triage dismissed"],
  ["overCap", "over cap"],
  ["schemaInvalid", "schema invalid"],
  ["outOfScope", "out of scope"],
];

/**
 * Renders the one summary comment. The fixed final line is always appended,
 * even if a caller passes an empty or malformed summary. `secret` is the
 * options token and is always applied to the model name and error line. The
 * result is capped at 60,000 characters, below GitHub's 65,536 comment limit,
 * with a truncation note when anything had to go.
 */
export function renderSummary(summary: ReviewSummary, secret: string): string {
  const lines: string[] = [SUMMARY_MARKER];
  const runs = (summary.runs ?? []).filter((id) => /^\d+$/.test(id));
  const failed = summary.failed ?? 0;
  const skipped = SKIPPED_LABELS.map(([key, label]) => {
    const count = Math.max(0, Math.trunc(summary.skipped[key] ?? 0));
    return [label, count] as const;
  }).filter(([, count]) => count > 0);
  const skippedTotal = skipped.reduce((total, [, count]) => total + count, 0);
  if (runs.length > 0) {
    lines.push(
      `${RUNS_MARKER_PREFIX}${runs.slice(-MAX_RUN_IDS).join(",")} -->`,
    );
  }
  lines.push(
    "## Bugbot review",
    "",
    `- Passes: ${summary.passCount}`,
    `- Model: ${redact(summary.model, secret)}`,
    `- Tokens: ${summary.tokensIn} in / ${summary.tokensOut} out`,
    ...(summary.reasoning === undefined || summary.reasoning.trim() === ""
      ? []
      : [
          `- Reasoning: ${oneLine(
            redact(summary.reasoning, secret),
            500,
          )}`,
        ]),
    `- Posted this pass: ${summary.posted}`,
    `- Open Bugbot comments: ${
      typeof summary.openComments === "number"
        ? String(summary.openComments)
        : "unknown"
    }`,
    `- Failed to post: ${failed}`,
  );

  if (skipped.length > 0) {
    lines.push(
      `- Skipped: ${skipped
        .map(([label, count]) => `${count} ${label}`)
        .join(", ")}`,
    );
  }
  lines.push(`- Marked fixed this pass: ${summary.markedFixed}`);

  if (summary.error !== undefined && summary.error.trim() !== "") {
    lines.push(
      "",
      `Bugbot couldn't review: ${oneLine(
        escapeBacktick(redact(summary.error, secret)),
        500,
      )}`,
    );
  } else if (
    summary.posted === 0 &&
    skippedTotal === 0 &&
    failed === 0
  ) {
    lines.push("", "No findings this pass.");
  }

  if (summary.truncated.length > 0) {
    const shown = summary.truncated.slice(0, MAX_TRUNCATED_FILES);
    const more = summary.truncated.length - shown.length;
    const list = shown
      .map((file) => `\`${escapeBacktick(safeDisplay(file))}\``)
      .join(", ");
    lines.push(
      "",
      `**Files reduced to fit the context budget:** ${list}${
        more > 0 ? ` and ${more} more` : ""
      }`,
    );
  }

  lines.push("", COMMENT_ONLY_NOTE);
  const body = lines.join("\n");
  if (body.length <= MAX_SUMMARY_CHARS) {
    return body;
  }

  const note = "\n\n_(summary truncated)_";
  const tail = `\n\n${COMMENT_ONLY_NOTE}`;
  const room = Math.max(0, MAX_SUMMARY_CHARS - note.length - tail.length);
  return `${body.slice(0, room)}${note}${tail}`;
}

/**
 * Replies `Looks fixed as of <sha7>.` to each open thread Bugbot owns. It never
 * resolves a thread; a person does that with one click. Resolved, skipped and
 * already-marked threads are untouched, so no thread gets a second fixed reply.
 * One failure is logged and the rest continue.
 */
export async function replyFixedThreads(
  options: GitHubOptions,
  threads: readonly BugbotThread[],
  fixedSha: string,
): Promise<ReplyThreadsResult> {
  validateOptions(options);
  validateHeadSha(fixedSha, "fixedSha");
  const context = transport(options);
  const log = logger(options);
  const planned: PlannedRequest[] = [];
  let replied = 0;
  let failed = 0;

  for (const thread of threads) {
    if (thread.state !== "open") {
      continue;
    }

    try {
      // A thread already marked fixed by an earlier reply never gets a second
      // one, whatever wording that reply used (S6A-N9, S8F).
      if (thread.hasFixedReply !== true) {
        const reply = await request(context, {
          method: "POST",
          path: pullPath(
            options.repository,
            options.prNumber,
            `comments/${thread.firstCommentId}/replies`,
          ),
          body: { body: `Looks fixed as of ${fixedSha.slice(0, 7)}.` },
        });
        planned.push(reply.plan);
        replied += 1;
      }
    } catch (error) {
      failed += 1;
      log(
        `Bugbot could not reply on ${thread.threadId}: ${safeErrorMessage(
          error,
          options.token,
        )}`,
      );
    }
  }

  return { replied, failed, planned };
}

// --- transport ------------------------------------------------------------

interface RequestSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number>>;
  /** Alternate media type. Only the diff and raw-contents routes allow one. */
  readonly accept?: string;
  /** Return the body text instead of parsing JSON. */
  readonly raw?: boolean;
  /**
   * True for a POST that only reads (the review-threads query). Dry runs let
   * reads through and skip every write. Reads also retry like GETs.
   */
  readonly read?: boolean;
}

interface RequestContext {
  readonly token: string;
  readonly baseUrl: string;
  readonly graphqlUrl: string;
  readonly fetchFn: FetchLike;
  readonly sleep: Sleep;
  readonly timeoutMs: number;
  readonly dryRun: boolean;
}

interface RequestResult {
  readonly status: number;
  readonly json: unknown;
  /** Raw body text. Empty for a dry-run write. */
  readonly text: string;
  /** The response's Content-Length when GitHub sent one. */
  readonly contentLength: number | null;
  /** True when the response's Link header has rel="next". */
  readonly hasNext: boolean;
  readonly plan: PlannedRequest;
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const LINK_NEXT = /<[^>]*>\s*;\s*rel="?next"?/i;

/**
 * Resolves the API base. An explicit option wins, then GITHUB_API_URL, then
 * github.com. Both URLs must be https: before any request, so a bad env value
 * can never send the Authorization header to a plaintext or unexpected host.
 */
function transport(
  options: GitHubTransportOptions & { token: string },
): RequestContext {
  const readEnv = options.env ?? ((name: string) => process.env[name] ?? "");
  const baseRaw =
    options.baseUrl ?? (readEnv("GITHUB_API_URL").trim() || DEFAULT_BASE_URL);
  const baseUrl = normalizeHttpsUrl(baseRaw, "GITHUB_API_URL");
  const graphqlRaw =
    options.graphqlUrl ??
    (readEnv("GITHUB_GRAPHQL_URL").trim() || `${baseUrl}/graphql`);
  const graphqlUrl = normalizeHttpsUrl(graphqlRaw, "GITHUB_GRAPHQL_URL");

  return {
    token: options.token,
    baseUrl,
    graphqlUrl,
    fetchFn: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? defaultSleep,
    timeoutMs:
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS,
    dryRun: options.dryRun === true,
  };
}

/** Validates the scheme and strips trailing slashes. */
function normalizeHttpsUrl(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  return raw.replace(/\/+$/, "");
}

/** A timeout during one attempt. Retried only for idempotent methods. */
class RequestTimeoutError extends GitHubError {
  constructor(message: string) {
    super(message, null);
  }
}

/**
 * Rejects when the per-attempt AbortController fires, even if the injected
 * fetch or its body read ignores the signal. A real fetch aborts too; the race
 * keeps the timeout honest for any FetchLike.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("request aborted by timeout"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** One guarded HTTP call, with bounded retries. */
async function request(
  context: RequestContext,
  spec: RequestSpec,
): Promise<RequestResult> {
  assertAllowedRequest(spec);

  const plan: PlannedRequest = {
    method: spec.method,
    path: spec.path,
    ...(spec.body === undefined ? {} : { body: spec.body }),
  };

  // A dry run never sends a write. Reads (GET, and the GraphQL thread query)
  // still go through the fake/real fetch.
  const isRead = spec.read === true || spec.method === "GET";
  if (context.dryRun && !isRead) {
    return {
      status: 200,
      json: {},
      text: "",
      contentLength: null,
      hasNext: false,
      plan,
    };
  }

  const url =
    spec.path === "/graphql"
      ? context.graphqlUrl
      : buildUrl(context.baseUrl, spec.path, spec.query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.token}`,
    Accept: spec.accept ?? ACCEPT_JSON,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bugbot",
  };
  const init: RequestInit = { method: spec.method, headers };
  if (spec.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(spec.body);
  }
  const fetch = context.fetchFn;
  // A read-only POST (the review-threads query) is idempotent, so it retries
  // on a transient gateway error and on a timeout exactly like a GET (R1-N1).
  const idempotent = isRead || isIdempotentMethod(spec.method);

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await raceAbort(
        fetch(url, { ...init, signal: controller.signal }),
        controller.signal,
      );
      text = await raceAbort(response.text(), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        const timeout = new RequestTimeoutError(
          capError(
            `GitHub ${spec.method} ${spec.path} timed out after ${context.timeoutMs} ms`,
            context.token,
          ),
        );
        if (attempt < MAX_RETRIES && idempotent) {
          await context.sleep(retryDelayMs(null, attempt));
          continue;
        }
        throw timeout;
      }

      throw new GitHubError(
        capError(
          `GitHub ${spec.method} ${spec.path} failed: ${errorMessage(error)}`,
          context.token,
        ),
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const failure = new GitHubError(
        capError(
          `GitHub ${spec.method} ${spec.path} returned ${response.status}${errorDetail(
            text,
            context.token,
          )}`,
          context.token,
        ),
        response.status,
      );

      if (
        attempt < MAX_RETRIES &&
        isRetryableStatus(idempotent, response.status, retryAfter !== null)
      ) {
        const delay = retryDelayMs(retryAfter, attempt);
        if (delay > MAX_RETRY_WAIT_MS) {
          throw new GitHubError(
            capError(
              `GitHub ${spec.method} ${spec.path} returned ${response.status} with a Retry-After above the ${
                MAX_RETRY_WAIT_MS / 1000
              } s cap`,
              context.token,
            ),
            response.status,
          );
        }
        await context.sleep(delay);
        continue;
      }

      throw failure;
    }

    const contentLength = contentLengthOf(response);
    if (spec.raw === true) {
      return {
        status: response.status,
        json: null,
        text,
        contentLength,
        hasNext: LINK_NEXT.test(response.headers.get("link") ?? ""),
        plan,
      };
    }

    let json: unknown = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new GitHubError(
          capError(
            `GitHub ${spec.method} ${spec.path} returned invalid JSON`,
            context.token,
          ),
          response.status,
        );
      }
    }

    return {
      status: response.status,
      json,
      text,
      contentLength,
      hasNext: LINK_NEXT.test(response.headers.get("link") ?? ""),
      plan,
    };
  }
}

function contentLengthOf(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function graphqlRequest(
  context: RequestContext,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<{ data: unknown; planned: PlannedRequest }> {
  const response = await request(context, {
    method: "POST",
    path: "/graphql",
    body: { query, variables },
    read: query === REVIEW_THREADS_QUERY,
  });

  const payload = asRecord(response.json);
  if (payload === null) {
    throw new GitHubError(
      "GitHub GraphQL response was not an object",
      response.status,
    );
  }

  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asRecord(errors[0]);
    const message =
      first === null ? "unknown error" : (asString(first.message) ?? "unknown error");
    throw new GitHubError(
      capError(`GitHub GraphQL error: ${message}`, context.token),
      response.status,
    );
  }

  return { data: payload.data, planned: response.plan };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string | number>>,
): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** 5xx retries are safe only when repeating the request cannot double-write. */
function isIdempotentMethod(method: HttpMethod): boolean {
  return method === "GET" || method === "PATCH";
}

function isRetryableStatus(
  idempotent: boolean,
  status: number,
  hasRetryAfter: boolean,
): boolean {
  // A rejected 403/429 with Retry-After happened before processing, so even a
  // POST is safe to repeat.
  if ((status === 403 || status === 429) && hasRetryAfter) {
    return true;
  }
  return (
    idempotent &&
    (status === 502 || status === 503 || status === 504)
  );
}

/**
 * The wait the server asked for. No clamping: callers must throw when this is
 * above MAX_RETRY_WAIT_MS rather than retrying early. Invalid headers fall
 * back to a short exponential backoff.
 */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? Math.round(seconds * 1000) : 0;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  // 5xx or timeout without a Retry-After header: a short, bounded backoff.
  return 500 * 2 ** attempt;
}

/** Last-resort token scrub plus a hard 200-character cap. */
function capError(text: string, token: string): string {
  return redact(oneLine(text, MAX_ERROR_CHARS * 4), token).slice(
    0,
    MAX_ERROR_CHARS,
  );
}

/**
 * The single redaction primitive. Exported so its exact-token, URL-encoded and
 * `gh*_` layers can each be tested on their own. An empty secret leaves only
 * the `gh*_` regex layer, which is why every production caller passes the
 * options token.
 */
export function redact(text: string, secret: string): string {
  let result = text;
  for (const variant of secretVariants(secret)) {
    result = result.split(variant).join("[redacted]");
  }
  result = result.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted]");
  result = result.replace(/github[._]pat_[A-Za-z0-9_]+/g, "[redacted]");
  return result;
}

function secretVariants(secret: string): readonly string[] {
  if (secret === "") {
    return [];
  }

  const encoded = encodeURIComponent(secret);
  const variants = new Set<string>([secret, encoded]);
  if (encoded !== secret) {
    variants.add(
      encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
    );
  }
  return [...variants].filter((variant) => variant !== "");
}

/**
 * At most 200 chars of a structured GitHub `message`, never a raw body.
 * Exported so its redaction layer is tested directly rather than through the
 * outer cap that would otherwise mask it.
 */
export function errorDetail(body: string, token: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const record = asRecord(parsed);
    const message = record === null ? null : asString(record.message);
    if (message !== null && message.trim() !== "") {
      return `: ${redact(oneLine(message, MAX_ERROR_CHARS), token)}`;
    }
  } catch {
    // A non-JSON error body is intentionally not echoed.
  }
  return "";
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error: unknown, token: string): string {
  return capError(errorMessage(error), token);
}

function logger(options: GitHubOptions): (line: string) => void {
  return options.log ?? ((line: string) => console.error(line));
}

// --- response parsing -----------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function appIdOf(value: unknown): number | null {
  const app = asRecord(value);
  return app === null ? null : positiveInteger(app.id);
}

function positiveInteger(value: unknown): number | null {
  const number = asNumber(value);
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? number
    : null;
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (record === null) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function isCategory(value: string): value is Category {
  return (
    value === "bug" ||
    value === "security" ||
    value === "edge-case" ||
    value === "data" ||
    value === "root-cause"
  );
}

function blankToNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

/**
 * The bot must be a GitHub App bot account, not merely a login that matches.
 * REST exposes it as `type: "Bot"`, GraphQL as `author.__typename: "Bot"`.
 */
function isBotAuthor(
  author: Record<string, unknown> | null,
  botLogin: string,
  source: "rest" | "graphql",
): boolean {
  if (author === null) {
    return false;
  }
  if (source === "rest" ? author.type !== "Bot" : author.__typename !== "Bot") {
    return false;
  }

  const login = blankToNull(asString(author.login));
  if (login === null) {
    return false;
  }

  return normalizeLogin(login) === normalizeLogin(botLogin);
}

/** An empty or whitespace `botLogin` means "use the default". */
function botLoginOf(botLogin: string | undefined): string {
  const trimmed = botLogin?.trim() ?? "";
  return trimmed === "" ? DEFAULT_BOT_LOGIN : trimmed;
}

export function normalizeLogin(login: string): string {
  const withoutSuffix = login.replace(/\[bot\]$/i, "");
  return withoutSuffix.trim().toLowerCase();
}

/**
 * A reply declines a finding when the keyword opens the reply (after
 * whitespace and @mentions) or the whole reply is short. A quoted first line
 * is not the author's own words, and `you can't skip this` is negated.
 */
function isSkipReply(body: string): boolean {
  const text = body.trim();
  if (text === "" || text.startsWith(">")) {
    return false;
  }

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const withoutMentions = firstLine.replace(MENTION_PREFIX, "").trimStart();
  if (SKIP_AT_START.test(withoutMentions)) {
    return true;
  }

  return (
    text.length <= SHORT_REPLY_CHARS &&
    SKIP_ANYWHERE.test(text) &&
    !NEGATED_SKIP.test(text)
  );
}

/**
 * The thread query asks for `comments(first: 100)`. A page that is not the
 * last one means replies were dropped, so fail loudly instead of guessing.
 */
function threadCommentsHaveNextPage(value: unknown): boolean {
  const node = asRecord(value);
  const comments = node === null ? null : asRecord(node.comments);
  const pageInfo = comments === null ? null : asRecord(comments.pageInfo);
  return pageInfo !== null && pageInfo.hasNextPage === true;
}

function parseThreadNode(value: unknown, botLogin: string): BugbotThread | null {
  const node = asRecord(value);
  if (node === null) {
    return null;
  }

  const comments = asRecord(node.comments);
  const nodes = comments === null ? [] : asArray(comments.nodes);
  const first = asRecord(nodes[0]);
  if (first === null) {
    return null;
  }
  if (!isBotAuthor(asRecord(first.author), botLogin, "graphql")) {
    return null;
  }

  const body = asString(first.body) ?? "";
  const marker = parseMarker(body);
  if (marker === null) {
    return null;
  }

  const threadId = asString(node.id);
  const firstCommentId = positiveInteger(first.databaseId);
  if (threadId === null || threadId === "" || firstCommentId === null) {
    return null;
  }

  const replies = nodes
    .slice(1)
    .map((reply) => asRecord(reply))
    .filter((reply): reply is Record<string, unknown> => reply !== null);
  const skipped = replies.some(
    (reply) =>
      !isBotAuthor(asRecord(reply.author), botLogin, "graphql") &&
      isSkipReply(asString(reply.body) ?? ""),
  );
  const hasFixedReply = replies.some((reply) => {
    if (!isBotAuthor(asRecord(reply.author), botLogin, "graphql")) {
      return false;
    }
    const text = (asString(reply.body) ?? "").trimStart();
    return (
      text.startsWith("Fixed in ") || text.startsWith("Looks fixed as of ")
    );
  });

  const isResolved = node.isResolved === true;
  const parsed = parseThreadBody(body);
  const sideValue = asString(node.diffSide);
  const side: DiffSide | null =
    sideValue === "RIGHT" || sideValue === "LEFT" ? sideValue : null;

  return {
    threadId,
    firstCommentId,
    path: asString(node.path) ?? "",
    line: positiveInteger(node.line),
    originalLine: positiveInteger(node.originalLine),
    side,
    isResolved,
    marker,
    category: parsed.category,
    reason: parsed.reason,
    state: isResolved ? "resolved" : skipped ? "skipped" : "open",
    hasFixedReply,
    diffHunk: asString(first.diffHunk),
  };
}

function inlineComment(
  comment: PlannedComment,
  options: GitHubOptions,
): Record<string, unknown> {
  const end = comment.endLine ?? comment.line;
  const item: Record<string, unknown> = {
    path: comment.file,
    body: formatComment(comment, options.runId, options.headSha),
    side: comment.side,
    line: end > comment.line ? end : comment.line,
  };

  if (end > comment.line) {
    item.start_line = comment.line;
    item.start_side = comment.side;
  }

  return item;
}

// --- boundary validation --------------------------------------------------

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `.` and `..` are path segments, not repository names. */
function isDotOnly(value: string): boolean {
  return value !== "" && /^\.+$/.test(value);
}

function validateRepository(repository: string): void {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("invalid repository: expected owner/name");
  }
  const slash = repository.indexOf("/");
  const owner = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  if (isDotOnly(owner) || isDotOnly(name)) {
    throw new Error("invalid repository: expected owner/name");
  }
}

function validatePrNumber(prNumber: number): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("invalid prNumber: expected a positive safe integer");
  }
}

function validateRunId(runId: string): void {
  if (!/^\d+$/.test(runId)) {
    throw new Error("invalid runId: expected digits only");
  }
}

function validateHeadSha(sha: string, name = "headSha"): void {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(
      `invalid ${name}: expected 40 lowercase hexadecimal characters`,
    );
  }
}

function validateOptions(options: GitHubOptions): void {
  validateRepository(options.repository);
  validatePrNumber(options.prNumber);
  validateRunId(options.runId);
  validateHeadSha(options.headSha);
}

function splitRepository(repository: string): [string, string] {
  const slash = repository.indexOf("/");
  return [repository.slice(0, slash), repository.slice(slash + 1)];
}

function repoPath(repository: string, suffix: string): string {
  return `/repos/${repository}/${suffix}`;
}

function pullPath(
  repository: string,
  prNumber: number,
  suffix?: string,
): string {
  const base = repoPath(repository, `pulls/${prNumber}`);
  return suffix === undefined ? base : `${base}/${suffix}`;
}

function comparePath(
  repository: string,
  baseSha: string,
  headSha: string,
): string {
  return repoPath(repository, `compare/${baseSha}...${headSha}`);
}

/**
 * Builds a contents path. Every segment is encoded on its own, so `/` stays a
 * separator while spaces, `?`, `#` and a literal `%2F` in a file name become
 * inert. The guard re-checks the result before any fetch.
 */
function contentsPath(repository: string, path: string): string {
  if (path === "" || path.startsWith("/") || path.includes("\u0000")) {
    throw new Error(`refusing to read unsafe path: ${safeDisplay(path)}`);
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`refusing to read unsafe path: ${safeDisplay(path)}`);
    }
  }

  return repoPath(
    repository,
    `contents/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
  );
}
