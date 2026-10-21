import { beforeEach } from "vitest";

/**
 * No test may touch the network. Any accidental fetch fails loudly instead of
 * reaching OpenRouter or GitHub. Tests that need the model inject a fake fetch.
 */
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error("network access is disabled in tests");
  }) as typeof fetch;
});
