#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { readFile as readTextFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareCommitStatus,
  fetchCompareDiff,
  fetchPullRequestDetails,
  fetchPullRequestDiff,
  findSummary,
  finishCheck,
  listBugbotThreads,
  listCheckRuns,
  postReview,
  readRepositoryFile,
  redact,
  reportSkipped,
  resolveFixedThreads,
  safeDisplay,
  startCheck,
  upsertSummary,
  type CheckRunHandle,
  type CheckRunInfo,
  type GitHubOptions,
  type PlannedRequest,
  type ReviewSummary,
  type SkippedCounts,
  type SummaryComment,
} from "./github.js";
import { pullRequestFromEvent, shouldReview } from "./gate.js";
import {
  buildContext,
  changedLinesFromDiff,
  diffLineTexts,
  hunkContextsFromDiff,
  parseDiff,
  selectModel,
  type ReadFile,
  type ReviewContext,
  type ReviewRequest,
} from "./context.js";
import { buildPrompt, loadSystemPrompt } from "./prompt.js";
import {
  BugbotModelError,
  callModel,
  parseJsonResponse,
  type DroppedFindings,
  type FetchLike,
  type Sleep,
} from "./model.js";
import {
  RECHECK_SYSTEM_PROMPT,
  buildRecheckUser,
  fixedThreadIds,
  parseRecheckResponse,
} from "./recheck.js";
import {
  classifyFindings,
  minConfidenceFromEnv,
  FindingSchema,
  type ClassifySummary,
  type DiffSide,
  type ExistingFinding,
  type Finding,
  type PlannedComment,
  type ScopeLines,
} from "./filter.js";

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
  /** Comments that would be posted, in cap order. */
  planned: readonly PlannedComment[];
  /** Counts for everything that will not become an inline comment. */
  summary: ClassifySummary;
  /** Cross-pass dedupe input; always empty for `--local`. */
  existing: readonly ExistingFinding[];
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

function emptySummary(): ClassifySummary {
  return {
    posted: 0,
    belowConfidence: 0,
    lowSeverity: 0,
    notInDiff: 0,
    triageDismissed: 0,
    duplicate: 0,
    overCap: 0,
    outOfScope: 0,
    schemaInvalid: 0,
  };
}

interface SymbolContent {
  content: string;
  /** False when this is a truncated +/-80-line context window (N10). */
  full: boolean;
}

/**
 * Reads the post-change content of every file in the diff, for the
 * deterministic symbol. The safe repo reader wins; a context file is the
 * fallback when the reader cannot see the path (for example a dropped
 * lockfile). Only paths named in the diff are ever requested.
 * LEFT symbols use the hunk context; step 6 passes the old content through `contentFor`.
 */
async function symbolContents(
  diff: string,
  context: ReviewContext,
  readFile: ReadFile,
): Promise<Map<string, SymbolContent>> {
  const byPath = new Map<string, SymbolContent>();
  const contextFiles = new Map(
    context.files.map((file) => [
      file.path,
      { content: file.content, full: !file.truncatedToHunks },
    ]),
  );

  for (const file of parseDiff(diff).files) {
    if (file.status === "deleted") {
      continue;
    }

    let content: SymbolContent | null = null;
    try {
      const text = await readFile(file.path);
      content = text === null ? null : { content: text, full: true };
    } catch {
      content = null;
    }

    content ??= contextFiles.get(file.path) ?? null;
    if (content !== null) {
      byPath.set(file.path, content);
    }
  }

  return byPath;
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
  // Deliberately undefined when the flag is absent, so BUGBOT_COMMENT_SICKO
  // in the environment still applies.
  let commentSicko: boolean | undefined;

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
 * The `--local` JSON echoes the validated findings. `categoryCoerced` is an
 * internal fail-safe flag, not part of the model contract, so it is stripped
 * from the printed output (R3-N5). The safe behaviour it drives is unchanged.
 */
function findingsForPrint(findings: readonly Finding[]): Array<Omit<Finding, "categoryCoerced">> {
  return findings.map(({ categoryCoerced: _categoryCoerced, ...rest }) => rest);
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
  // Read this one raw: minConfidenceFromEnv rejects whitespace instead of
  // trimming it, so a malformed value cannot silently lower the bar.
  const rawMinConfidence =
    deps.env === undefined
      ? process.env.BUGBOT_MIN_CONFIDENCE
      : deps.env("BUGBOT_MIN_CONFIDENCE");
  const model =
    options.model?.trim() || readEnv("BUGBOT_MODEL").trim() || DEFAULT_MODEL;
  const bigPrModel =
    options.bigPrModel?.trim() ||
    readEnv("BUGBOT_BIG_PR_MODEL").trim() ||
    undefined;
  const commentSicko =
    options.commentSicko ?? readEnv("BUGBOT_COMMENT_SICKO") === "true";
  // One resolved option object feeds the prompt-size measurement, the budget
  // context and the assembled prompt, so they cannot disagree about sicko.
  const promptOptions = { commentSicko };

  const empty: LocalReviewResult = {
    exitCode: 0,
    model,
    findings: [],
    dropped: emptyDropped(),
    planned: [],
    summary: emptySummary(),
    existing: [],
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

    const systemPromptChars = (await loadSystemPrompt(promptOptions)).length;
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
      ...promptOptions,
      systemPromptChars,
    });
    const prompt = await buildPrompt(context, promptOptions);

    if (options.printPrompt === true) {
      log(`Estimated tokens: ${context.estimatedTokens}`);
      log(`Skipped files: ${skippedLine(context.skipped)}`);
      log(`Truncated files: ${skippedLine(context.truncated)}`);
      log(`System prompt: ${prompt.system.length} chars`);
      log(`User message: ${prompt.user.length} chars`);

      return {
        ...empty,
        estimatedTokens: context.estimatedTokens,
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
          findings: findingsForPrint(parsed.findings),
          dropped: parsed.dropped.count,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
        },
        null,
        2,
      ),
    );

    // Step 6 fills `existing` from Bugbot's own comments. A local run has no
    // PR, so cross-pass dedupe starts empty.
    const existing: readonly ExistingFinding[] = [];
    const symbolContent = await symbolContents(diff, context, readFile);
    const hunkRanges = hunkContextsFromDiff(diff);
    const classified = classifyFindings(parsed.findings, {
      changedLines: changedLinesFromDiff(diff),
      minConfidence: minConfidenceFromEnv(rawMinConfidence),
      existing,
      schemaInvalid: parsed.dropped.count,
      contentFor: (file, side) =>
        side === "RIGHT" ? symbolContent.get(file)?.content : undefined,
      contentIsFullFor: (file, side) =>
        side === "RIGHT" ? (symbolContent.get(file)?.full ?? false) : false,
      hunkContextFor: (file, line, side) => {
        for (const range of hunkRanges.get(file) ?? []) {
          if (range.side === side && line >= range.start && line <= range.end) {
            return range.context;
          }
        }
        return undefined;
      },
      lineTextFor: diffLineTexts(diff),
    });

    log(`Planned comments: ${classified.post.length}`);
    for (const comment of classified.post) {
      log(
        `- ${comment.file}:${comment.line} ${comment.side} ${comment.severity} ${comment.hash.slice(0, 12)} ${comment.title}`,
      );
    }
    log(
      `Summary: posted=${classified.summary.posted} belowConfidence=${classified.summary.belowConfidence} lowSeverity=${classified.summary.lowSeverity} notInDiff=${classified.summary.notInDiff} triageDismissed=${classified.summary.triageDismissed} duplicate=${classified.summary.duplicate} overCap=${classified.summary.overCap} schemaInvalid=${classified.summary.schemaInvalid}`,
    );
    log(
      `Existing tokens: ${
        existing.length === 0
          ? "(none)"
          : existing.map((item) => item.hash).join(", ")
      }`,
    );

    return {
      exitCode: 0,
      model: selection.model,
      findings: parsed.findings,
      dropped: parsed.dropped,
      planned: classified.post,
      summary: classified.summary,
      existing,
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

export interface PrReviewOptions {
  /** "owner/name" from BUGBOT_REPOSITORY. */
  repository: string;
  /** BUGBOT_PR_NUMBER. */
  prNumber: number;
  /** BUGBOT_RUN_ID; the check run's external_id and the marker's run id. */
  runId: string;
  /** GITHUB_TOKEN, minted by the App. */
  token: string;
  /** BUGBOT_HEAD_SHA from the event. The API head is authoritative. */
  eventHeadSha?: string;
}

export interface PrReviewDeps {
  /** Injectable fetch for both GitHub and OpenRouter. */
  fetch?: FetchLike;
  /** Injectable sleep for retries and model backoff. */
  sleep?: Sleep;
  /** Environment lookup, defaulting to process.env. */
  env?: (name: string) => string;
  log?: (line: string) => void;
  /** GitHub per-attempt timeout, mainly for tests. Default 30 s. */
  timeoutMs?: number;
  /** OpenRouter per-attempt timeout, mainly for tests. Default 120 s. */
  modelTimeoutMs?: number;
}

export interface PrReviewResult {
  /** Always 0: Bugbot never fails the job. */
  exitCode: number;
  conclusion: "success" | "neutral" | "skipped" | "none";
  error?: string;
}

/** Collapses whitespace, removes every known secret, and caps the length. */
function capReason(text: string, secrets: readonly string[]): string {
  let value = text.replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret !== "") {
      value = redact(value, secret);
    }
  }
  return value.slice(0, 200);
}

function parsePositiveEnv(raw: string, fallback: number): number {
  return /^[1-9][0-9]*$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
}

/** Digits-only run ids, deduplicated, oldest first. */
function uniqueRuns(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const runs: string[] = [];
  for (const value of values) {
    if (/^\d+$/.test(value) && !seen.has(value)) {
      seen.add(value);
      runs.push(value);
    }
  }
  return runs;
}

/** Reads the last known `Open Bugbot comments` count from a summary. */
function parseOpenComments(body: string | null): number | null {
  if (body === null) {
    return null;
  }
  const match = /^- Open Bugbot comments: (\d+)$/m.exec(body);
  if (match === null) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Reads the hidden `<!-- bugbot:runs ... -->` line from a summary. */
function parseRunIds(body: string | null): string[] {
  if (body === null) {
    return [];
  }
  const match = /<!-- bugbot:runs ([^>]*) -->/.exec(body);
  if (match === null) {
    return [];
  }
  return (match[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

const SHA40 = /^[0-9a-f]{40}$/;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

interface SynchronizeRange {
  before: string;
  after: string;
}

/**
 * The before..after range for a synchronize event, or null when the event is
 * absent, another action (reopened keeps the full PR diff), malformed, or
 * names a head other than the one the API returned. GitHub exposes the event
 * payload through GITHUB_EVENT_PATH, so the workflow needs no extra input.
 */
async function synchronizeRange(
  readEnv: (name: string) => string,
  headSha: string,
): Promise<SynchronizeRange | null> {
  const path = readEnv("GITHUB_EVENT_PATH").trim();
  if (path === "") {
    return null;
  }

  try {
    const raw = await readTextFile(path, "utf8");
    if (raw.length > MAX_EVENT_BYTES) {
      return null;
    }
    const event: unknown = JSON.parse(raw);
    if (typeof event !== "object" || event === null) {
      return null;
    }
    const record = event as Record<string, unknown>;
    if (record.action !== "synchronize") {
      return null;
    }
    const before = record.before;
    const after = record.after;
    if (
      typeof before !== "string" ||
      typeof after !== "string" ||
      !SHA40.test(before) ||
      !SHA40.test(after) ||
      before === after ||
      after !== headSha
    ) {
      return null;
    }
    return { before, after };
  } catch {
    return null;
  }
}

/**
 * True when a check run's `external_id` is a run id no higher than this run's.
 * A missing or non-numeric id is not ours to complete, and a higher id is a
 * newer run that is still working.
 */
function isNotNewerRun(externalId: string | null, runId: string): boolean {
  if (externalId === null || !/^\d+$/.test(externalId)) {
    return false;
  }
  return BigInt(externalId) <= BigInt(runId);
}

function planLine(plan: PlannedRequest): string {
  const body = plan.body === undefined ? "" : ` ${JSON.stringify(plan.body)}`;
  return `Dry run plan: ${plan.method} ${plan.path}${body}`;
}

interface ReviewedBefore {
  ok: boolean;
  /** One line for the log, naming the check run and its conclusion. */
  why: string;
}

/**
 * S8D-B3: true only when this app left a successful `bugbot` check run on the
 * `before` commit. Without that, the commits in between were never reviewed
 * (a cancelled run or a failed pass) and narrowing the scope to `before..after`
 * would drop their bugs permanently. The lookup reuses the existing
 * `check_name=bugbot` route and compares the app id, so another app's check
 * never counts.
 */
async function beforeWasReviewed(
  github: GitHubOptions,
  check: CheckRunHandle | null,
  sha: string,
  reasonOf: (error: unknown) => string,
): Promise<ReviewedBefore> {
  const appId = check?.appId;
  if (appId === undefined || appId === null) {
    return {
      ok: false,
      why: "this pass's bugbot app is unknown, so its check run cannot be matched",
    };
  }

  let runs: readonly CheckRunInfo[];
  try {
    runs = await listCheckRuns(github, sha);
  } catch (caught) {
    return { ok: false, why: `could not read check runs: ${reasonOf(caught)}` };
  }

  const own = runs.filter((run) => run.appId === appId);
  if (own.length === 0) {
    return { ok: false, why: "no check run from this app on that commit" };
  }
  if (own.some((run) => run.conclusion === "success")) {
    return { ok: true, why: "the bugbot check on that commit succeeded" };
  }

  const conclusions = [
    ...new Set(
      own.map((run) => run.conclusion ?? run.status ?? "unknown"),
    ),
  ];
  return {
    ok: false,
    why: `the bugbot check did not succeed (${conclusions
      .map((value) => safeDisplay(value))
      .join(", ")})`,
  };
}

/**
 * One full non-local review pass: gate, check run, API diff and contents,
 * context, model, filter with cross-pass dedupe, one COMMENT review, re-check
 * and resolve, summary upsert, finish the check. Every failure is neutral and
 * the result is always exit code 0.
 */
export async function runPrReview(
  options: PrReviewOptions,
  deps: PrReviewDeps = {},
): Promise<PrReviewResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const readEnv = deps.env ?? env;
  const apiKey = readEnv("OPENROUTER_API_KEY");
  const secrets = [options.token, apiKey].filter((secret) => secret !== "");
  const reasonOf = (error: unknown): string =>
    capReason(errorMessage(error), secrets);

  const repository = options.repository.trim();
  const prNumber = options.prNumber;
  const runId = options.runId.trim();
  const token = options.token;

  if (repository === "" || !Number.isInteger(prNumber) || prNumber <= 0) {
    const line = "BUGBOT_REPOSITORY and BUGBOT_PR_NUMBER are required.";
    log(`Bugbot couldn't review: ${line}`);
    return { exitCode: 0, conclusion: "none", error: line };
  }

  if (token === "") {
    const line = "GITHUB_TOKEN is not set";
    log(`Bugbot couldn't review: ${line}`);
    return { exitCode: 0, conclusion: "none", error: line };
  }

  const transport = {
    fetch: deps.fetch,
    sleep: deps.sleep,
    env: deps.env,
    timeoutMs: deps.timeoutMs,
    log: (line: string) => log(line),
  };
  const dryRun = readEnv("BUGBOT_DRY_RUN") === "true";
  const model = readEnv("BUGBOT_MODEL").trim() || DEFAULT_MODEL;
  const bigPrModel = readEnv("BUGBOT_BIG_PR_MODEL").trim() || undefined;
  const maxTokens = parsePositiveEnv(
    readEnv("BUGBOT_MAX_TOKENS").trim(),
    DEFAULT_MAX_TOKENS,
  );
  // Read raw: minConfidenceFromEnv rejects whitespace instead of trimming it.
  const rawMinConfidence =
    deps.env === undefined
      ? process.env.BUGBOT_MIN_CONFIDENCE
      : deps.env("BUGBOT_MIN_CONFIDENCE");
  const commentSicko = readEnv("BUGBOT_COMMENT_SICKO") === "true";
  const draftLabel = readEnv("BUGBOT_DRAFT_LABEL") || "bugbot";

  let pr;
  try {
    pr = await fetchPullRequestDetails({
      token,
      repository,
      prNumber,
      ...transport,
    });
  } catch (error) {
    const line = reasonOf(error);
    log(`Bugbot couldn't review: ${line}`);
    return { exitCode: 0, conclusion: "none", error: line };
  }

  try {
    // The event payload is the gate; the API values above are the review. A
    // malformed labels value throws here and becomes a neutral pass.
    const gate = shouldReview(
      pullRequestFromEvent({
        draft: readEnv("BUGBOT_PR_DRAFT"),
        fork: readEnv("BUGBOT_PR_FORK"),
        labels: readEnv("BUGBOT_PR_LABELS"),
        headSha: options.eventHeadSha ?? "",
        number: prNumber,
      }) ?? pr,
      { label: draftLabel },
    );

    if (!gate.review) {
      const github: GitHubOptions = {
        token,
        repository,
        prNumber,
        headSha: pr.headSha,
        runId,
        dryRun,
        ...transport,
      };
      try {
        const planned = await reportSkipped(github, gate.summary);
        if (dryRun) {
          log(planLine(planned));
        }
      } catch (error) {
        log(`Bugbot: could not report the skip: ${reasonOf(error)}`);
      }
      log(gate.summary);
      return { exitCode: 0, conclusion: "skipped" };
    }
  } catch (error) {
    const line = reasonOf(error);
    log(`Bugbot couldn't review: ${line}`);
    return { exitCode: 0, conclusion: "none", error: line };
  }

  const eventHeadSha = (options.eventHeadSha ?? "").trim();
  if (eventHeadSha !== "" && eventHeadSha !== pr.headSha) {
    log(
      `Bugbot: BUGBOT_HEAD_SHA ${eventHeadSha} differs from the API head ${pr.headSha}; reviewing the API head`,
    );
  }

  const github: GitHubOptions = {
    token,
    repository,
    prNumber,
    headSha: pr.headSha,
    runId,
    dryRun,
    ...transport,
  };

  let check: CheckRunHandle | null = null;
  let error: string | null = null;
  try {
    check = await startCheck(github);
    if (dryRun && check.planned !== undefined) {
      log(planLine(check.planned));
    }
  } catch (caught) {
    error = reasonOf(caught);
    log(`Bugbot: could not start the check run: ${error}`);
  }

  // A cancelled or superseded run can leave an in_progress `bugbot` check on
  // this head SHA. Complete the ones this app left behind from this run id or
  // an earlier one. This pass's own check is skipped by id (R1-N1); a newer
  // run, another app's check and a completed run are never touched (R1-N2).
  // Best effort: a failure is logged and the review continues (S6B-N2).
  if (error === null && check !== null) {
    const own = check;
    if (own.appId === undefined || own.appId === null) {
      log("Bugbot: skipping stale check cleanup: the check run's app is unknown");
    } else {
      try {
        const runs = await listCheckRuns(github);
        const stale = runs.filter(
          (run) =>
            run.id !== own.id &&
            run.status === "in_progress" &&
            run.appId === own.appId &&
            isNotNewerRun(run.externalId, runId),
        );
        for (const run of stale) {
          try {
            const planned = await finishCheck(
              github,
              { id: run.id },
              "neutral",
              `Bugbot: superseded by run ${runId}.`,
            );
            if (dryRun) {
              log(planLine(planned));
            }
            log(`Bugbot: completed stale in-progress check run ${run.id}`);
          } catch (caught) {
            log(
              `Bugbot: could not complete stale check run ${run.id}: ${reasonOf(caught)}`,
            );
          }
        }
      } catch (caught) {
        log(`Bugbot: could not list stale check runs: ${reasonOf(caught)}`);
      }
    }
  }

  let posted = 0;
  let failedToPost = 0;
  let resolved = 0;
  let openThreads = 0;
  /** False until the thread list is read; the summary must not report 0 then. */
  let threadsListed = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let modelUsed = model;
  let truncated: readonly string[] = [];
  let threadRunIds: string[] = [];
  let scope: ScopeLines | undefined;
  let skippedBuckets: SkippedCounts = {};

  if (error === null) {
    try {
      const diff = await fetchPullRequestDiff({
        token,
        repository,
        prNumber,
        ...transport,
      });
      const parsedDiff = parseDiff(diff);
      if (parsedDiff.files.length === 0) {
        throw new Error("pull request diff had no files");
      }

      const changedFiles = parsedDiff.files.map((file) => file.path);
      const changedPaths = new Set(changedFiles);
      const fileStatus = new Map(
        parsedDiff.files.map((file) => [file.path, file.status]),
      );

      // Step 8c incremental review: on a synchronize push whose `before` is an
      // ancestor of `after`, only findings inside a before..after hunk may
      // post. The model still sees every changed file in full. A force-push
      // (`diverged`), a reopened PR, a stale event or any compare failure
      // keeps the full PR diff. S8D-B3: `ahead` alone is not enough; the
      // `before` commit must carry a successful check run from this app,
      // otherwise its bugs were never reviewed and narrowing would hide them
      // for good.
      const syncRange = await synchronizeRange(readEnv, pr.headSha);
      if (syncRange !== null) {
        const before = syncRange.before.slice(0, 7);
        const after = syncRange.after.slice(0, 7);
        try {
          const status = await compareCommitStatus({
            token,
            repository,
            baseSha: syncRange.before,
            headSha: syncRange.after,
            ...transport,
          });
          if (status === "ahead") {
            const reviewed = await beforeWasReviewed(
              github,
              check,
              syncRange.before,
              reasonOf,
            );
            if (reviewed.ok) {
              const compareDiff = await fetchCompareDiff({
                token,
                repository,
                baseSha: syncRange.before,
                headSha: syncRange.after,
                ...transport,
              });
              scope = hunkContextsFromDiff(compareDiff, diff);
              log(
                `Bugbot: incremental review ${before}..${after}: ${reviewed.why}`,
              );
            } else {
              log(
                `Bugbot: full review; ${before} was not reviewed: ${reviewed.why}`,
              );
            }
          } else {
            log(
              `Bugbot: full review; ${before} is not an ancestor of ${after} (${safeDisplay(status)})`,
            );
          }
        } catch (caught) {
          log(
            `Bugbot: could not read ${before}..${after}, reviewing the full PR diff: ${reasonOf(caught)}`,
          );
        }
      }

      // Right side: head content. Left side: base content. Only paths named in
      // the diff are ever requested (plus the AGENTS.md lookup below).
      //
      // A legal file name such as `back\slash.ts` encodes to `%5C`, which the
      // contents guard refuses. That skips one file, never the whole pass
      // (S6B-N4); a `..` path still throws from contentsPath and ends neutral.
      const readContents = async (
        path: string,
        ref: string,
      ): Promise<string | null> => {
        try {
          return await readRepositoryFile({
            token,
            repository,
            path,
            ref,
            ...transport,
          });
        } catch (caught) {
          if (
            caught instanceof Error &&
            caught.message === "GitHub request not allowed: unsafe contents path"
          ) {
            log(`Bugbot: skipping ${safeDisplay(path)}: ${reasonOf(caught)}`);
            return null;
          }
          throw caught;
        }
      };

      const headContents = new Map<string, string | null>();
      for (const file of parsedDiff.files) {
        if (file.status === "deleted") {
          continue;
        }
        headContents.set(
          file.path,
          await readContents(file.newPath ?? file.path, pr.headSha),
        );
      }

      const baseContents = new Map<string, string | null>();
      for (const file of parsedDiff.files) {
        const left = parsedDiff.changedLines.get(file.path)?.get("LEFT");
        if (left === undefined || left.size === 0) {
          continue;
        }
        baseContents.set(
          file.path,
          await readContents(file.oldPath ?? file.path, pr.baseSha),
        );
      }

      const readFile: ReadFile = async (path: string) =>
        headContents.get(path) ?? null;

      let agentsMd = "";
      const headAgents = await readContents("AGENTS.md", pr.headSha);
      if (headAgents !== null) {
        agentsMd = headAgents;
      } else {
        agentsMd = (await readContents("AGENTS.md", pr.baseSha)) ?? "";
      }

      const systemPromptChars = (await loadSystemPrompt({ commentSicko }))
        .length;
      const request: ReviewRequest = {
        repository,
        prNumber,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        diff,
        changedFiles,
        agentsMd,
        title: pr.title,
        body: pr.body,
        maxTokens,
      };

      const context = await buildContext(request, readFile, {
        commentSicko,
        systemPromptChars,
      });
      const prompt = await buildPrompt(context, { commentSicko });
      truncated = context.truncated;

      const selection = selectModel({
        model,
        bigPrModel,
        changedLines: context.totalChangedLines,
        overBudget: context.overBudget,
      });
      if ("skip" in selection) {
        throw new Error(selection.skip);
      }
      modelUsed = redact(selection.model, apiKey);

      if (apiKey === "") {
        throw new BugbotModelError("OPENROUTER_API_KEY is not set");
      }

      const result = await callModel(
        { model: selection.model, system: prompt.system, user: prompt.user },
        {
          apiKey,
          fetch: deps.fetch,
          sleep: deps.sleep,
          timeoutMs: deps.modelTimeoutMs,
        },
      );
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;
      modelUsed = redact(
        result.model.trim() === "" ? selection.model : result.model,
        apiKey,
      );

      const parsedResponse = parseJsonResponse(result.raw);

      const threads = await listBugbotThreads(github);
      threadsListed = true;
      threadRunIds = threads.map((thread) => thread.marker.runId);
      openThreads = threads.filter((thread) => thread.state === "open").length;
      // A missing category is mapped to "bug" so the marker hash can still
      // match; the empty symbol makes the fuzzy branch effectively hash-only.
      const existing: ExistingFinding[] = threads.map((thread) => ({
        hash: thread.marker.hash,
        file: thread.path,
        category: thread.category ?? "bug",
        symbol: "",
        reason: thread.reason,
        state: thread.state,
        line: thread.line,
        originalLine: thread.originalLine,
        side: thread.side,
      }));

      const headFor = (file: string): string | undefined =>
        headContents.get(file) ?? undefined;
      const baseFor = (file: string): string | undefined =>
        baseContents.get(file) ?? undefined;
      const contentFor = (
        file: string,
        side: DiffSide,
      ): string | undefined => (side === "RIGHT" ? headFor(file) : baseFor(file));
      const contentIsFullFor = (file: string, side: DiffSide): boolean => {
        const content =
          side === "RIGHT" ? headContents.get(file) : baseContents.get(file);
        return content !== undefined && content !== null;
      };
      const hunkRanges = hunkContextsFromDiff(diff);
      const hunkContextFor = (
        file: string,
        line: number,
        side: DiffSide,
      ): string | undefined => {
        for (const range of hunkRanges.get(file) ?? []) {
          if (range.side === side && line >= range.start && line <= range.end) {
            return range.context;
          }
        }
        return undefined;
      };
      const minConfidence = minConfidenceFromEnv(rawMinConfidence);
      const lineTextFor = diffLineTexts(diff);

      const classified = classifyFindings(parsedResponse.findings, {
        changedLines: parsedDiff.changedLines,
        minConfidence,
        existing,
        schemaInvalid: parsedResponse.dropped.count,
        scope,
        contentFor,
        contentIsFullFor,
        hunkContextFor,
        lineTextFor,
      });

      const buckets = classified.summary;
      skippedBuckets = {
        duplicate: buckets.duplicate,
        belowConfidence: buckets.belowConfidence,
        lowSeverity: buckets.lowSeverity,
        notInDiff: buckets.notInDiff,
        triageDismissed: buckets.triageDismissed,
        overCap: buckets.overCap,
        schemaInvalid: buckets.schemaInvalid,
        outOfScope: buckets.outOfScope,
      };

      if (classified.post.length > 0) {
        const intended = classified.post.length;
        try {
          const review = await postReview(github, classified.post);
          posted = review.posted;
          // Every comment that did not land is a failure, whether postReview
          // attributed it or not (S6B-B1). The summary must show the count.
          failedToPost = Math.max(review.failed.length, intended - review.posted);
          if (dryRun) {
            for (const plan of review.planned) {
              log(planLine(plan));
            }
          }
        } catch (caught) {
          // A timeout is ambiguous: it may have landed, so nothing is counted
          // as posted; the outer handler ends the pass neutral.
          failedToPost = intended;
          throw caught;
        }
      }

      // A thread whose finding the main call re-reported this pass is counted
      // as a duplicate by classifyFindings. It must not be resolved by the
      // re-check (S6B-N5b). Ask the classifier per eligible thread, with the
      // findings narrowed to that thread's file and category, so the decision
      // uses the exact hash/fuzzy logic without rescanning every file per
      // finding.
      const validFindings: Finding[] = [];
      for (const raw of parsedResponse.findings) {
        const parsed = FindingSchema.safeParse(raw);
        if (parsed.success) {
          validFindings.push(parsed.data);
        }
      }

      const reReportedHashes = new Set<string>();
      for (const thread of threads) {
        if (
          thread.state !== "open" ||
          !changedPaths.has(thread.path) ||
          thread.marker.sha === github.headSha ||
          thread.line === null
        ) {
          continue;
        }

        const category = thread.category ?? "bug";
        const candidates = validFindings.filter(
          (finding) =>
            finding.file === thread.path && finding.category === category,
        );
        if (candidates.length === 0) {
          continue;
        }

        const duplicateCheck = classifyFindings(candidates, {
          changedLines: parsedDiff.changedLines,
          minConfidence,
          existing: [
            {
              hash: thread.marker.hash,
              file: thread.path,
              category,
              symbol: "",
              reason: thread.reason,
              state: thread.state,
              line: thread.line,
              originalLine: thread.originalLine,
              side: thread.side,
            },
          ],
          contentFor,
          contentIsFullFor,
          hunkContextFor,
          lineTextFor,
        });
        // In-pass duplicates count too; that only keeps more threads open.
        if (duplicateCheck.summary.duplicate > 0) {
          reReportedHashes.add(thread.marker.hash);
        }
      }

      // Re-check open threads touched by this diff whose marker is from an
      // older commit. At most 15, oldest first by first comment id. A thread
      // with no current line is outdated and left for a later pass, and a
      // thread the main call just re-reported must stay open (S6B-N5).
      const targets = threads
        .filter(
          (thread) =>
            thread.state === "open" &&
            changedPaths.has(thread.path) &&
            thread.marker.sha !== github.headSha &&
            thread.line !== null &&
            !reReportedHashes.has(thread.marker.hash),
        )
        // Review thread ids increase with creation time; sorting by the first
        // comment id is the oldest-first order the decision asks for.
        .sort((a, b) => a.firstCommentId - b.firstCommentId)
        .slice(0, 15);

      if (targets.length > 0) {
        try {
          const known = new Set(targets.map((thread) => thread.threadId));
          const user = buildRecheckUser(
            targets.map((thread) => {
              const content = headContents.get(thread.path) ?? null;
              const deleted = fileStatus.get(thread.path) === "deleted";
              return {
                threadId: thread.threadId,
                path: thread.path,
                line: thread.line ?? 1,
                reason: thread.reason,
                status: deleted
                  ? ("deleted" as const)
                  : content === null
                    ? ("unavailable" as const)
                    : ("present" as const),
                content,
              };
            }),
            github.headSha,
          );

          const recheck = await callModel(
            { model: selection.model, system: RECHECK_SYSTEM_PROMPT, user },
            {
              apiKey,
              fetch: deps.fetch,
              sleep: deps.sleep,
              timeoutMs: deps.modelTimeoutMs,
              maxOutputTokens: 2_000,
            },
          );
          tokensIn += recheck.tokensIn;
          tokensOut += recheck.tokensOut;

          const fixed = fixedThreadIds(
            parseRecheckResponse(recheck.raw, known),
          );
          const fixedThreads = targets.filter((thread) =>
            fixed.has(thread.threadId),
          );
          if (fixedThreads.length > 0) {
            const resolvedResult = await resolveFixedThreads(
              github,
              fixedThreads,
              github.headSha,
            );
            resolved = resolvedResult.resolved;
            if (dryRun) {
              for (const plan of resolvedResult.planned) {
                log(planLine(plan));
              }
            }
          }
        } catch (caught) {
          log(
            `Bugbot: re-check failed, leaving threads open: ${reasonOf(caught)}`,
          );
        }
      }
    } catch (caught) {
      error = reasonOf(caught);
      log(`Bugbot couldn't review: ${error}`);
    }
  }

  // Pass count: this run, previous summary run ids, and run ids in bot thread
  // markers. A rerun of the same run id adds no pass. Keep the last 200 ids.
  let previous: SummaryComment | null | undefined;
  try {
    previous = await findSummary(github);
  } catch (caught) {
    if (error === null) {
      error = reasonOf(caught);
    }
    log(`Bugbot: could not read the summary: ${reasonOf(caught)}`);
  }

  const allRuns = uniqueRuns([
    ...parseRunIds(previous?.body ?? null),
    ...threadRunIds,
    runId,
  ]);
  const passCount = allRuns.length;
  const runs = allRuns.slice(-200);
  const postFailureReason =
    error === null && failedToPost > 0
      ? `${failedToPost} finding${
          failedToPost === 1 ? "" : "s"
        } could not be posted as inline comment${
          failedToPost === 1 ? "" : "s"
        }`
      : null;
  const summary: ReviewSummary = {
    passCount,
    model: modelUsed,
    tokensIn,
    tokensOut,
    posted,
    // S8D-B4: a pass that failed before listBugbotThreads must not write 0
    // over the last known count. Keep the previous summary's value, or say
    // `unknown` when there is none.
    openComments: threadsListed
      ? Math.max(0, openThreads - resolved) + posted
      : (parseOpenComments(previous?.body ?? null) ?? "unknown"),
    failed: failedToPost,
    skipped: skippedBuckets,
    resolved,
    truncated,
    ...(runs.length > 0 ? { runs } : {}),
    ...(error === null ? {} : { error }),
  };

  try {
    const result = await upsertSummary(
      github,
      summary,
      previous === undefined ? {} : { previous },
    );
    if (dryRun) {
      log(planLine(result.planned));
    }
  } catch (caught) {
    if (error === null) {
      error = `could not write the summary: ${reasonOf(caught)}`;
      summary.error = error;
    }
    log(`Bugbot: could not write the summary: ${reasonOf(caught)}`);
  }

  try {
    let handles: CheckRunHandle[] = [];
    let createFallback = false;
    if (check !== null) {
      handles = [check];
    } else {
      // The handle may be lost (a timed-out startCheck). Finish every run for
      // this run id that is still in_progress, not just the first match
      // (S6B-N2iii). A run that is already completed is left untouched.
      const found = await listCheckRuns(github);
      const matches = found.filter((run) => run.externalId === runId);
      const inProgress = matches.filter((run) => run.status === "in_progress");
      if (inProgress.length > 0) {
        handles = inProgress.map((run) => ({ id: run.id }));
      } else if (matches.length === 0) {
        log(
          "Bugbot: no existing bugbot check run found for this run id; creating a completed neutral one",
        );
        createFallback = true;
      } else {
        log(
          `Bugbot: the check run for ${runId} is already completed; leaving it untouched`,
        );
      }
    }

    const output =
      error !== null
        ? `Bugbot couldn't review: ${error}`
        : failedToPost > 0
          ? `Bugbot reviewed this pull request: ${posted} inline comment${
              posted === 1 ? "" : "s"
            }; ${failedToPost} finding${
              failedToPost === 1 ? "" : "s"
            } could not be posted.`
          : `Bugbot reviewed this pull request: ${posted} inline comment${
              posted === 1 ? "" : "s"
            }, pass ${passCount}.`;
    const conclusion =
      error !== null || postFailureReason !== null ? "neutral" : "success";

    if (handles.length > 0) {
      let finishFailure: unknown = null;
      for (const handle of handles) {
        try {
          const planned = await finishCheck(
            github,
            handle,
            conclusion,
            output,
          );
          if (dryRun) {
            log(planLine(planned));
          }
        } catch (caught) {
          finishFailure ??= caught;
        }
      }

      if (finishFailure !== null) {
        log(
          `Bugbot: could not finish the check run: ${reasonOf(finishFailure)}`,
        );
        try {
          // The PATCH is idempotent but still failed after its retries. One
          // completed neutral create keeps a check from staying in_progress.
          const planned = await reportSkipped(github, output);
          if (dryRun) {
            log(planLine(planned));
          }
          log("Bugbot: created a completed neutral check run instead");
        } catch (caught) {
          log(
            `Bugbot: could not create the fallback check run: ${reasonOf(caught)}`,
          );
        }
      }
    } else if (createFallback) {
      const planned = await reportSkipped(github, output);
      if (dryRun) {
        log(planLine(planned));
      }
    }
  } catch (caught) {
    log(`Bugbot: could not finish the check run: ${reasonOf(caught)}`);
  }

  if (error !== null) {
    log(`Bugbot couldn't review: ${error}`);
    return { exitCode: 0, conclusion: "neutral", error };
  }

  if (postFailureReason !== null) {
    log(`Bugbot: ${postFailureReason}`);
    return { exitCode: 0, conclusion: "neutral", error: postFailureReason };
  }

  log(
    `Bugbot review complete: pass ${passCount}, ${posted} inline comment${
      posted === 1 ? "" : "s"
    }, ${resolved} resolved.`,
  );
  return { exitCode: 0, conclusion: "success" };
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

  try {
    const result = await runPrReview(
      {
        repository: env("BUGBOT_REPOSITORY"),
        prNumber: Number.parseInt(env("BUGBOT_PR_NUMBER"), 10),
        runId: env("BUGBOT_RUN_ID"),
        token: env("GITHUB_TOKEN"),
        eventHeadSha: env("BUGBOT_HEAD_SHA"),
      },
      { log: report },
    );
    return result.exitCode;
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
