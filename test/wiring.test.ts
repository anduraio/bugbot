import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { diffLineTexts } from "../src/context.js";
import { runLocalReview } from "../src/cli.js";

// The local pass has no existing threads, so its lineTextFor wiring cannot
// change a posted comment. Spy on the real map instead: removing the wiring
// drops the call to zero (S8D-R2-N5).
vi.mock("../src/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/context.js")>();
  return { ...actual, diffLineTexts: vi.fn(actual.diffLineTexts) };
});

const fixtureDir = fileURLToPath(new URL("./fixtures/local/", import.meta.url));
const modelResponse = readFileSync(
  join(fixtureDir, "model-response.json"),
  "utf8",
);

describe("lineTextFor wiring", () => {
  it("passes the diff's line text to the local classify call (S8D-R2-N5)", async () => {
    const spy = vi.mocked(diffLineTexts);
    spy.mockClear();

    const result = await runLocalReview(
      { diffPath: join(fixtureDir, "change.diff"), repoDir: fixtureDir },
      {
        fetch: async () => new Response(modelResponse, { status: 200 }),
        env: (name) => (name === "OPENROUTER_API_KEY" ? "test-key" : ""),
        log: () => undefined,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("max_output_tokens wiring", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));

  it("declares the input and forwards it as BUGBOT_MAX_OUTPUT_TOKENS", () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    expect(action).toContain("max_output_tokens:");
    expect(action).toContain(
      "BUGBOT_MAX_OUTPUT_TOKENS: ${{ inputs.max_output_tokens }}",
    );

    const workflow = readFileSync(
      join(root, ".github/workflows/review.yml"),
      "utf8",
    );
    expect(workflow.match(/^      max_output_tokens:/gm)).toHaveLength(2);
    expect(workflow).toContain(
      "max_output_tokens: ${{ inputs.max_output_tokens }}",
    );
  });

  it("declares reasoning_max_tokens and forwards it (fix5)", () => {
    const action = readFileSync(join(root, "action.yml"), "utf8");
    expect(action).toContain("reasoning_max_tokens:");
    expect(action).toContain(
      "BUGBOT_REASONING_MAX_TOKENS: ${{ inputs.reasoning_max_tokens }}",
    );

    const workflow = readFileSync(
      join(root, ".github/workflows/review.yml"),
      "utf8",
    );
    expect(workflow.match(/^      reasoning_max_tokens:/gm)).toHaveLength(2);
    expect(workflow).toContain(
      "reasoning_max_tokens: ${{ inputs.reasoning_max_tokens }}",
    );
  });
});
