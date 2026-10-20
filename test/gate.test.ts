import { describe, expect, it } from "vitest";
import {
  pullRequestFromEvent,
  shouldReview,
  type PullRequestGateState,
} from "../src/gate.js";

function pr(overrides: Partial<PullRequestGateState> = {}): PullRequestGateState {
  return { draft: false, fork: false, labels: [], ...overrides };
}

describe("shouldReview", () => {
  it("reviews a normal PR", () => {
    expect(shouldReview(pr(), { label: "bugbot" })).toEqual({ review: true });
  });

  it("skips a fork with a visible summary", () => {
    expect(shouldReview(pr({ fork: true }), { label: "bugbot" })).toEqual({
      review: false,
      reason: "fork",
      summary: "Bugbot skipped: fork",
    });
  });

  it("skips a draft without the label", () => {
    expect(shouldReview(pr({ draft: true }), { label: "bugbot" })).toEqual({
      review: false,
      reason: "draft",
      summary: "Bugbot skipped: draft",
    });
  });

  it("reviews a draft that carries the label", () => {
    expect(
      shouldReview(pr({ draft: true, labels: ["bugbot"] }), { label: "bugbot" }),
    ).toEqual({ review: true });
  });

  it("uses the configured label, not a hardcoded one", () => {
    expect(
      shouldReview(pr({ draft: true, labels: ["review-me"] }), { label: "review-me" }),
    ).toEqual({ review: true });
  });

  it("skips a fork even when it carries the label", () => {
    expect(
      shouldReview(pr({ fork: true, draft: true, labels: ["bugbot"] }), {
        label: "bugbot",
      }),
    ).toEqual({
      review: false,
      reason: "fork",
      summary: "Bugbot skipped: fork",
    });
  });

  it("matches the label case-insensitively, like the workflow gate", () => {
    expect(
      shouldReview(pr({ draft: true, labels: ["Bugbot"] }), { label: "bugbot" }),
    ).toEqual({ review: true });
  });
});

describe("pullRequestFromEvent", () => {
  const event = {
    draft: "false",
    fork: "false",
    labels: "",
    headSha: "abc123",
    number: 7,
  };

  it("returns null when the event has no pull_request payload", () => {
    expect(pullRequestFromEvent({ ...event, draft: "", fork: "" })).toBeNull();
  });

  it("reads draft and fork from the event strings", () => {
    expect(
      pullRequestFromEvent({ ...event, draft: "true", fork: "true" }),
    ).toEqual({ number: 7, headSha: "abc123", draft: true, fork: true, labels: [] });
  });

  it("parses the JSON labels the workflow passes", () => {
    expect(
      pullRequestFromEvent({
        ...event,
        labels: JSON.stringify(["bugbot", "review-me"]),
      }),
    ).toEqual({
      number: 7,
      headSha: "abc123",
      draft: false,
      fork: false,
      labels: ["bugbot", "review-me"],
    });
  });

  it("keeps a label containing a comma in one piece", () => {
    // toJSON pretty-prints, so the env value can span lines.
    const state = pullRequestFromEvent({
      ...event,
      draft: "true",
      labels: JSON.stringify(["needs, review"], null, 2),
    });

    if (state === null) {
      throw new Error("expected a pull request event state");
    }

    expect(state.labels).toEqual(["needs, review"]);
    expect(shouldReview(state, { label: "needs, review" })).toEqual({
      review: true,
    });
  });

  it("treats empty, null and non-array label values as no labels", () => {
    for (const labels of ["", "null", '"bugbot"']) {
      expect(pullRequestFromEvent({ ...event, labels })?.labels).toEqual([]);
    }
  });

  it("gates a draft event exactly like the workflow", () => {
    const state = pullRequestFromEvent({ ...event, draft: "true" });
    if (state === null) {
      throw new Error("expected a pull request event state");
    }

    expect(shouldReview(state, { label: "bugbot" })).toEqual({
      review: false,
      reason: "draft",
      summary: "Bugbot skipped: draft",
    });
  });
});
