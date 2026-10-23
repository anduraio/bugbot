import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BugbotModelError,
  callModel,
  defaultAttemptTimeoutMs,
  modelHonorsReasoningMaxTokens,
  parseJsonResponse,
  scaledAttemptTimeout,
  type FetchLike,
} from "../src/model.js";

const CALL = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  system: "system text",
  user: "user text",
};

function expectedBody(
  model: string,
  maxTokens: number,
  reasoning?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: CALL.system },
      { role: "user", content: CALL.user },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: maxTokens,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function completion(content: string, tokensIn = 100, tokensOut = 20): string {
  return JSON.stringify({
    id: "gen-test",
    model: "deepseek/deepseek-v4.1-flash-1017",
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
  });
}

function ok(content: string, tokensIn?: number, tokensOut?: number): Response {
  return new Response(completion(content, tokensIn, tokensOut), { status: 200 });
}

/** A 200 completion with no content, for length/error/usage tests. */
function emptyStop(
  options: {
    finishReason?: string;
    nativeFinishReason?: string;
    content?: string;
    reasoning?: string;
    tokensIn?: number;
    tokensOut?: number;
    reasoningTokens?: number;
  } = {},
): Response {
  const finishReason = options.finishReason ?? "length";
  return new Response(
    JSON.stringify({
      id: "gen-test",
      model: CALL.model,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          native_finish_reason:
            options.nativeFinishReason ?? finishReason,
          message: {
            role: "assistant",
            content: options.content ?? "",
            ...(options.reasoning === undefined
              ? {}
              : { reasoning: options.reasoning }),
          },
        },
      ],
      usage: {
        prompt_tokens: options.tokensIn ?? 100,
        completion_tokens: options.tokensOut ?? 20,
        completion_tokens_details: {
          reasoning_tokens: options.reasoningTokens ?? 0,
        },
      },
    }),
    { status: 200 },
  );
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/cart.ts",
    line: 48,
    side: "RIGHT",
    severity: "high",
    category: "bug",
    confidence: 0.9,
    reason: "findCustomer can return undefined.",
    angle: "interrogate:correctness",
    symbol: "cartOwnerName",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callModel", () => {
  it("sends temperature 0, json_object, the model id and auth headers", async () => {
    const captured: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const fakeFetch: FetchLike = async (input, init) => {
      captured.push({ input, init });
      return ok('{"findings":[]}');
    };

    await callModel(CALL, {
      apiKey: "sk-test-key",
      maxOutputTokens: 1_234,
      fetch: fakeFetch,
    });

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.input).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request?.init?.method).toBe("POST");

    const headers = request?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
    expect(headers["X-Title"]).toBe("bugbot");

    const body = JSON.parse(String(request?.init?.body)) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(CALL.model);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(1_234);
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("returns usage tokens from the response", async () => {
    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: async () => ok('{"findings":[]}', 4_321, 210),
    });

    expect(result.raw).toBe('{"findings":[]}');
    expect(result.tokensIn).toBe(4_321);
    expect(result.tokensOut).toBe(210);
  });

  it("succeeds after a 429 with one retry", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
        });
      }
      return ok('{"findings":[]}');
    };

    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    expect(result.tokensIn).toBe(100);
  });

  it("fails after exactly three attempts on repeated 500s", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
      });
    };

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(BugbotModelError);

    expect(calls).toBe(3);
  });

  it("fails a 404 on the first attempt", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "no such model" } }), {
        status: 404,
      });
    };

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("404");

    expect(calls).toBe(1);
  });

  it("does not retry a 401", async () => {
    let calls = 0;

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { message: "bad key" } }), {
            status: 401,
          });
        },
      }),
    ).rejects.toThrow("401");

    expect(calls).toBe(1);
  });

  it("retries a 200 whose content is not JSON", async () => {
    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      return ok("this is not json");
    };

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(BugbotModelError);

    expect(calls).toBe(3);
  });

  it("retries a timeout", async () => {    let calls = 0;
    const fakeFetch: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return ok('{"findings":[]}');
    };

    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      sleep: async () => undefined,
    });

    expect(calls).toBe(2);
    expect(result.raw).toBe('{"findings":[]}');
  });

  it("aborts each attempt through the per-attempt signal", async () => {
    let calls = 0;
    let aborts = 0;
    const fakeFetch: FetchLike = (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void => {
          aborts += 1;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    };

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
        timeoutMs: 10,
      }),
    ).rejects.toThrow("timed out");

    expect(calls).toBe(3);
    expect(aborts).toBe(3);
  });

  it("scales the attempt timeout with the cap and bounds it at 1800 s (F23-RV1-N3, fix5b)", () => {
    expect(scaledAttemptTimeout(120_000, 8_000, 8_000)).toBe(120_000);
    expect(scaledAttemptTimeout(120_000, 16_000, 8_000)).toBe(240_000);
    expect(scaledAttemptTimeout(120_000, 32_000, 8_000)).toBe(480_000);
    expect(scaledAttemptTimeout(120_000, 160_000, 8_000)).toBe(1_800_000);
    expect(scaledAttemptTimeout(10, 2_000, 2_000)).toBe(10);
  });

  it("derives the per-attempt timeout from the cap at 80 tokens/s (fix5b)", () => {
    // A 64000-token reply at the measured ~90 tokens/s needs about 12 min,
    // and 80 tokens/s gives it about 13 min.
    expect(defaultAttemptTimeoutMs(64_000)).toBe(800_000);
    expect(defaultAttemptTimeoutMs(128_000)).toBe(1_600_000);
    expect(defaultAttemptTimeoutMs(2_000)).toBe(120_000);
    expect(defaultAttemptTimeoutMs(160_000)).toBe(1_800_000);
  });

  it("keeps the same cap and timeout for the reasoning-off retry (fix5b)", async () => {
    const bodies: Array<{
      max_tokens: number;
      reasoning?: Record<string, unknown>;
    }> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body)) as {
          max_tokens: number;
          reasoning?: Record<string, unknown>;
        },
      );
      if (bodies.length === 1) {
        return emptyStop({
          reasoning: "hidden reasoning",
          tokensIn: 900,
          tokensOut: 8_000,
        });
      }
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };

    let caught: unknown;
    try {
      await callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
        maxOutputTokens: 8_000,
        timeoutMs: 10,
        log: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(bodies.map((body) => body.max_tokens)).toEqual([
      8_000, 8_000, 8_000,
    ]);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high" });
    expect(bodies[1]?.reasoning).toEqual({ effort: "none" });
    expect(bodies[2]?.reasoning).toEqual({ effort: "none" });
    // The cap does not grow, so the retry keeps the same 10 ms timeout.
    expect(message).toContain("timed out after 10 ms");
    expect(message).toContain(
      "whole 8000-token output budget on reasoning",
    );
    expect(caught).toMatchObject({ tokensIn: 900, tokensOut: 8_000 });
  });

  it("clamps provider usage to non-negative safe integers (F23-RV1-N7)", async () => {
    const response = new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: "length",
            message: { role: "assistant", content: "" },
          },
        ],
        usage: { prompt_tokens: -5, completion_tokens: 1e300 },
      }),
      { status: 200 },
    );

    let caught: unknown;
    try {
      await callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: async () => response,
        retries: 0,
        log: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      tokensIn: 0,
      tokensOut: Number.MAX_SAFE_INTEGER,
    });
  });

  it("redacts and caps the provider error message in the log and the error (M8)", async () => {
    const key = "sk-test-provider-secret";
    const logs: string[] = [];
    const response = new Response(
      JSON.stringify({
        error: { code: 502, message: `bad key ${key} ${"x".repeat(5_000)}` },
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      }),
      { status: 200 },
    );

    let message = "";
    try {
      await callModel(CALL, {
        apiKey: key,
        fetch: async () => response,
        retries: 0,
        log: (line) => logs.push(line),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(key);
    expect(message).toContain("bad key [redacted]");
    expect(message.length).toBeLessThan(500);
    const diagnostic = logs.find((line) => line.includes("error_message="));
    expect(diagnostic).toBeDefined();
    expect(logs.join("\n")).not.toContain(key);
    expect(diagnostic).toContain("error_message=bad key [redacted]");
    expect((diagnostic ?? "").length).toBeLessThan(500);
  });

  it("does not grow the cap after a provider error inside a 200 body (M3)", async () => {
    const caps: number[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      caps.push(
        (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens,
      );
      if (caps.length === 1) {
        return new Response(
          JSON.stringify({
            error: { code: 502, message: "upstream" },
            choices: [
              {
                index: 0,
                finish_reason: "length",
                message: { role: "assistant", content: "" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return ok('{"findings":[]}');
    };

    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      retries: 1,
      maxOutputTokens: 8_000,
      sleep: async () => undefined,
      log: () => undefined,
    });

    expect(caps).toEqual([8_000, 8_000]);
  });

  it("sends effort high by default and turns it off on the one length retry (fix5b)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return emptyStop({
          reasoning: "hidden chain of thought",
          tokensIn: 900,
          tokensOut: 64_000,
          reasoningTokens: 63_000,
        });
      }
      return ok('{"findings":[]}', 100, 20);
    };

    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      sleep: async () => undefined,
      log: (line) => logs.push(line),
    });

    expect(bodies).toEqual([
      expectedBody(CALL.model, 64_000, { effort: "high" }),
      expectedBody(CALL.model, 64_000, { effort: "none" }),
    ]);
    // Usage is summed over both attempts, including the empty one.
    expect(result.tokensIn).toBe(1_000);
    expect(result.tokensOut).toBe(64_020);
    expect(result.attempts).toEqual([
      {
        attempt: 1,
        maxTokens: 64_000,
        reasoning: "effort=high",
        tokensIn: 900,
        tokensOut: 64_000,
        reasoningTokens: 63_000,
        outcome: "length",
      },
      {
        attempt: 2,
        maxTokens: 64_000,
        reasoning: "effort=none",
        tokensIn: 100,
        tokensOut: 20,
        reasoningTokens: 0,
        outcome: "none",
      },
    ]);
    expect(logs).toContain(
      "OpenRouter attempt 1/3: max_tokens=64000 reasoning=effort=high",
    );
    expect(logs).toContain(
      "OpenRouter attempt 2/3: max_tokens=64000 reasoning=effort=none",
    );
    for (const line of logs) {
      expect(line).not.toContain("hidden chain of thought");
    }
  });

  it("sends reasoning_effort medium on attempt 1 and none on the length retry (fix5b)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? emptyStop({ tokensIn: 900, tokensOut: 64_000 })
        : ok('{"findings":[]}', 100, 20);
    };

    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      reasoningEffort: "medium",
      sleep: async () => undefined,
      log: () => undefined,
    });

    expect(bodies).toEqual([
      expectedBody(CALL.model, 64_000, { effort: "medium" }),
      expectedBody(CALL.model, 64_000, { effort: "none" }),
    ]);
  });

  it("sends a configured budget then turns it off for an allow-listed model (fix5b)", async () => {
    const model = "anthropic/claude-sonnet-4";
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? emptyStop({ reasoning: "hidden", tokensIn: 500, tokensOut: 64_000 })
        : ok('{"findings":[]}', 100, 20);
    };

    const result = await callModel(
      { ...CALL, model },
      {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        reasoningMaxTokens: 8_000,
        sleep: async () => undefined,
        log: () => undefined,
      },
    );

    expect(bodies).toEqual([
      expectedBody(model, 64_000, { max_tokens: 8_000 }),
      expectedBody(model, 64_000, { effort: "none" }),
    ]);
    expect(result.attempts.map((attempt) => attempt.reasoning)).toEqual([
      "max_tokens=8000",
      "effort=none",
    ]);
    expect(result.tokensIn).toBe(600);
    expect(result.tokensOut).toBe(64_020);
  });

  it("sends a configured 1024 budget, then off on the retry (fix5b)", async () => {
    const model = "qwen/qwen3-235b-a22b";
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? emptyStop()
        : ok('{"findings":[]}');
    };

    await callModel(
      { ...CALL, model },
      {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        maxOutputTokens: 8_000,
        reasoningMaxTokens: 1_024,
        sleep: async () => undefined,
        log: () => undefined,
      },
    );

    expect(bodies[0]?.reasoning).toEqual({ max_tokens: 1_024 });
    expect(bodies[1]?.reasoning).toEqual({ effort: "none" });
    expect(bodies[1]?.max_tokens).toBe(8_000);
  });

  it("only sends reasoning.max_tokens to the allow-listed model families", () => {
    expect(modelHonorsReasoningMaxTokens("anthropic/claude-sonnet-4")).toBe(true);
    expect(modelHonorsReasoningMaxTokens("google/gemini-2.5-pro")).toBe(true);
    expect(modelHonorsReasoningMaxTokens("qwen/qwen3-235b-a22b")).toBe(true);
    expect(modelHonorsReasoningMaxTokens("deepseek/deepseek-v4.1-flash")).toBe(
      false,
    );
    expect(modelHonorsReasoningMaxTokens("openai/gpt-5")).toBe(false);
    expect(modelHonorsReasoningMaxTokens("meta-llama/llama-4")).toBe(false);
  });

  it("ignores a budget for an effort-only model and still sends effort high (fix5b)", async () => {
    let body: Record<string, unknown> = {};
    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok('{"findings":[]}');
      },
      reasoningMaxTokens: 4_000,
    });

    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(64_000);
  });

  it("prefers the effort over a budget for an effort-only model (fix5b)", async () => {
    let body: Record<string, unknown> = {};
    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok('{"findings":[]}');
      },
      reasoningEffort: "high",
      reasoningMaxTokens: 4_000,
    });

    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("keeps the same cap on a length retry (M6, fix5b)", async () => {
    const caps: number[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      caps.push(
        (JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens,
      );
      return emptyStop();
    };

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(BugbotModelError);

    expect(caps).toEqual([64_000, 64_000]);
  });

  it("never puts the key in an error message or a logged line", async () => {
    const key = "test-key-super-secret-value";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const fakeFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({ error: { message: `invalid key ${key} supplied` } }),
        { status: 401 },
      );

    let message = "";
    let caught: unknown;
    try {
      await callModel(CALL, { apiKey: key, fetch: fakeFetch });
    } catch (error) {
      caught = error;
      message = error instanceof Error ? error.message : String(error);
    }

    const error = caught as Error;
    expect(message).not.toContain(key);
    expect(message).toContain("[redacted]");
    expect(String(error.cause)).not.toContain(key);
    expect(String(error.stack)).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);
  });

  it("throws before any fetch when the key is missing", async () => {
    let calls = 0;

    await expect(
      callModel(CALL, {
        fetch: async () => {
          calls += 1;
          return ok('{"findings":[]}');
        },
      }),
    ).rejects.toThrow("OPENROUTER_API_KEY is not set");

    expect(calls).toBe(0);
  });

  it("retries the same cap with reasoning off after an empty length stop", async () => {
    const bodies: Array<{
      max_tokens: number;
      reasoning?: { effort: string };
    }> = [];
    const logs: string[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body)) as {
          max_tokens: number;
          reasoning?: { effort: string };
        },
      );
      if (bodies.length === 1) {
        return emptyStop({
          reasoning: "hidden chain of thought",
          tokensIn: 900,
          tokensOut: 64_000,
          reasoningTokens: 63_000,
        });
      }
      return ok('{"findings":[]}', 100, 20);
    };

    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      sleep: async () => undefined,
      log: (line) => logs.push(line),
    });

    expect(bodies.map((body) => body.max_tokens)).toEqual([64_000, 64_000]);
    expect(bodies[0]?.reasoning).toEqual({ effort: "high" });
    expect(bodies[1]?.reasoning).toEqual({ effort: "none" });
    // The empty attempt's usage still counts: 100 + 900 in, 20 + 64,000 out.
    expect(result.tokensIn).toBe(1_000);
    expect(result.tokensOut).toBe(64_020);
    const diagnostics = logs.filter((line) =>
      line.includes("OpenRouter empty completion:"),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(" finish_reason=length");
    expect(diagnostics[0]).toContain("native_finish_reason=length");
    expect(diagnostics[0]).toContain("reasoning_chars=23");
    expect(diagnostics[0]).toContain("reasoning_tokens=63000");
    expect(diagnostics[0]).toContain("reasoning=effort=high");
    expect(logs.join("\n")).not.toContain("hidden chain of thought");
  });

  it("names the reasoning budget when every attempt stops on length", async () => {
    const bodies: Array<{ max_tokens: number }> = [];
    let caught: unknown;
    const logs: string[] = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body)) as { max_tokens: number },
      );
      return emptyStop({ reasoning: "reasoning", tokensIn: 900, tokensOut: 8_000 });
    };

    try {
      await callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: fakeFetch,
        sleep: async () => undefined,
        log: (line) => logs.push(line),
      });
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(bodies.map((body) => body.max_tokens)).toEqual([
      64_000, 64_000,
    ]);
    expect(message).toContain("whole 64000-token output budget on reasoning");
    expect(message).toContain('finish_reason "length"');
    expect(message).toContain("raise `max_output_tokens`");
    expect(message).toContain("after 2 attempts");
    expect(caught).toBeInstanceOf(BugbotModelError);
    expect(caught).toMatchObject({ tokensIn: 1_800, tokensOut: 16_000 });
    expect(
      (caught as BugbotModelError).attempts.map((attempt) => ({
        maxTokens: attempt.maxTokens,
        reasoning: attempt.reasoning,
      })),
    ).toEqual([
      { maxTokens: 64_000, reasoning: "effort=high" },
      { maxTokens: 64_000, reasoning: "effort=none" },
    ]);
    const diagnostics = logs.filter((line) =>
      line.includes("OpenRouter empty completion:"),
    );
    expect(diagnostics).toHaveLength(2);
    for (const line of diagnostics) {
      expect(line).toContain(" finish_reason=length");
    }
    expect(logs).toHaveLength(4);
  });

  it("reports a provider error inside a 200 body and logs its code", async () => {
    const logs: string[] = [];
    const response = new Response(
      JSON.stringify({
        error: { code: 502, message: "upstream exploded" },
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
        usage: { prompt_tokens: 12, completion_tokens: 0 },
      }),
      { status: 200 },
    );

    await expect(
      callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: async () => response,
        retries: 0,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow(
      "OpenRouter returned an error inside a 200 response: 502 upstream exploded",
    );

    const diagnostic = logs.find((line) => line.includes("error_code=502"));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain("error_message=upstream exploded");
    expect(diagnostic).toContain(" finish_reason=none");
  });

  it("counts usage from an empty reply on the thrown error", async () => {
    let caught: unknown;

    try {
      await callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: async () =>
          emptyStop({ tokensIn: 4_321, tokensOut: 8_000, reasoningTokens: 7_500 }),
        retries: 0,
        log: () => undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BugbotModelError);
    expect(caught).toMatchObject({ tokensIn: 4_321, tokensOut: 8_000 });
  });

  it("never logs prompt or reasoning text", async () => {
    const system = "SYSTEM-PROMPT-SECRET";
    const user = "USER-PROMPT-SECRET";
    const reasoning = "REASONING-TEXT-SECRET";
    const logs: string[] = [];

    await expect(
      callModel(
        { ...CALL, system, user },
        {
          apiKey: "sk-test-key",
          fetch: async () => emptyStop({ reasoning }),
          retries: 0,
          log: (line) => logs.push(line),
        },
      ),
    ).rejects.toBeInstanceOf(BugbotModelError);

    const diagnostic = logs.find((line) =>
      line.includes(`reasoning_chars=${reasoning.length}`),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain(`reasoning_chars=${reasoning.length}`);
    expect(logs.join("\n")).not.toContain(system);
    expect(logs.join("\n")).not.toContain(user);
    expect(logs.join("\n")).not.toContain(reasoning);
  });

  it("sends an explicit reasoning effort when one is configured", async () => {
    let body: { reasoning?: { effort: string } } = {};

    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as {
          reasoning?: { effort: string };
        };
        return ok('{"findings":[]}');
      },
      reasoningEffort: "high",
    });

    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("respects a max reasoning effort override on attempt 1 (fix5)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? emptyStop()
        : ok('{"findings":[]}');
    };

    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      maxOutputTokens: 8_000,
      reasoningEffort: "max",
      sleep: async () => undefined,
      log: () => undefined,
    });

    // Attempt 1 honors the override; the single length retry still answers
    // with reasoning off.
    expect(bodies[0]?.reasoning).toEqual({ effort: "max" });
    expect(bodies[1]?.reasoning).toEqual({ effort: "none" });
    expect(bodies[1]?.max_tokens).toBe(8_000);
  });

  it("accepts every documented effort, including xhigh and minimal (fix5b)", async () => {
    for (const effort of [
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ] as const) {
      let body: Record<string, unknown> = {};
      await callModel(CALL, {
        apiKey: "sk-test-key",
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return ok('{"findings":[]}');
        },
        reasoningEffort: effort,
        retries: 0,
      });

      expect(body.reasoning).toEqual({ effort });
    }
  });

  it("sends the budget, not the effort, for an allow-listed model when both are set (fix5b)", async () => {
    let body: Record<string, unknown> = {};
    await callModel(
      { ...CALL, model: "anthropic/claude-sonnet-4" },
      {
        apiKey: "sk-test-key",
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return ok('{"findings":[]}');
        },
        reasoningEffort: "high",
        reasoningMaxTokens: 4_000,
        retries: 0,
      },
    );

    expect(body.reasoning).toEqual({ max_tokens: 4_000 });
  });
});

describe("parseJsonResponse", () => {
  it("strips one surrounding json fence", () => {
    const raw = '```json\n{"findings":[]}\n```';

    expect(parseJsonResponse(raw)).toEqual({
      findings: [],
      dropped: { count: 0, reasons: [] },
    });
  });

  it("accepts a bare array", () => {
    const parsed = parseJsonResponse(JSON.stringify([finding()]));

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.file).toBe("src/cart.ts");
    expect(parsed.findings[0]?.side).toBe("RIGHT");
    expect(parsed.dropped.count).toBe(0);
  });

  it("accepts an object with findings", () => {
    const parsed = parseJsonResponse(JSON.stringify({ findings: [finding()] }));

    expect(parsed.findings).toHaveLength(1);
  });

  it("drops invalid items with a count and a short reason", () => {
    const parsed = parseJsonResponse(
      JSON.stringify({
        findings: [
          finding(),
          finding({ severity: "critical" }),
          finding({ file: "" }),
        ],
      }),
    );

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.dropped.count).toBe(2);
    expect(parsed.dropped.reasons).toHaveLength(2);
    for (const reason of parsed.dropped.reasons) {
      expect(reason).not.toContain("critical");
      expect(reason.length).toBeLessThanOrEqual(200);
    }
  });

  it("throws on non-JSON", () => {
    expect(() => parseJsonResponse("nope")).toThrow(BugbotModelError);
  });

  it("throws when the object has no findings array", () => {
    expect(() => parseJsonResponse('{"data":[]}')).toThrow(BugbotModelError);
  });
});
