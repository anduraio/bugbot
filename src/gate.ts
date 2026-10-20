/**
 * Pure draft/fork gate shared by the reusable workflow's step and the CLI.
 * The workflow reads the pull_request event; the CLI reads the same fields
 * from the environment on a PR event, or from the API when the event has no
 * pull_request payload (workflow_dispatch or a direct action.yml call).
 */

export interface PullRequestGateState {
  readonly draft: boolean;
  /** True when the head repository differs from the base repository. */
  readonly fork: boolean;
  readonly labels: readonly string[];
}

export interface PullRequestState extends PullRequestGateState {
  readonly number: number;
  readonly headSha: string;
}

/** Why a PR is not reviewed. */
export type SkipReason = "draft" | "fork";

export type ReviewGate =
  | { readonly review: true }
  | {
      readonly review: false;
      readonly reason: SkipReason;
      /** Job summary line: "Bugbot skipped: draft" or "Bugbot skipped: fork". */
      readonly summary: string;
    };

/** Pull request fields the reusable workflow passes from the event payload. */
export interface EventPullRequest {
  readonly draft: string;
  readonly fork: string;
  /**
   * `toJSON(github.event.pull_request.labels.*.name)`: a JSON array of names,
   * so a label containing a comma stays one label. Empty when absent.
   */
  readonly labels: string;
  readonly headSha: string;
  readonly number: number;
}

/**
 * Parses the labels env value. The workflow passes JSON rather than a comma
 * join, so "needs, review" stays one label. An empty value, and the `null`
 * that `toJSON` produces when the PR payload is absent, both mean no labels.
 * Malformed JSON throws; the CLI turns that into a neutral failed review
 * instead of guessing which labels were intended.
 */
function parseLabels(raw: string): string[] {
  if (raw.trim() === "") {
    return [];
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((label): label is string => typeof label === "string");
}

/**
 * Builds the gate state from the workflow event env. Returns null when the
 * event carried no pull_request payload (both draft and fork are empty), which
 * is when the CLI must ask the API instead of trusting the event.
 */
export function pullRequestFromEvent(
  event: EventPullRequest,
): PullRequestState | null {
  if (event.draft === "" || event.fork === "") {
    return null;
  }

  return {
    number: event.number,
    headSha: event.headSha,
    draft: event.draft === "true",
    fork: event.fork === "true",
    labels: parseLabels(event.labels),
  };
}

/**
 * Fork PRs are skipped because reusable-workflow secrets are not available to
 * them. Draft PRs are skipped unless the configured label opts them in. Label
 * comparison ignores case, matching `contains()` in the workflow gate.
 */
export function shouldReview(
  pr: PullRequestGateState,
  options: { readonly label: string },
): ReviewGate {
  if (pr.fork) {
    return { review: false, reason: "fork", summary: "Bugbot skipped: fork" };
  }

  const label = options.label.toLowerCase();
  const labelled = pr.labels.some((candidate) => candidate.toLowerCase() === label);

  if (pr.draft && !labelled) {
    return { review: false, reason: "draft", summary: "Bugbot skipped: draft" };
  }

  return { review: true };
}
