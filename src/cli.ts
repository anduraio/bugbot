#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { readFile as readTextFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchPullRequest, reportSkipped, type GitHubOptions } from "./github.js";
import { pullRequestFromEvent, shouldReview } from "./gate.js";
import {
  buildContext,
  selectModel,
  type ReadFile,
  type ReviewRequest,
} from "./context.js";
import { buildPrompt, loadSystemPrompt } from "./prompt.js";
import {
  BugbotModelError,
  callModel,
  parseJsonResponse,
  type DroppedFindings,
  type FetchLike,
} from "./model.js";
import type { Finding } from "./filter.js";

/**
 * `bugbot review|status` (spec section 8). The non-local review path still
 * runs the draft/fork gate and stops before posting; step 6 wires GitHub
 * output. `review --local` builds a context from a diff file, sends it to
 * OpenRouter and prints findings only. Nothing here posts anywhere.
 */

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print a neutral line and mirror it to the job summary when one exists. */
function report(line: string): void {
  console.log(line);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === "") {
    return;
  }

  try {
    appendFileSync(summaryPath, `${line}\n`);
  } catch {
    // The job summary is best effort; never fail the PR over it.
  }
}

export interface LocalReviewOptions {
  /** Path to the unified diff file. */
  diffPath: string;
  /** Root for post-change files and AGENTS.md. Defaults to the cwd. */
  repoDir?: string;
  title?: string;
  body?: string;
  /** Input token budget. Default 120000. */
  maxTokens?: number;
  /** Print prompt sizes and make no model call. */
  printPrompt?: boolean;
  model?: string;
  bigPrModel?: string;
  commentSicko?: boolean;
}

export interface LocalReviewDeps {
  /** Injectable fetch. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Reads a repo-relative path; null when absent. */
  readFile?: ReadFile;
  /** Reads the diff file itself. */
  readDiff?: (path: string) => Promise<string>;
  /** Environment lookup, defaulting to process.env. */
  env?: (name: string) => string;
  log?: (line: string) => void;
}

export interface LocalReviewResult {
  exitCode: number;
  model: string;
  findings: readonly Finding[];
  dropped: DroppedFindings;
  tokensIn: number;
  tokensOut: number;
  estimatedTokens: number;
  skipped: readonly string[];
  truncated: readonly string[];
  overBudget: boolean;
}

const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";
const DEFAULT_MAX_TOKENS = 120_000;

function emptyDropped(): DroppedFindings {
  return { count: 0, reasons: [] };
}

/** True only for a real `..` path segment; `..foo` is a normal file name. */
function hasParentSegment(value: string): boolean {
  const segments =
    process.platform === "win32" ? value.split(/[\\/]/) : value.split("/");
  return segments.includes("..");
}

/**
 * Reads only paths named in the diff, resolving them under repoDir. Absolute
 * paths and paths with a real `..` segment are refused; `..foo` and
 * `..cache/x` are ordinary names inside the repo. Backslashes are not
 * separators on Unix and stay part of the file name. A target whose realpath
 * leaves the repo dir, including through a symlinked file or directory, is
 * refused too, so a checkout cannot expose host files.
 *
 * The realpath check and the read are not atomic (TOCTOU): a writer that can
 * replace a parent directory between the two calls could redirect the read.
 * A review checkout is static for the run, so that is accepted; if the tree
 * can change concurrently, open with O_NOFOLLOW/openat semantics or read from
 * a controlled copy instead.
 */
function repoReader(repoDir: string): ReadFile {
  const root = resolve(repoDir);
  let rootReal: Promise<string> | null = null;
  const realRoot = (): Promise<string> => {
    rootReal ??= realpath(root);
    return rootReal;
  };

  return async (path: string): Promise<string | null> => {
    if (path.trim() === "" || isAbsolute(path) || hasParentSegment(path)) {
      throw new Error(`refusing to read unsafe path: ${path}`);
    }

    const absolute = resolve(root, path);
    const lexical = relative(root, absolute);
    if (lexical === "" || hasParentSegment(lexical) || isAbsolute(lexical)) {
      throw new Error(`refusing to read unsafe path: ${path}`);
    }

    let base: string;
    let target: string;
    try {
      [base, target] = await Promise.all([realRoot(), realpath(absolute)]);
    } catch {
      // Missing repo dir, missing file or a broken symlink: nothing to read.
      return null;
    }

    const inside = relative(base, target);
    if (inside === "" || hasParentSegment(inside) || isAbsolute(inside)) {
      throw new Error(`refusing to read path outside the repo dir: ${path}`);
    }

    try {
      return await readTextFile(target, "utf8");
    } catch {
      return null;
    }
  };
}

function nextValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function parseLocalArgs(args: readonly string[]): LocalReviewOptions {
  let diffPath = "";
  let repoDir = "";
  let title = "";
  let body = "";
  let maxTokens: number | undefined;
  let printPrompt = false;
  let model = "";
  let bigPrModel = "";
  let commentSicko = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    switch (arg) {
      case "--local":
        break;
      case "--print-prompt":
        printPrompt = true;
        break;
      case "--diff":
        diffPath = nextValue(args, index, "--diff");
        index += 1;
        break;
      case "--repo-dir":
        repoDir = nextValue(args, index, "--repo-dir");
        index += 1;
        break;
      case "--title":
        title = nextValue(args, index, "--title");
        index += 1;
        break;
      case "--body":
        body = nextValue(args, index, "--body");
        index += 1;
        break;
      case "--max-tokens": {
        const raw = nextValue(args, index, "--max-tokens");
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("--max-tokens must be a positive integer");
        }
        maxTokens = parsed;
        index += 1;
        break;
      }
      case "--comment-sicko":
        commentSicko = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (diffPath === "") {
    throw new Error("--diff <file> is required with --local");
  }

  return {
    diffPath,
    repoDir: repoDir === "" ? process.cwd() : repoDir,
    title,
    body,
    maxTokens,
    printPrompt,
    model,
    bigPrModel,
    commentSicko,
  };
}

function skippedLine(paths: readonly string[]): string {
  return paths.length === 0 ? "(none)" : paths.join(", ");
}

/**
 * The whole `--local` pipeline: diff -> context -> prompt -> OpenRouter ->
 * validated findings. Every dependency is injectable so a test can run this
 * end to end with a fake fetch and reader. Errors become a neutral message and
 * exit code 0, matching the rest of the CLI.
 */
export async function runLocalReview(
  options: LocalReviewOptions,
  deps: LocalReviewDeps = {},
): Promise<LocalReviewResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const readEnv = deps.env ?? env;
  const model =
    options.model?.trim() || readEnv("BUGBOT_MODEL").trim() || DEFAULT_MODEL;
  const bigPrModel =
    options.bigPrModel?.trim() ||
    readEnv("BUGBOT_BIG_PR_MODEL").trim() ||
    undefined;
  const commentSicko =
    options.commentSicko ?? readEnv("BUGBOT_COMMENT_SICKO") === "true";

  const empty: LocalReviewResult = {
    exitCode: 0,
    model,
    findings: [],
    dropped: emptyDropped(),
    tokensIn: 0,
    tokensOut: 0,
    estimatedTokens: 0,
    skipped: [],
    truncated: [],
    overBudget: false,
  };

  try {
    const readDiff =
      deps.readDiff ?? ((path: string) => readTextFile(path, "utf8"));
    const diff = await readDiff(options.diffPath);
    const readFile = deps.readFile ?? repoReader(options.repoDir ?? process.cwd());

    let agentsMd = "";
    try {
      agentsMd = (await readFile("AGENTS.md")) ?? "";
    } catch {
      agentsMd = "";
    }

    const systemPromptChars = (await loadSystemPrompt({ commentSicko })).length;
    const request: ReviewRequest = {
      repository: "local/local",
      prNumber: 0,
      headSha: "",
      baseSha: "",
      diff,
      changedFiles: [],
      agentsMd,
      title: options.title ?? "",
      body: options.body ?? "",
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    };

    const context = await buildContext(request, readFile, {
      systemPromptChars,
    });
    const prompt = await buildPrompt(context, { commentSicko });

    if (options.printPrompt === true) {
      log(`Estimated tokens: ${prompt.estimatedTokens}`);
      log(`Skipped files: ${skippedLine(context.skipped)}`);
      log(`Truncated files: ${skippedLine(context.truncated)}`);
      log(`System prompt: ${prompt.system.length} chars`);
      log(`User message: ${prompt.user.length} chars`);

      return {
        ...empty,
        estimatedTokens: prompt.estimatedTokens,
        skipped: context.skipped,
        truncated: context.truncated,
        overBudget: context.overBudget,
      };
    }

    const selection = selectModel({
      model,
      bigPrModel,
      changedLines: context.totalChangedLines,
      overBudget: context.overBudget,
    });

    if ("skip" in selection) {
      log(`Bugbot couldn't review: ${selection.skip}`);
      return {
        ...empty,
        estimatedTokens: prompt.estimatedTokens,
        skipped: context.skipped,
        truncated: context.truncated,
        overBudget: context.overBudget,
      };
    }

    const apiKey = readEnv("OPENROUTER_API_KEY");
    if (apiKey === "") {
      throw new BugbotModelError("OPENROUTER_API_KEY is not set");
    }

    const result = await callModel(
      { model: selection.model, system: prompt.system, user: prompt.user },
      { apiKey, fetch: deps.fetch },
    );
    const parsed = parseJsonResponse(result.raw);

    log(
      JSON.stringify(
        {
          findings: parsed.findings,
          dropped: parsed.dropped.count,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
        },
        null,
        2,
      ),
    );

    return {
      exitCode: 0,
      model: selection.model,
      findings: parsed.findings,
      dropped: parsed.dropped,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      estimatedTokens: prompt.estimatedTokens,
      skipped: context.skipped,
      truncated: context.truncated,
      overBudget: context.overBudget,
    };
  } catch (error) {
    log(`Bugbot couldn't review: ${errorMessage(error)}`);
    return empty;
  }
}

export async function review(args: readonly string[] = []): Promise<number> {
  if (args.includes("--local")) {
    // Local output goes to stdout only: it must never land in a GitHub job
    // summary, even when GITHUB_STEP_SUMMARY happens to be set.
    try {
      const options = parseLocalArgs(args);
      const result = await runLocalReview(options);
      return result.exitCode;
    } catch (error) {
      console.log(`Bugbot couldn't review: ${errorMessage(error)}`);
      return 0;
    }
  }

  const repository = env("BUGBOT_REPOSITORY");
  const prNumber = Number.parseInt(env("BUGBOT_PR_NUMBER"), 10);
  const runId = env("BUGBOT_RUN_ID");
  const token = env("GITHUB_TOKEN");
  const draftLabel = env("BUGBOT_DRAFT_LABEL") || "bugbot";
  const eventHeadSha = env("BUGBOT_HEAD_SHA");

  if (repository === "" || !Number.isInteger(prNumber) || prNumber <= 0) {
    report(
      "Bugbot couldn't review: BUGBOT_REPOSITORY and BUGBOT_PR_NUMBER are required.",
    );
    return 0;
  }

  try {
    // A pull_request event carries draft, fork and labels, so the CLI applies
    // the same gate from that payload without an API call. Only when the event
    // has no PR data (workflow_dispatch, or a direct action.yml call) does it
    // fetch the PR from the API.
    const pr =
      pullRequestFromEvent({
        draft: env("BUGBOT_PR_DRAFT"),
        fork: env("BUGBOT_PR_FORK"),
        labels: env("BUGBOT_PR_LABELS"),
        headSha: eventHeadSha,
        number: prNumber,
      }) ?? (await fetchPullRequest({ token, repository, prNumber }));

    const gate = shouldReview(pr, { label: draftLabel });
    if (!gate.review) {
      report(gate.summary);
      const options: GitHubOptions = {
        token,
        repository,
        prNumber,
        headSha: pr.headSha,
        runId,
      };

      try {
        await reportSkipped(options, gate.summary);
      } catch {
        // Step 6 turns this into a completed neutral `bugbot` check run; the
        // job summary in review.yml is the visible result until then.
      }

      return 0;
    }

    report(
      "Bugbot couldn't review: step 2 skeleton, the review pipeline is not implemented.",
    );
    return 0;
  } catch (error) {
    report(`Bugbot couldn't review: ${errorMessage(error)}`);
    return 0;
  }
}

export async function status(_args: readonly string[] = []): Promise<number> {
  console.log("Bugbot status: step 2 skeleton, status is not implemented.");
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case "review":
      return review(args);
    case "status":
      return status(args);
    default:
      console.error(
        "usage: bugbot review [<pr-url|number>] [--local] | bugbot status <pr-url|number>",
      );
      return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
