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
  /** Output token cap sent as `max_tokens`. Default 8000. */
  maxOutputTokens?: number;
  /** Retries after the first attempt. Default: 2. */
  retries?: number;
  /** Injectable fetch, so tests make no network call. */
  fetch?: FetchLike;
  /** Injectable sleep, so tests do not wait for backoff. */
  sleep?: Sleep;
  /** Per-attempt timeout. Default 120 seconds. */
  timeoutMs?: number;
}

export interface ModelResult {
  /** Raw JSON text returned by the model. Validated by FindingSchema. */
  raw: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
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
  constructor(message: string) {
    super(message);
    this.name = "BugbotModelError";
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 120_000;

const defaultSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function messageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }

  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content.trim() !== "" ? content : null;
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
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const attempts = 1 + retries;

  const body = JSON.stringify({
    model: call.model,
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: call.user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: maxOutputTokens,
  });

  let lastMessage = "OpenRouter request failed";
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = false;

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
        const message = `OpenRouter returned ${response.status}${providerDetail(
          text,
          apiKey,
        )}`;

        if (!isRetryableStatus(response.status)) {
          throw new BugbotModelError(message);
        }

        lastMessage = message;
        lastStatus = response.status;
        retryable = true;
      } else {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          lastMessage = "OpenRouter returned a non-JSON response";
          lastStatus = response.status;
          retryable = true;
          payload = undefined;
        }

        if (payload !== undefined) {
          const content = messageContent(payload);
          if (content === null) {
            lastMessage = "OpenRouter returned no message content";
            lastStatus = response.status;
            retryable = true;
          } else {
            try {
              JSON.parse(content);
            } catch {
              lastMessage = "model response content was not JSON";
              lastStatus = response.status;
              retryable = true;
            }

            if (!retryable) {
              const usage =
                typeof payload === "object" && payload !== null
                  ? (payload as { usage?: unknown }).usage
                  : undefined;
              const model =
                typeof payload === "object" &&
                payload !== null &&
                typeof (payload as { model?: unknown }).model === "string"
                  ? ((payload as { model: string }).model)
                  : call.model;

              return {
                raw: content,
                model,
                tokensIn:
                  typeof usage === "object" && usage !== null
                    ? numberOrZero((usage as { prompt_tokens?: unknown }).prompt_tokens)
                    : 0,
                tokensOut:
                  typeof usage === "object" && usage !== null
                    ? numberOrZero(
                        (usage as { completion_tokens?: unknown }).completion_tokens,
                      )
                    : 0,
              };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof BugbotModelError) {
        throw error;
      }

      if (isAbort(error) || controller.signal.aborted) {
        lastMessage = `OpenRouter request timed out after ${timeoutMs} ms`;
        lastStatus = null;
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        lastMessage = `OpenRouter request failed: ${safeText(reason, apiKey)}`;
        lastStatus = null;
      }
      retryable = true;
    } finally {
      clearTimeout(timer);
    }

    if (!retryable || attempt === attempts - 1) {
      break;
    }

    const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
    await sleep(backoff);
  }

  const statusSuffix = lastStatus === null ? "" : ` (last status ${lastStatus})`;
  throw new BugbotModelError(
    `${lastMessage}${statusSuffix} after ${attempts} attempt${
      attempts === 1 ? "" : "s"
    }`,
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
