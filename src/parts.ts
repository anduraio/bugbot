import { planChunks } from "./chunk.js";
import {
  buildContext,
  selectModel,
  type ReadFile,
  type ReviewContext,
  type ReviewRequest,
} from "./context.js";
import type { Finding } from "./filter.js";
import {
  BugbotModelError,
  callModel,
  parseJsonResponse,
  type DroppedFindings,
  type ModelAttempt,
  type ModelOptions,
} from "./model.js";
import { buildPrompt, type PromptBundle, type PromptOptions } from "./prompt.js";

/**
 * Big pull requests are reviewed in parts: the diff is split into groups of
 * files (see chunk.ts), each part gets its own context and model request, and
 * the findings are merged. A small pull request is one part and is sent
 * as one request, within the same per-part input budget.
 */

/** Default input budget for one part's request, system prompt included. */
export const DEFAULT_PART_TOKENS = 50_000;
/** Changed lines per part, below the 1500-line big-PR gate. */
export const MAX_PART_CHANGED_LINES = 1_000;
/** Parts reviewed at the same time. */
export const PART_CONCURRENCY = 3;
/** The smallest diff share a part plans for, so a huge prompt cannot reach 0. */
const MIN_PART_DIFF_TOKENS = 2_000;

export interface PlannedPart {
  /** 1-based. */
  index: number;
  total: number;
  /** Paths whose diff is in this part. */
  files: readonly string[];
  context: ReviewContext;
  prompt: PromptBundle;
}

export interface PlanPartsInput {
  /** The whole PR. `maxTokens` caps the part budget. */
  request: ReviewRequest;
  readFile: ReadFile;
  promptOptions: PromptOptions;
  systemPromptChars: number;
  /** Input budget per part when the PR is split. */
  partTokens?: number;
}

/**
 * Plans the parts. The diff share of a part is half of what the part budget
 * leaves after the system prompt; the other half is for file contents, which
 * `buildContext` reduces or drops to fit as usual.
 */
export async function planParts(input: PlanPartsInput): Promise<PlannedPart[]> {
  const { request, readFile, promptOptions, systemPromptChars } = input;
  const partBudget = Math.min(
    input.partTokens ?? DEFAULT_PART_TOKENS,
    request.maxTokens ?? 120_000,
  );
  const systemTokens = Math.ceil(systemPromptChars / 4);
  const chunks = planChunks(request.diff, {
    maxTokens: Math.max(
      MIN_PART_DIFF_TOKENS,
      Math.floor((partBudget - systemTokens) / 2),
    ),
    maxChangedLines: MAX_PART_CHANGED_LINES,
  });

  if (chunks.length <= 1) {
    // The part budget applies here too: a short diff over large files is
    // still one oversized request otherwise.
    const context = await buildContext(
      { ...request, maxTokens: partBudget },
      readFile,
      { ...promptOptions, systemPromptChars },
    );
    return [
      {
        index: 1,
        total: 1,
        files: chunks[0]?.labels ?? [],
        context,
        prompt: await buildPrompt(context, promptOptions),
      },
    ];
  }

  const parts: PlannedPart[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    const otherFiles = [
      ...new Set(
        chunks
          .filter((_, other) => other !== index)
          .flatMap((other) => other.labels)
          .filter((label) => !chunk.labels.includes(label)),
      ),
    ];
    const context = await buildContext(
      {
        ...request,
        diff: chunk.diff,
        maxTokens: partBudget,
        part: { index: index + 1, total: chunks.length, otherFiles },
      },
      readFile,
      { ...promptOptions, systemPromptChars },
    );
    parts.push({
      index: index + 1,
      total: chunks.length,
      files: chunk.labels,
      context,
      prompt: await buildPrompt(context, promptOptions),
    });
  }

  return parts;
}

export interface PartOutcome {
  index: number;
  files: readonly string[];
  /** Model id the provider reported for the findings, or the last one tried. */
  model: string;
  /** Model id this part requested; the re-check reuses it. */
  requestedModel: string;
  /** Null when the part was reviewed. */
  error: string | null;
  findings: number;
  /** The reply was cut off and only its complete findings were kept. */
  cutOff: boolean;
  tokensIn: number;
  tokensOut: number;
}

export interface PartsResult {
  findings: Finding[];
  dropped: DroppedFindings;
  tokensIn: number;
  tokensOut: number;
  /** Provider-reported USD over every request, 0 when none was reported. */
  cost: number;
  attempts: readonly ModelAttempt[];
  /** Provider-reported model of the first reviewed part. */
  model: string;
  /** Requested model id of the first reviewed part. */
  requestedModel: string;
  parts: readonly PartOutcome[];
  /** Files reduced to hunks in any part. */
  truncated: readonly string[];
}

export interface ReviewPartsOptions {
  model: string;
  /** Used for a part over the line or budget gate, and to retry a failed part. */
  bigPrModel?: string;
  /** Model call settings shared by every part. */
  modelOptions: ModelOptions;
  log: (line: string) => void;
  /** Parts in flight at once. Default PART_CONCURRENCY. */
  concurrency?: number;
}

/**
 * Every part failed. Carries the per-part outcomes for the summary and the
 * model the review asked for, on top of the usual usage and attempts.
 */
export class PartsFailedError extends BugbotModelError {
  readonly parts: readonly PartOutcome[];
  readonly requestedModel: string;

  constructor(
    message: string,
    usage: { tokensIn: number; tokensOut: number; cost: number },
    attempts: readonly ModelAttempt[],
    parts: readonly PartOutcome[],
    requestedModel: string,
  ) {
    super(message, usage, attempts);
    this.name = "BugbotModelError";
    this.parts = parts;
    this.requestedModel = requestedModel;
  }
}

interface PartRun {
  outcome: PartOutcome;
  findings: Finding[];
  dropped: DroppedFindings;
  cost: number;
  attempts: ModelAttempt[];
  /** The original error, rethrown unchanged when this is the only part. */
  thrown: unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runPart(
  part: PlannedPart,
  options: ReviewPartsOptions,
): Promise<PartRun> {
  const split = part.total > 1;
  const log = (line: string): void =>
    options.log(split ? `Part ${part.index}/${part.total}: ${line}` : line);
  const run: PartRun = {
    outcome: {
      index: part.index,
      files: part.files,
      model: options.model,
      requestedModel: options.model,
      error: null,
      findings: 0,
      cutOff: false,
      tokensIn: 0,
      tokensOut: 0,
    },
    findings: [],
    dropped: { count: 0, reasons: [] },
    cost: 0,
    attempts: [],
    thrown: null,
  };

  const selection = selectModel({
    model: options.model,
    bigPrModel: options.bigPrModel,
    changedLines: part.context.totalChangedLines,
    overBudget: part.context.overBudget,
  });
  if ("skip" in selection) {
    run.outcome.error = selection.skip;
    run.thrown = new Error(selection.skip);
    return run;
  }

  // A failed part gets one more try on big_pr_model when that is a different
  // model; it is often better at long structured answers.
  const fallback = options.bigPrModel?.trim() ?? "";
  const models =
    split && fallback !== "" && fallback !== selection.model
      ? [selection.model, fallback]
      : [selection.model];

  for (const model of models) {
    run.outcome.model = model;
    run.outcome.requestedModel = model;
    try {
      const result = await callModel(
        { model, system: part.prompt.system, user: part.prompt.user },
        { ...options.modelOptions, log },
      );
      run.outcome.tokensIn += result.tokensIn;
      run.outcome.tokensOut += result.tokensOut;
      run.cost += result.cost ?? 0;
      run.attempts.push(...result.attempts);
      run.outcome.model = result.model.trim() === "" ? model : result.model;

      const parsed = parseJsonResponse(result.raw);
      run.findings = parsed.findings;
      run.dropped = parsed.dropped;
      run.outcome.findings = parsed.findings.length;
      run.outcome.cutOff = result.truncated === true || parsed.truncated === true;
      run.outcome.error = null;
      run.thrown = null;
      return run;
    } catch (error) {
      if (error instanceof BugbotModelError) {
        run.outcome.tokensIn += error.tokensIn;
        run.outcome.tokensOut += error.tokensOut;
        run.cost += error.cost;
        run.attempts.push(...error.attempts);
      }
      run.outcome.error = messageOf(error);
      run.thrown = error;
      if (model !== models.at(-1)) {
        log(`review failed on ${model}, retrying on ${fallback}: ${messageOf(error)}`);
      }
    }
  }

  return run;
}

/** Runs `task` over `items` with at most `limit` in flight, keeping order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await task(item);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

/**
 * Reviews every part and merges the findings. A single part behaves exactly
 * like the old one-request review, including the error it throws. With
 * several parts, the pass fails only when every part failed; otherwise the
 * failed parts are listed in `parts` and the rest are kept.
 */
export async function reviewParts(
  parts: readonly PlannedPart[],
  options: ReviewPartsOptions,
): Promise<PartsResult> {
  if (parts.length > 1) {
    options.log(`Bugbot: reviewing ${parts.length} parts`);
  }

  const runs = await mapLimited(
    parts,
    options.concurrency ?? PART_CONCURRENCY,
    (part) => runPart(part, options),
  );

  const attempts = runs.flatMap((run) =>
    parts.length > 1
      ? run.attempts.map((attempt) => ({ ...attempt, part: run.outcome.index }))
      : run.attempts,
  );
  const tokensIn = runs.reduce((sum, run) => sum + run.outcome.tokensIn, 0);
  const tokensOut = runs.reduce((sum, run) => sum + run.outcome.tokensOut, 0);
  const cost = runs.reduce((sum, run) => sum + run.cost, 0);
  const reviewed = runs.filter((run) => run.outcome.error === null);

  for (const run of runs) {
    if (parts.length > 1) {
      const { index, findings, tokensIn: inTokens, tokensOut: outTokens } =
        run.outcome;
      options.log(
        run.outcome.error === null
          ? `Part ${index}/${parts.length}: ${findings} finding${
              findings === 1 ? "" : "s"
            }${run.outcome.cutOff ? " (reply cut off)" : ""}, tokens_in=${inTokens} tokens_out=${outTokens}`
          : `Part ${index}/${parts.length}: failed: ${run.outcome.error}`,
      );
    }
  }

  if (reviewed.length === 0) {
    const only = runs[0];
    if (runs.length === 1 && only !== undefined) {
      // Same message as a one-request review, but carrying the usage of a
      // reply that arrived and then failed to parse (F23-RV1-B1).
      if (only.thrown instanceof BugbotModelError) {
        throw new PartsFailedError(
          only.thrown.message,
          { tokensIn, tokensOut, cost },
          attempts,
          [only.outcome],
          only.outcome.requestedModel,
        );
      }
      throw only.thrown;
    }

    const first = runs[0]?.outcome.error ?? "unknown error";
    throw new PartsFailedError(
      `all ${runs.length} review parts failed; part 1: ${first}`,
      { tokensIn, tokensOut, cost },
      attempts,
      runs.map((run) => run.outcome),
      runs[0]?.outcome.requestedModel ?? options.model,
    );
  }

  const dropped = {
    count: reviewed.reduce((sum, run) => sum + run.dropped.count, 0),
    reasons: reviewed.flatMap((run) =>
      parts.length > 1
        ? run.dropped.reasons.map(
            (reason) => `part ${run.outcome.index}: ${reason}`.slice(0, 200),
          )
        : run.dropped.reasons,
    ),
  };

  return {
    findings: reviewed.flatMap((run) => run.findings),
    dropped,
    tokensIn,
    tokensOut,
    cost,
    attempts,
    model: reviewed[0]?.outcome.model ?? options.model,
    requestedModel: reviewed[0]?.outcome.requestedModel ?? options.model,
    parts: runs.map((run) => run.outcome),
    truncated: [...new Set(parts.flatMap((part) => part.context.truncated))],
  };
}
