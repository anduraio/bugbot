#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fetchPullRequest, reportSkipped, type GitHubOptions } from "./github.js";
import { pullRequestFromEvent, shouldReview } from "./gate.js";

/**
 * `bugbot review|status` (spec section 8). Step 2 ships only the command
 * surface: every path prints a neutral message and exits 0, so a skeleton run
 * can never fail a PR. Step 4 wires the pipeline; step 6 adds the GitHub
 * output.
 */

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print a neutral line and mirror it to the job summary when one exists. */
function report(line: string): void {
  console.log(line);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === "") {
    return;
  }

  try {
    appendFileSync(summaryPath, `${line}\n`);
  } catch {
    // The job summary is best effort; never fail the PR over it.
  }
}

export async function review(_args: readonly string[] = []): Promise<number> {
  const repository = env("BUGBOT_REPOSITORY");
  const prNumber = Number.parseInt(env("BUGBOT_PR_NUMBER"), 10);
  const runId = env("BUGBOT_RUN_ID");
  const token = env("GITHUB_TOKEN");
  const draftLabel = env("BUGBOT_DRAFT_LABEL") || "bugbot";
  const eventHeadSha = env("BUGBOT_HEAD_SHA");

  if (repository === "" || !Number.isInteger(prNumber) || prNumber <= 0) {
    report(
      "Bugbot couldn't review: BUGBOT_REPOSITORY and BUGBOT_PR_NUMBER are required.",
    );
    return 0;
  }

  try {
    // A pull_request event carries draft, fork and labels, so the CLI applies
    // the same gate from that payload without an API call. Only when the event
    // has no PR data (workflow_dispatch, or a direct action.yml call) does it
    // fetch the PR from the API.
    const pr =
      pullRequestFromEvent({
        draft: env("BUGBOT_PR_DRAFT"),
        fork: env("BUGBOT_PR_FORK"),
        labels: env("BUGBOT_PR_LABELS"),
        headSha: eventHeadSha,
        number: prNumber,
      }) ?? (await fetchPullRequest({ token, repository, prNumber }));

    const gate = shouldReview(pr, { label: draftLabel });
    if (!gate.review) {
      report(gate.summary);
      const options: GitHubOptions = {
        token,
        repository,
        prNumber,
        headSha: pr.headSha,
        runId,
      };

      try {
        await reportSkipped(options, gate.summary);
      } catch {
        // Step 6 turns this into a completed neutral `bugbot` check run; the
        // job summary in review.yml is the visible result until then.
      }

      return 0;
    }

    report(
      "Bugbot couldn't review: step 2 skeleton, the review pipeline is not implemented.",
    );
    return 0;
  } catch (error) {
    report(`Bugbot couldn't review: ${errorMessage(error)}`);
    return 0;
  }
}

export async function status(_args: readonly string[] = []): Promise<number> {
  console.log("Bugbot status: step 2 skeleton, status is not implemented.");
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;

  switch (command) {
    case "review":
      return review(args);
    case "status":
      return status(args);
    default:
      console.error(
        "usage: bugbot review [<pr-url|number>] [--local] | bugbot status <pr-url|number>",
      );
      return 2;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
