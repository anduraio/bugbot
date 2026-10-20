/**
 * Context assembly: diff, changed files, AGENTS.md and the token budget.
 * Step 2 ships only the typed surface; step 4 implements it.
 */

export interface ReviewRequest {
  /** "owner/name". */
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  /** Unified diff for this pass: the full PR, or before..after on synchronize. */
  diff: string;
  /** Paths changed in this pass. */
  changedFiles: readonly string[];
  /** AGENTS.md from the PR head, else the default branch. */
  agentsMd: string;
  /** Input token budget, estimated at about 4 characters per token. */
  maxTokens: number;
}

export interface ContextFile {
  path: string;
  content: string;
  /** True when only +/-80 lines around each hunk were kept. */
  truncatedToHunks: boolean;
}

export interface ReviewContext {
  diff: string;
  files: readonly ContextFile[];
  agentsMd: string;
  estimatedTokens: number;
  /** Files left out entirely, for the summary. */
  skipped: readonly string[];
  /** Files reduced to hunks, for the summary. */
  truncated: readonly string[];
}

export async function buildContext(_request: ReviewRequest): Promise<ReviewContext> {
  throw new Error("buildContext is not implemented yet (bugbot step 4)");
}

export function applyTokenBudget(_context: ReviewContext, _maxTokens: number): ReviewContext {
  throw new Error("applyTokenBudget is not implemented yet (bugbot step 4)");
}
