import type { Finding } from "./filter.js";
import type { PullRequestState } from "./gate.js";

/**
 * GitHub output: inline comments, the summary comment, the `bugbot` check run
 * and reply/resolve for fixed threads. Step 2 ships only the typed surface;
 * step 6 implements it. Nothing here may approve, request changes or merge.
 */

export interface PullRequestQuery {
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
  _options: PullRequestQuery,
): Promise<PullRequestState> {
  throw new Error("fetchPullRequest is not implemented yet (bugbot step 6)");
}

export interface GitHubOptions {
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
}

/** A neutral check never fails the PR. Bugbot has no failure conclusion. */
export type CheckConclusion = "neutral" | "success";

/**
 * Records the completed neutral `bugbot` check and summary for a draft or
 * fork PR Bugbot chose not to review. Step 6 implements it; until then the
 * job summary written in review.yml is the visible result.
 */
export async function reportSkipped(
  _options: GitHubOptions,
  _summary: string,
): Promise<void> {
  throw new Error("reportSkipped is not implemented yet (bugbot step 6)");
}

export interface ExistingBugbotComment {
  id: number;
  hash: string;
  resolved: boolean;
}

export interface ReviewSummary {
  passCount: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  posted: number;
  skipped: number;
  resolved: number;
  truncated: readonly string[];
  /** Always ends with: Bugbot only comments; it never approves or blocks. */
  note: string;
}

export async function startCheck(_options: GitHubOptions): Promise<CheckRunHandle> {
  throw new Error("startCheck is not implemented yet (bugbot step 6)");
}

export async function finishCheck(
  _options: GitHubOptions,
  _check: CheckRunHandle,
  _conclusion: CheckConclusion,
  _summary: string,
): Promise<void> {
  throw new Error("finishCheck is not implemented yet (bugbot step 6)");
}

/** Reads Bugbot's existing comments, including resolved ones, for dedupe. */
export async function listExistingBugbotComments(
  _options: GitHubOptions,
): Promise<readonly ExistingBugbotComment[]> {
  throw new Error("listExistingBugbotComments is not implemented yet (bugbot step 6)");
}

/** Posts one review with event COMMENT, never APPROVE or REQUEST_CHANGES. */
export async function postReview(
  _options: GitHubOptions,
  _findings: readonly Finding[],
): Promise<void> {
  throw new Error("postReview is not implemented yet (bugbot step 6)");
}

/** Creates or edits the single summary comment, marked <!-- bugbot:summary -->. */
export async function upsertSummary(
  _options: GitHubOptions,
  _summary: ReviewSummary,
): Promise<void> {
  throw new Error("upsertSummary is not implemented yet (bugbot step 6)");
}

/** Replies "Fixed in <sha>" and resolves Bugbot's own review threads. */
export async function resolveFixedThreads(
  _options: GitHubOptions,
  _hashes: readonly string[],
  _fixedSha: string,
): Promise<void> {
  throw new Error("resolveFixedThreads is not implemented yet (bugbot step 6)");
}
