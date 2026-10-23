import { FindingSchema, type Finding } from "./filter.js";

/**
 * OpenRouter client: JSON-only responses, temperature 0, a per-attempt
 * timeout and two retries with exponential backoff plus jitter. The API key
 * is never included in an error message.
 */

export interface ModelCall {
  /** OpenRouter model id, for example deepseek/deepseek-v4.1-flash-1017. */
  model: string;
  system: string;
  user: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Sleep = (milliseconds: number) => Promise<void>;

export interface ModelOptions {
  /** OPENROUTER_API_KEY. Read from the shell environment by the CLI. */
  apiKey?: string;
  /**
   * Output token cap sent as `max_tokens`. Default 8000. A `length` stop
   * with empty content doubles it, up to `maxOutputTokensCeiling`.
   */
  maxOutputTokens?: number;
  /**
   * Highest `max_tokens` a retry after a `length` stop may grow to.
   * Default 32000; never below `maxOutputTokens`.
   */
  maxOutputTokensCeiling?: number;
  /**
   * Optional OpenRouter `reasoning.effort` override, used on the first
   * attempt even for a model that honors `reasoning.max_tokens`. Without it
   * an effort-only model reasons at `low` and an allow-listed model gets
   * `reasoning.max_tokens` = `reasoningMaxTokens`.
   */
  reasoningEffort?: "none" | "low" | "medium" | "high" | "max";
  /**
   * Reasoning budget sent as `reasoning.max_tokens` for the models in
   * `modelHonorsReasoningMaxTokens`. Default 8000. It is only sent to those
   * models; effort-only models turn it into an effort level instead.
   */
  reasoningMaxTokens?: number;
  /** Retries after the first attempt. Default: 2. */
  retries?: number;
  /** Injectable fetch, so tests make no network call. */
  fetch?: FetchLike;
  /** Injectable sleep, so tests do not wait for backoff. */
  sleep?: Sleep;
  /**
   * Per-attempt timeout for the first cap. Default 120 seconds. A retry with
   * a bigger output cap gets proportionally more time, up to 300 seconds.
   */
  timeoutMs?: number;
  /** One-line diagnostic sink for an empty completion. Default console.warn. */
  log?: (line: string) => void;
}

export interface ModelResult {
  /** Raw JSON text returned by the model. Validated by FindingSchema. */
  raw: string;
  model: string;
  /** Usage summed over every 200 reply, including retried empty ones. */
  tokensIn: number;
  tokensOut: number;
  /** Safe per-attempt settings and usage, oldest first. Never model text. */
  attempts: readonly ModelAttempt[];
}

/**
 * What one attempt sent and cost. `reasoning` is a fixed setting label such
 * as `effort=low` or `max_tokens=8000`; no reasoning or prompt text is kept.
 */
export interface ModelAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** `max_tokens` sent for this attempt. */
  maxTokens: number;
  /** `effort=<level>`, `effort=none` or `max_tokens=<n>`. */
  reasoning: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  /** finish_reason, `http_<status>`, `timeout`, `non-json` or `network`. */
  outcome: string;
}

export interface DroppedFindings {
  count: number;
  /** One short, safe reason per dropped item. Never raw model content. */
  reasons: readonly string[];
}

export interface ParsedFindings {
  findings: Finding[];
  dropped: DroppedFindings;
}

/** A safe model failure: no key, no headers and no request body. */
export class BugbotModelError extends Error {
  /** Tokens the provider reported, summed over every 200 reply. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Safe per-attempt settings and usage, oldest first. */
  readonly attempts: readonly ModelAttempt[];

  constructor(
    message: string,
    usage: { tokensIn?: number; tokensOut?: number } = {},
    attempts: readonly ModelAttempt[] = [],
  ) {
    super(message);
    this.name = "BugbotModelError";
    this.tokensIn = usage.tokensIn ?? 0;
    this.tokensOut = usage.tokensOut ?? 0;
    this.attempts = attempts;
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
/** The highest `max_tokens` the retry ladder may use without configuration. */
export const DEFAULT_MAX_OUTPUT_TOKENS_CEILING = 32_000;
export const DEFAULT_REASONING_MAX_TOKENS = 8_000;
/** Provider minimum for a `reasoning.max_tokens` budget. */
export const MIN_REASONING_MAX_TOKENS = 1_024;
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPT_TIMEOUT_MS = 300_000;

/**
 * Models that honor `reasoning.max_tokens`. OpenRouter's
 * `GET /api/v1/models` reports `supports_max_tokens: true` for these ids.
 * Effort-only models (including DeepSeek) turn a `max_tokens` budget into an
 * effort level, so they must use `reasoning.effort` instead. This is a static
 * allow-list on purpose: no runtime model lookup.
 */
export function modelHonorsReasoningMaxTokens(model: string): boolean {
  const id = model.trim().toLowerCase();

  return (
    id.startsWith("anthropic/") ||
    id.startsWith("google/gemini") ||
    id.startsWith("qwen/")
  );
}

type ReasoningSetting =
  | { readonly kind: "effort"; readonly effort: "low" | "medium" | "high" | "max" }
  | { readonly kind: "budget"; readonly maxTokens: number }
  | { readonly kind: "off" };

/** A fixed, safe name for the request's reasoning setting. */
function reasoningLabel(setting: ReasoningSetting): string {
  if (setting.kind === "off") {
    return "effort=none";
  }

  return setting.kind === "effort"
    ? `effort=${setting.effort}`
    : `max_tokens=${setting.maxTokens}`;
}

/**
 * The first attempt always reasons unless an override says otherwise:
 * a budget for an allow-listed model, `low` effort for every other model.
 */
function firstReasoningSetting(
  model: string,
  effort: ModelOptions["reasoningEffort"],
  maxTokens: number,
): ReasoningSetting {
  if (effort === "none") {
    return { kind: "off" };
  }

  if (effort !== undefined) {
    return { kind: "effort", effort };
  }

  return modelHonorsReasoningMaxTokens(model)
    ? { kind: "budget", maxTokens }
    : { kind: "effort", effort: "low" };
}

/**
 * After a `length` stop with empty content, an effort-only model must stop
 * reasoning at once. An allow-listed model halves its budget first and turns
 * reasoning off on the final attempt, which always answers.
 */
function retryReasoningSetting(
  current: ReasoningSetting,
  model: string,
  maxTokens: number,
): ReasoningSetting {
  if (!modelHonorsReasoningMaxTokens(model)) {
    return { kind: "off" };
  }

  const budget = current.kind === "budget" ? current.maxTokens : maxTokens;

  // Never go below the provider minimum; a 1024 budget cannot be halved.
  return {
    kind: "budget",
    maxTokens: Math.max(MIN_REASONING_MAX_TOKENS, Math.floor(budget / 2)),
  };
}

/** The exact `reasoning` object sent to OpenRouter. */
function reasoningField(
  setting: ReasoningSetting,
): { effort: string } | { max_tokens: number } {
  if (setting.kind === "off") {
    return { effort: "none" };
  }

  return setting.kind === "effort"
    ? { effort: setting.effort }
    : { max_tokens: setting.maxTokens };
}

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Provider usage is untrusted: only non-negative safe integers survive. */
function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

/**
 * A bigger `max_tokens` gives the model more to write, so a retried attempt
 * gets more time: the first attempt keeps `timeoutMs`, each bigger cap scales
 * it, and one hung request is still bounded by `MAX_ATTEMPT_TIMEOUT_MS`.
 */
export function scaledAttemptTimeout(
  timeoutMs: number,
  cap: number,
  baseCap: number,
): number {
  const base = baseCap > 0 ? baseCap : 1;
  return Math.min(
    MAX_ATTEMPT_TIMEOUT_MS,
    Math.max(timeoutMs, Math.round((timeoutMs * cap) / base)),
  );
}

/** Removes the key from any provider-controlled text, then caps the length. */
function safeText(text: string, apiKey: string): string {
  const redacted =
    apiKey === "" ? text : text.split(apiKey).join("[redacted]");
  return redacted.slice(0, 200);
}

/** At most 200 chars of a structured provider `error.message`. */
function providerDetail(body: string, apiKey: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return `: ${safeText(parsed.error.message, apiKey)}`;
    }
  } catch {
    // A non-JSON error body is intentionally not echoed.
  }

  return "";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function errorFields(
  record: Record<string, unknown> | null,
  apiKey: string,
): { code: string | null; message: string | null } {
  const error = recordOf(record?.error);
  if (error === null) {
    return { code: null, message: null };
  }

  const rawCode = error.code;
  const code =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? String(rawCode)
      : typeof rawCode === "string" && rawCode.trim() !== ""
        ? rawCode.trim().slice(0, 60)
        : null;
  const message =
    typeof error.message === "string"
      ? safeText(error.message, apiKey).replace(/\s+/g, " ").trim()
      : null;

  return { code, message };
}

/**
 * The parts of a completion that decide what happened, without any prompt or
 * reasoning text. `content` is the only field that leaves this module.
 */
interface CompletionDetails {
  content: string | null;
  finishReason: string | null;
  nativeFinishReason: string | null;
  /** Character count only: the reasoning text itself is never kept. */
  reasoningChars: number;
  reasoningDetails: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  errorCode: string | null;
  errorMessage: string | null;
}

function completionDetails(
  payload: unknown,
  apiKey: string,
): CompletionDetails {
  const record = recordOf(payload);
  const choices = record?.choices;
  const first = Array.isArray(choices) ? recordOf(choices[0]) : null;
  const message = recordOf(first?.message);
  const contentValue = message?.content;
  const content =
    typeof contentValue === "string" && contentValue.trim() !== ""
      ? contentValue
      : null;
  const reasoning =
    stringField(message?.reasoning) ?? stringField(message?.reasoning_content);
  const reasoningDetails = Array.isArray(message?.reasoning_details)
    ? message.reasoning_details.length
    : 0;
  const usage = recordOf(record?.usage);
  const usageDetails = recordOf(usage?.completion_tokens_details);
  const topError = errorFields(record, apiKey);
  const choiceError = errorFields(first, apiKey);

  return {
    content,
    finishReason: stringField(first?.finish_reason),
    nativeFinishReason: stringField(first?.native_finish_reason),
    reasoningChars: reasoning?.length ?? 0,
    reasoningDetails,
    promptTokens: numberOrZero(usage?.prompt_tokens),
    completionTokens: numberOrZero(usage?.completion_tokens),
    reasoningTokens:
      numberOrZero(usageDetails?.reasoning_tokens) ||
      numberOrZero(usage?.reasoning_tokens),
    errorCode: topError.code ?? choiceError.code,
    errorMessage: topError.message ?? choiceError.message,
  };
}

/** One safe line per empty completion: no prompt, reasoning or key text. */
function diagnosticLine(
  details: CompletionDetails,
  cap: number,
  reasoning: string,
): string {
  const parts = [
    `max_tokens=${cap}`,
    `reasoning=${reasoning}`,
    `finish_reason=${details.finishReason ?? "none"}`,
    `native_finish_reason=${details.nativeFinishReason ?? "none"}`,
    `reasoning_chars=${details.reasoningChars}`,
    `reasoning_details=${details.reasoningDetails}`,
    `prompt_tokens=${details.promptTokens}`,
    `completion_tokens=${details.completionTokens}`,
    `reasoning_tokens=${details.reasoningTokens}`,
  ];

  if (details.errorCode !== null || details.errorMessage !== null) {
    parts.push(`error_code=${details.errorCode ?? "none"}`);
    if (details.errorMessage !== null) {
      parts.push(`error_message=${details.errorMessage}`);
    }
  }

  return `OpenRouter empty completion: ${parts.join(" ")}`;
}

/** Plain words for the final neutral line, never provider content. */
function emptyContentCause(details: CompletionDetails, cap: number): string {
  if (details.errorCode !== null || details.errorMessage !== null) {
    const detail = [details.errorCode, details.errorMessage]
      .filter((part): part is string => part !== null)
      .join(" ");
    return `OpenRouter returned an error inside a 200 response: ${detail}`;
  }

  if (details.finishReason === "length") {
    const reasoningSpent =
      details.reasoningChars > 0 ||
      details.reasoningDetails > 0 ||
      details.reasoningTokens > 0;
    return `the model used its whole ${cap}-token output budget${
      reasoningSpent ? " on reasoning" : ""
    } and returned no answer (finish_reason "length"); try a model that reasons less or raise \`max_output_tokens\``;
  }

  if (details.finishReason === "content_filter") {
    return 'the model stopped on a content filter and returned no answer (finish_reason "content_filter")';
  }

  if (details.finishReason === "error") {
    return 'the model returned finish_reason "error" and no answer';
  }

  if (details.finishReason === null) {
    return "OpenRouter returned no message content";
  }

  return `OpenRouter returned no message content (finish_reason "${details.finishReason}")`;
}

/**
 * POSTs one JSON-only chat completion. Retries network errors, timeouts, 429,
 * 5xx and a 200 whose content is not JSON. 400/401/402/403/404 fail on the
 * first attempt so a bad model name or key is visible immediately.
 */
export async function callModel(
  call: ModelCall,
  options: ModelOptions = {},
): Promise<ModelResult> {
  const apiKey = options.apiKey ?? "";
  if (apiKey === "") {
    throw new BugbotModelError("OPENROUTER_API_KEY is not set");
  }

  const fetchFn: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const baseCap = maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  const ceiling = Math.max(
    maxOutputTokens,
    options.maxOutputTokensCeiling ?? DEFAULT_MAX_OUTPUT_TOKENS_CEILING,
  );
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const totalAttempts = 1 + retries;
  const log = options.log ?? ((line: string) => console.warn(line));
  const reasoningMaxTokens =
    options.reasoningMaxTokens ?? DEFAULT_REASONING_MAX_TOKENS;
  let cap = maxOutputTokens;
  let reasoning = firstReasoningSetting(
    call.model,
    options.reasoningEffort,
    reasoningMaxTokens,
  );

  let lastMessage = "OpenRouter request failed";
  /** The last empty-reply cause, kept when a later attempt times out. */
  let lastDiagnosis: string | null = null;
  let lastStatus: number | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  const used: ModelAttempt[] = [];

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const setting = reasoning;
    const settingLabel = reasoningLabel(setting);
    const attemptTimeoutMs = scaledAttemptTimeout(timeoutMs, cap, baseCap);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    let retryable = false;
    let growCap = false;
    let attemptIn = 0;
    let attemptOut = 0;
    let attemptReasoning = 0;
    let outcome = "network";
    let recorded = false;

    /** Records this attempt once, whichever branch ends it. */
    const recordAttempt = (): void => {
      if (recorded) {
        return;
      }
      recorded = true;
      used.push({
        attempt: attempt + 1,
        maxTokens: cap,
        reasoning: settingLabel,
        tokensIn: attemptIn,
        tokensOut: attemptOut,
        reasoningTokens: attemptReasoning,
        outcome,
      });
    };

    log(
      `OpenRouter attempt ${attempt + 1}/${totalAttempts}: max_tokens=${cap} reasoning=${settingLabel}`,
    );

    const body = JSON.stringify({
      model: call.model,
      messages: [
        { role: "system", content: call.system },
        { role: "user", content: call.user },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: cap,
      reasoning: reasoningField(setting),
    });

    try {
      const response = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Title": "bugbot",
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        outcome = `http_${response.status}`;
        const message = `OpenRouter returned ${response.status}${providerDetail(
          text,
          apiKey,
        )}`;

        if (!isRetryableStatus(response.status)) {
          recordAttempt();
          throw new BugbotModelError(message, { tokensIn, tokensOut }, used);
        }

        lastMessage = message;
        lastStatus = response.status;
        retryable = true;
      } else {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          outcome = "non-json";
          lastMessage = "OpenRouter returned a non-JSON response";
          lastStatus = response.status;
          retryable = true;
          payload = undefined;
        }

        if (payload !== undefined) {
          const details = completionDetails(payload, apiKey);
          attemptIn = details.promptTokens;
          attemptOut = details.completionTokens;
          attemptReasoning = details.reasoningTokens;
          outcome = details.finishReason ?? "none";
          // A failed attempt still costs tokens. Keep them for the summary.
          tokensIn += details.promptTokens;
          tokensOut += details.completionTokens;

          if (details.content === null) {
            log(diagnosticLine(details, cap, settingLabel));
            lastDiagnosis = emptyContentCause(details, cap);
            lastMessage = lastDiagnosis;
            lastStatus = response.status;
            retryable = true;
            growCap =
              details.finishReason === "length" &&
              details.errorCode === null &&
              details.errorMessage === null;
          } else {
            try {
              JSON.parse(details.content);
            } catch {
              lastMessage = "model response content was not JSON";
              lastStatus = response.status;
              retryable = true;
            }

            if (!retryable) {
              const record = recordOf(payload);
              const model = stringField(record?.model) ?? call.model;

              recordAttempt();
              return {
                raw: details.content,
                model,
                tokensIn,
                tokensOut,
                attempts: used,
              };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof BugbotModelError) {
        recordAttempt();
        throw error;
      }

      if (isAbort(error) || controller.signal.aborted) {
        outcome = "timeout";
        lastMessage = `OpenRouter request timed out after ${attemptTimeoutMs} ms`;
        if (lastDiagnosis !== null) {
          lastMessage += `; earlier attempt: ${lastDiagnosis}`;
        }
        lastStatus = null;
      } else {
        outcome = "network";
        const reason = error instanceof Error ? error.message : String(error);
        lastMessage = `OpenRouter request failed: ${safeText(reason, apiKey)}`;
        lastStatus = null;
      }
      retryable = true;
    } finally {
      clearTimeout(timer);
    }

    recordAttempt();

    if (!retryable || attempt === totalAttempts - 1) {
      break;
    }

    const nextIsFinal = attempt + 2 === totalAttempts;
    if (nextIsFinal) {
      // The last attempt always answers with reasoning off. A finite output
      // cap is what remains, so grow it once only on this attempt.
      reasoning = { kind: "off" };
      if (growCap) {
        cap = Math.min(cap * 2, ceiling);
      }
    } else if (growCap) {
      // One retry at the same cap with reasoning bounded, then a bigger cap
      // on the final attempt. This bounds worst-case tokens and time while
      // still giving a genuinely long answer more room.
      reasoning = retryReasoningSetting(reasoning, call.model, reasoningMaxTokens);
    }

    const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  const statusSuffix = lastStatus === null ? "" : ` (last status ${lastStatus})`;
  throw new BugbotModelError(
    `${lastMessage}${statusSuffix} after ${totalAttempts} attempt${
      totalAttempts === 1 ? "" : "s"
    }`,
    { tokensIn, tokensOut },
    used,
  );
}

/** Strips one surrounding ```json fence, leaving any other text alone. */
function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text.trim());
  return match?.[1] ?? text.trim();
}

function dropReason(index: number, issue: { path: PropertyKey[]; message: string }): string {
  const field = issue.path.length > 0 ? issue.path.join(".") : "finding";
  return `item ${index}: ${field}: ${issue.message}`.slice(0, 200);
}

/**
 * Parses `{"findings":[...]}` or a bare array, with one optional surrounding
 * Markdown fence. Items that fail FindingSchema are dropped with a short
 * reason and never echoed.
 */
export function parseJsonResponse(raw: string): ParsedFindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    throw new BugbotModelError("model response was not valid JSON");
  }

  let items: unknown[];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    "findings" in parsed &&
    Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    items = (parsed as { findings: unknown[] }).findings;
  } else {
    throw new BugbotModelError(
      'model response must be {"findings":[...]} or a JSON array',
    );
  }

  const findings: Finding[] = [];
  const reasons: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const result = FindingSchema.safeParse(item);

    if (result.success) {
      findings.push(result.data);
      continue;
    }

    const issue = result.error.issues[0];
    reasons.push(
      issue === undefined
        ? `item ${index}: invalid finding`
        : dropReason(index, issue),
    );
  }

  return {
    findings,
    dropped: { count: reasons.length, reasons },
  };
}
