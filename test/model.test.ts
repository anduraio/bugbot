import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BugbotModelError,
  callModel,
  parseJsonResponse,
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

  it("retries a timeout", async () => {
    let calls = 0;
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
