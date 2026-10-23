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

/** OpenRouter `reasoning.effort` values this client accepts. */
export type ReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none";

/** Attempt 1 reasons at high effort unless configured otherwise. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";

export interface ModelOptions {
  /** OPENROUTER_API_KEY. Read from the shell environment by the CLI. */
  apiKey?: string;
  /**
   * Output token cap sent as `max_tokens`. Default 64000. A `length` stop
   * retries once at the same cap with reasoning off, as one extra attempt
   * outside the retry budget.
   */
  maxOutputTokens?: number;
  /**
   * OpenRouter `reasoning.effort` for the first attempt. Default `high`, sent
   * explicitly as `reasoning.effort`. A `length` stop turns it off on the
   * single retry, unless it is already off.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Optional reasoning budget sent as `reasoning.max_tokens`. Omitted by
   * default. It is only sent to the models in `modelHonorsReasoningMaxTokens`;
   * every other model ignores it. When both this and `reasoningEffort` are
   * set, the budget wins for an allow-listed model and the effort wins for
   * every other model.
   */
  reasoningMaxTokens?: number;
  /** Retries after the first attempt. Default: 2. */
  retries?: number;
  /** Injectable fetch, so tests make no network call. */
  fetch?: FetchLike;
  /** Injectable sleep, so tests do not wait for backoff. */
  sleep?: Sleep;
  /**
   * Per-attempt timeout for the first cap, mainly for tests. Without it the
   * timeout is derived from the cap: cap / 80 tokens per second, at least
   * 120 s and at most 1800 s, so a 64000-token reply can finish.
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
  /** Provider-reported cost in USD over every 200 reply, when reported. */
  cost?: number;
  /**
   * True when the reply stopped on `length` mid-JSON and only its complete
   * findings were kept.
   */
  truncated?: boolean;
}

/**
 * What one attempt sent and cost. `reasoning` is a fixed setting label such
 * as `effort=high` or `max_tokens=8000`; no reasoning or prompt text
 * is kept.
 */
export interface ModelAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** `max_tokens` sent for this attempt. */
  maxTokens: number;
  /** `effort=<level>` or `max_tokens=<n>`. */
  reasoning: string;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  /** finish_reason, `http_<status>`, `timeout`, `non-json` or `network`. */
  outcome: string;
  /** Provider-reported cost in USD, only when the provider reported one. */
  cost?: number;
  /** 1-based review part, set by the part runner when a PR is split. */
  part?: number;
}

export interface DroppedFindings {
  count: number;
  /** One short, safe reason per dropped item. Never raw model content. */
  reasons: readonly string[];
}

export interface ParsedFindings {
  findings: Finding[];
  dropped: DroppedFindings;
  /** Set when the JSON was cut off and only its complete findings were kept. */
  truncated?: true;
}

/** A safe model failure: no key, no headers and no request body. */
export class BugbotModelError extends Error {
  /** Tokens the provider reported, summed over every 200 reply. */
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Safe per-attempt settings and usage, oldest first. */
  readonly attempts: readonly ModelAttempt[];
  /** Provider-reported cost in USD, 0 when none was reported. */
  readonly cost: number;

  constructor(
    message: string,
    usage: { tokensIn?: number; tokensOut?: number; cost?: number } = {},
    attempts: readonly ModelAttempt[] = [],
  ) {
    super(message);
    this.name = "BugbotModelError";
    this.tokensIn = usage.tokensIn ?? 0;
    this.tokensOut = usage.tokensOut ?? 0;
    this.cost = usage.cost ?? 0;
    this.attempts = attempts;
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Default output cap. A length stop retries at the same cap with reasoning off. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
/** Provider minimum for a `reasoning.max_tokens` budget. */
export const MIN_REASONING_MAX_TOKENS = 1_024;
const DEFAULT_RETRIES = 2;
const MIN_ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPT_TIMEOUT_MS = 1_800_000;
/**
 * Measured throughput is roughly 90 tokens/s. A slightly slower 80 tokens/s
 * gives a 64000-token reply about 13 minutes instead of 12.
 */
const TOKENS_PER_SECOND = 80;

/**
 * Models that honor `reasoning.max_tokens`. OpenRouter's
 * `GET /api/v1/models` reports `supports_max_tokens: true` for these ids.
 * Effort-only models (including DeepSeek) do not, so a configured budget is
 * ignored for them and `reasoning.effort` is the only override. This is a
 * static allow-list on purpose: no runtime model lookup.
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
  | { readonly kind: "effort"; readonly effort: ReasoningEffort }
  | { readonly kind: "budget"; readonly maxTokens: number };

/** A fixed, safe name for the request's reasoning setting. */
function reasoningLabel(setting: ReasoningSetting): string {
  return setting.kind === "effort"
    ? `effort=${setting.effort}`
    : `max_tokens=${setting.maxTokens}`;
}

/** True when the request already turns reasoning off. */
function reasoningOff(setting: ReasoningSetting): boolean {
  return setting.kind === "effort" && setting.effort === "none";
}

/**
 * Attempt 1 always sends an explicit setting. For an allow-listed model a
 * configured budget wins over the effort; for every other model the effort
 * wins and a budget is ignored.
 */
function firstReasoningSetting(
  model: string,
  effort: ReasoningEffort,
  maxTokens: number | undefined,
): ReasoningSetting {
  // The budget is only valid for an allow-listed model; elsewhere it is
  // ignored, and the configured effort still applies.
  if (modelHonorsReasoningMaxTokens(model) && maxTokens !== undefined) {
    return { kind: "budget", maxTokens };
  }

  return { kind: "effort", effort };
}

/** The exact `reasoning` object sent to OpenRouter. */
function reasoningField(
  setting: ReasoningSetting,
): { effort: ReasoningEffort } | { max_tokens: number } {
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

/** Provider cost is untrusted too: a finite, non-negative number or 0. */
function costOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * The automatic per-attempt timeout for a cap: about 80 tokens/s, never below
 * 120 s and never above 1800 s. At the default 64000-token cap this is 800 s,
 * enough for a reply measured at roughly 90 tokens/s.
 */
export function defaultAttemptTimeoutMs(cap: number): number {
  const needed = Math.ceil(((cap > 0 ? cap : 0) / TOKENS_PER_SECOND) * 1_000);
  return Math.min(
    MAX_ATTEMPT_TIMEOUT_MS,
    Math.max(MIN_ATTEMPT_TIMEOUT_MS, needed),
  );
}

/**
 * A bigger `max_tokens` gives the model more to write, so a retried attempt
 * gets more time proportionally. An explicit `timeoutMs` is the base for the
 * smallest cap; one hung request is still bounded by `MAX_ATTEMPT_TIMEOUT_MS`.
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
  /** `usage.cost` in USD, 0 when absent. */
  cost: number;
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
    cost: costOrZero(usage?.cost),
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

/** A length stop with partial content: the JSON answer was cut off. */
function truncatedContentCause(cap: number): string {
  return `the model used its whole ${cap}-token output budget and returned incomplete JSON (finish_reason "length"); try a model that reasons less or raise \`max_output_tokens\``;
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
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const baseCap = maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : defaultAttemptTimeoutMs(baseCap);
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const totalAttempts = 1 + retries;
  /** Counted attempts plus, once, the reasoning-off attempt after a length stop. */
  let maxAttempts = totalAttempts;
  const log = options.log ?? ((line: string) => console.warn(line));
  let cap = maxOutputTokens;
  let reasoning = firstReasoningSetting(
    call.model,
    options.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    options.reasoningMaxTokens,
  );
  /**
   * After a length stop, one retry runs with reasoning off. That retry does
   * not count against `retries`, so a transient failure cannot use it up. It
   * runs once: a length stop on the retry itself, or an already-off setting,
   * ends the call. There is no bigger cap and no second fallback.
   */
  let lengthFallbackActive = false;

  let lastMessage = "OpenRouter request failed";
  /** The last empty-reply cause, kept when a later attempt times out. */
  let lastDiagnosis: string | null = null;
  let lastStatus: number | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  const used: ModelAttempt[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const setting = reasoning;
    const settingLabel = reasoningLabel(setting);
    const attemptTimeoutMs = scaledAttemptTimeout(timeoutMs, cap, baseCap);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    let retryable = false;
    let lengthStop = false;
    let attemptIn = 0;
    let attemptOut = 0;
    let attemptReasoning = 0;
    let attemptCost = 0;
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
        ...(attemptCost > 0 ? { cost: attemptCost } : {}),
      });
    };

    log(
      `OpenRouter attempt ${attempt + 1}/${maxAttempts}: max_tokens=${cap} reasoning=${settingLabel}`,
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
      // Asks OpenRouter to report `usage.cost`, so the summary can log spend.
      usage: { include: true },
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
          throw new BugbotModelError(
            message,
            { tokensIn, tokensOut, cost },
            used,
          );
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
          attemptCost = details.cost;
          outcome = details.finishReason ?? "none";
          // A failed attempt still costs tokens. Keep them for the summary.
          tokensIn += details.promptTokens;
          tokensOut += details.completionTokens;
          cost += details.cost;

          if (details.content === null) {
            log(diagnosticLine(details, cap, settingLabel));
            lastDiagnosis = emptyContentCause(details, cap);
            lastMessage = lastDiagnosis;
            lastStatus = response.status;
            retryable = true;
            lengthStop =
              details.finishReason === "length" &&
              details.errorCode === null &&
              details.errorMessage === null;
          } else {
            let cutOff = false;
            try {
              JSON.parse(details.content);
            } catch {
              // A reply cut off at the cap still keeps every finding that was
              // written out in full. Only a cut-off with none of them, or a
              // reply that is not JSON at all, is retried.
              const salvaged =
                details.finishReason === "length"
                  ? salvageFindingItems(details.content)
                  : null;
              if (salvaged !== null && salvaged.length > 0) {
                cutOff = true;
                log(
                  `OpenRouter reply cut off at max_tokens=${cap}; keeping ${salvaged.length} complete finding${
                    salvaged.length === 1 ? "" : "s"
                  }`,
                );
              } else {
                // A cut-off answer is a length stop even when some content
                // made it out, so it gets the same one reasoning-off retry
                // (F5-RV1-N1).
                lastMessage =
                  details.finishReason === "length"
                    ? truncatedContentCause(cap)
                    : "model response content was not JSON";
                lastDiagnosis = lastMessage;
                lastStatus = response.status;
                retryable = true;
                lengthStop =
                  details.finishReason === "length" &&
                  details.errorCode === null &&
                  details.errorMessage === null;
              }
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
                ...(cost > 0 ? { cost } : {}),
                ...(cutOff ? { truncated: true } : {}),
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

    if (!retryable) {
      break;
    }

    if (lengthStop) {
      // The reasoning-off retry is one extra attempt outside the retry budget.
      // It runs once, only when reasoning is not already off.
      if (lengthFallbackActive || reasoningOff(setting)) {
        break;
      }
      lengthFallbackActive = true;
      reasoning = { kind: "effort", effort: "none" };
      if (attempt === totalAttempts - 1) {
        // Every counted attempt is used, so let the fallback run as the one
        // extra attempt even though it is beyond `retries` (F5-RV1-B1).
        maxAttempts = totalAttempts + 1;
      }
    } else if (attempt === maxAttempts - 1) {
      break;
    }

    const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  const statusSuffix = lastStatus === null ? "" : ` (last status ${lastStatus})`;
  const attemptCount = used.length;
  throw new BugbotModelError(
    `${lastMessage}${statusSuffix} after ${attemptCount} attempt${
      attemptCount === 1 ? "" : "s"
    }`,
    { tokensIn, tokensOut, cost },
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
 * Every complete object in the `findings` array of a reply that was cut off
 * mid-JSON, in order. The scan is string-aware, so braces inside a `reason`
 * do not count. Returns null when no findings array starts at all; an object
 * that was still being written when the reply stopped is left out.
 */
export function salvageFindingItems(raw: string): unknown[] | null {
  const text = raw.trim().replace(/^```(?:json)?[ \t]*\n/i, "");
  const key = /^\s*\{\s*"findings"\s*:\s*\[/.exec(text);
  const start = key !== null ? key[0].length : text.startsWith("[") ? 1 : -1;
  if (start === -1) {
    return null;
  }

  const items: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      if (depth === 0 && char === "{") {
        objectStart = index;
      }
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) {
        // The findings array itself closed.
        break;
      }
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        try {
          items.push(JSON.parse(text.slice(objectStart, index + 1)));
        } catch {
          // A malformed object is skipped; the next one may still parse.
        }
        objectStart = -1;
      }
    }
  }

  return items;
}

/**
 * Parses `{"findings":[...]}` or a bare array, with one optional surrounding
 * Markdown fence. A reply cut off mid-JSON keeps its complete findings and is
 * marked `truncated`. Items that fail FindingSchema are dropped with a short
 * reason and never echoed.
 */
export function parseJsonResponse(raw: string): ParsedFindings {
  let parsed: unknown;
  let truncated = false;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    const salvaged = salvageFindingItems(raw);
    if (salvaged === null || salvaged.length === 0) {
      throw new BugbotModelError("model response was not valid JSON");
    }
    parsed = salvaged;
    truncated = true;
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
    ...(truncated ? { truncated: true as const } : {}),
  };
}
