import type { ReviewContext } from "./context.js";

/**
 * Prompt assembly: vendored prompts/ texts plus the review context.
 * Step 2 ships only the typed surface; step 4 implements it.
 */

export interface PromptOptions {
  /** Enable the optional comment-sicko second pass. Off by default. */
  commentSicko?: boolean;
}

export interface PromptBundle {
  system: string;
  user: string;
}

export async function buildPrompt(
  _context: ReviewContext,
  _options: PromptOptions = {},
): Promise<PromptBundle> {
  throw new Error("buildPrompt is not implemented yet (bugbot step 4)");
}
