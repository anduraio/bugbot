import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BugbotModelError,
  callModel,
  parseJsonResponse,
  scaledAttemptTimeout,
  type FetchLike,
} from "../src/model.js";

const CALL = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  system: "system text",
  user: "user text",
};

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

  it("scales the attempt timeout with the cap and bounds it at 300 s (F23-RV1-N3)", () => {
    expect(scaledAttemptTimeout(120_000, 8_000, 8_000)).toBe(120_000);
    expect(scaledAttemptTimeout(120_000, 16_000, 8_000)).toBe(240_000);
    expect(scaledAttemptTimeout(120_000, 32_000, 8_000)).toBe(300_000);
    expect(scaledAttemptTimeout(10, 2_000, 2_000)).toBe(10);
  });

  it("gives the 32000 rung more time and keeps the earlier length diagnosis", async () => {
    const bodies: Array<{ max_tokens: number }> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as { max_tokens: number });
      if (bodies.length <= 2) {
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
      8_000, 16_000, 32_000,
    ]);
    // 10 ms at 8000 becomes 40 ms at 32000.
    expect(message).toContain("timed out after 40 ms");
    expect(message).toContain(
      "whole 16000-token output budget on reasoning",
    );
    expect(caught).toMatchObject({ tokensIn: 1_800, tokensOut: 16_000 });
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
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(key);
    expect(logs[0]).toContain("error_message=bad key [redacted]");
    expect((logs[0] ?? "").length).toBeLessThan(500);
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

  it("sends no reasoning field when no reasoning was seen (M4)", async () => {
    const bodies: Array<{ max_tokens: number; reasoning?: unknown }> = [];
    const fakeFetch: FetchLike = async (_input, init) => {
      bodies.push(
        JSON.parse(String(init?.body)) as {
          max_tokens: number;
          reasoning?: unknown;
        },
      );
      return bodies.length === 1 ? emptyStop() : ok('{"findings":[]}');
    };

    await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      maxOutputTokens: 8_000,
      sleep: async () => undefined,
      log: () => undefined,
    });

    expect(bodies.map((body) => body.max_tokens)).toEqual([8_000, 16_000]);
    expect(bodies[1]?.reasoning).toBeUndefined();
  });

  it("never grows the cap past the ceiling (M6)", async () => {
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
        maxOutputTokens: 8_000,
        maxOutputTokensCeiling: 10_000,
        sleep: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(BugbotModelError);

    expect(caps).toEqual([8_000, 10_000, 10_000]);
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

  it("doubles the cap and bounds reasoning after an empty length stop", async () => {
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
          tokensOut: 8_000,
          reasoningTokens: 7_900,
        });
      }
      return ok('{"findings":[]}', 100, 20);
    };

    const result = await callModel(CALL, {
      apiKey: "sk-test-key",
      fetch: fakeFetch,
      sleep: async () => undefined,
      maxOutputTokens: 8_000,
      log: (line) => logs.push(line),
    });

    expect(bodies.map((body) => body.max_tokens)).toEqual([8_000, 16_000]);
    expect(bodies[0]?.reasoning).toBeUndefined();
    expect(bodies[1]?.reasoning).toEqual({ effort: "low" });
    // The empty attempt's usage still counts: 100 + 900 in, 20 + 8,000 out.
    expect(result.tokensIn).toBe(1_000);
    expect(result.tokensOut).toBe(8_020);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(" finish_reason=length");
    expect(logs[0]).toContain("native_finish_reason=length");
    expect(logs[0]).toContain("reasoning_chars=23");
    expect(logs[0]).toContain("reasoning_tokens=7900");
    expect(logs[0]).not.toContain("hidden chain of thought");
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
        maxOutputTokens: 8_000,
        log: (line) => logs.push(line),
      });
    } catch (error) {
      caught = error;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    expect(bodies.map((body) => body.max_tokens)).toEqual([
      8_000, 16_000, 32_000,
    ]);
    expect(message).toContain("whole 32000-token output budget on reasoning");
    expect(message).toContain('finish_reason "length"');
    expect(message).toContain("raise `max_output_tokens`");
    expect(message).toContain("after 3 attempts");
    expect(caught).toBeInstanceOf(BugbotModelError);
    expect(caught).toMatchObject({ tokensIn: 2_700, tokensOut: 24_000 });
    expect(logs).toHaveLength(3);
    for (const line of logs) {
      expect(line).toContain(" finish_reason=length");
    }
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

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("error_code=502");
    expect(logs[0]).toContain("error_message=upstream exploded");
    expect(logs[0]).toContain(" finish_reason=none");
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

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`reasoning_chars=${reasoning.length}`);
    expect(logs[0]).not.toContain(system);
    expect(logs[0]).not.toContain(user);
    expect(logs[0]).not.toContain(reasoning);
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
