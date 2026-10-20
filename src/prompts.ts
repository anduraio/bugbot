/**
 * The pstack texts vendored under prompts/, relative to the repository root.
 * Step 4 assembles these into the review prompt; nothing reads them yet.
 *
 * Keep this list in step with the `files` array in scripts/sync-prompts.sh.
 * test/prompts.test.ts fails when this list, the files on disk and the table
 * in prompts/README.md disagree.
 */
export const PROMPT_FILES = [
  "prompts/interrogate/SKILL.md",
  "prompts/interrogate/references/reviewer-prompt.md",
  "prompts/interrogate/references/rubric.md",
  "prompts/interrogate/references/code-quality-review.md",
  "prompts/interrogate/references/lead-judgment.md",
  "prompts/blast-radius/SKILL.md",
  "prompts/bugbot-triage.md",
  "prompts/comment-sicko.md",
  "prompts/typescript-best-practices/SKILL.md",
  "prompts/typescript-best-practices/references/patterns.md",
  "prompts/principle-fix-root-causes/SKILL.md",
  "prompts/principle-test-behavior-not-implementation/SKILL.md",
] as const;

export type PromptFile = (typeof PROMPT_FILES)[number];
