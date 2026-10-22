import { execFile } from "node:child_process";

/**
 * The `gh` CLI surface for `bugbot review <pr>` and `bugbot status <pr>`.
 *
 * Everything here is read-only except the single `gh workflow run` in
 * `runRemoteReview`. Auth is whatever `gh` already has: this module never
 * reads, accepts or prints a token. Every call goes through one injectable
 * runner that takes an argument array, so user text is never interpolated
 * into a shell string.
 */

export interface GhResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** The one GitHub runner both commands share. It receives argv, never a shell line. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

export class GhError extends Error {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;

  constructor(
    args: readonly string[],
    stdout: string,
    stderr: string,
    code: number,
  ) {
    super(
      `gh ${args.join(" ")} failed: ${oneLine(stderr || stdout || `exit ${code}`)}`,
    );
    this.name = "GhError";
    this.args = args;
    this.stdout = stdout;
    this.stderr = stderr;
    this.code = code;
  }
}

/** Real runner: spawn `gh` with an argument array. Never a shell. */
export const execFileGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      [...args],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const raw = (error as { code?: unknown }).code;
          const code = typeof raw === "number" ? raw : 1;
          // spawn reports ENOENT with an empty stderr; keep the real cause.
          const reason =
            raw === "ENOENT" ? "gh was not found on PATH" : stderr;
          reject(new GhError(args, stdout, reason, code));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

export interface CommandDeps {
  readonly gh?: GhRunner;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* Pull request argument                                               */
/* ------------------------------------------------------------------ */

export interface PullRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** A parsed argument that may still need `gh repo view` for the repository. */
export interface PullSpec {
  readonly owner?: string;
  readonly repo?: string;
  readonly number: number;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PR_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]*)\/?$/;
const OWNER_REPO_HASH_RE =
  /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]*)$/;
const NUMBER_RE = /^[1-9][0-9]*$/;

/** Every PR form must produce a safe integer, not a rounded one (N3). */
function safeNumber(text: string, input: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw invalidPull(input);
  }
  return value;
}

function validOwner(owner: string): boolean {
  return OWNER_RE.test(owner) && !owner.includes("..");
}

function validRepo(repo: string): boolean {
  return (
    REPO_RE.test(repo) &&
    !repo.includes("..") &&
    repo !== "." &&
    repo !== ".."
  );
}

function invalidPull(input: string): Error {
  return new Error(
    `invalid pull request ${JSON.stringify(input)}: expected ` +
      "https://github.com/<owner>/<repo>/pull/<n>, <owner>/<repo>#<n>, " +
      "or a number with --repo <owner>/<repo>",
  );
}

/**
 * Parses the shared PR argument. A bare number keeps `owner`/`repo` empty so
 * the caller can resolve them with `gh repo view` in the cwd.
 */
export function parsePullSpec(
  input: string,
  repoOption?: string | null,
): PullSpec {
  if (typeof input !== "string" || input === "") {
    throw invalidPull(input ?? "");
  }

  const url = PR_URL_RE.exec(input);
  if (url !== null) {
    const [, owner, repo, number] = url;
    if (
      owner === undefined ||
      repo === undefined ||
      number === undefined ||
      !validOwner(owner) ||
      !validRepo(repo)
    ) {
      throw invalidPull(input);
    }
    if (repoOption !== undefined && repoOption !== null) {
      throw new Error("--repo is only for a bare pull request number");
    }
    return { owner, repo, number: safeNumber(number, input) };
  }

  const shorthand = OWNER_REPO_HASH_RE.exec(input);
  if (shorthand !== null) {
    const [, owner, repo, number] = shorthand;
    if (
      owner === undefined ||
      repo === undefined ||
      number === undefined ||
      !validOwner(owner) ||
      !validRepo(repo)
    ) {
      throw invalidPull(input);
    }
    if (repoOption !== undefined && repoOption !== null) {
      throw new Error("--repo is only for a bare pull request number");
    }
    return { owner, repo, number: safeNumber(number, input) };
  }

  if (NUMBER_RE.test(input)) {
    const number = Number(input);
    if (!Number.isSafeInteger(number)) {
      throw invalidPull(input);
    }
    if (repoOption === undefined || repoOption === null) {
      return { number };
    }
    const match = /^([^#\s]+)\/([^#\s]+)$/.exec(repoOption);
    const [, owner, repo] = match ?? [];
    if (
      match === null ||
      owner === undefined ||
      repo === undefined ||
      !validOwner(owner) ||
      !validRepo(repo)
    ) {
      throw invalidPull(repoOption);
    }
    return { owner, repo, number };
  }

  throw invalidPull(input);
}

/** Fills a bare-number spec from `gh repo view --json nameWithOwner` in cwd. */
export async function resolvePull(
  spec: PullSpec,
  gh: GhRunner,
): Promise<PullRef> {
  if (spec.owner !== undefined && spec.repo !== undefined) {
    return { owner: spec.owner, repo: spec.repo, number: spec.number };
  }

  const result = await gh(["repo", "view", "--json", "nameWithOwner"]);
  let name: unknown;
  try {
    name = (JSON.parse(result.stdout) as { nameWithOwner?: unknown })
      .nameWithOwner;
  } catch {
    throw new Error("gh repo view returned invalid JSON");
  }
  if (typeof name !== "string") {
    throw new Error("gh repo view returned no repository name");
  }
  const [owner, repo] = name.split("/");
  if (
    owner === undefined ||
    repo === undefined ||
    !validOwner(owner) ||
    !validRepo(repo)
  ) {
    throw new Error(
      `gh repo view returned an invalid repository ${JSON.stringify(name)}`,
    );
  }
  return { owner, repo, number: spec.number };
}

/* ------------------------------------------------------------------ */
/* review <pr>                                                         */
/* ------------------------------------------------------------------ */

export const REVIEW_HELP = `usage: bugbot review <pr> [--repo <owner>/<repo>] [--workflow <file>]
       bugbot review --local --diff <file> [options]

With a pull request, starts the repository's Bugbot caller workflow:
  gh workflow run bugbot.yml -R <owner>/<repo> --ref <head-branch> -f pr=<n>
The caller needs a workflow_dispatch trigger with a pr input (see
examples/caller.yml), and it must exist on the PR's head branch. Fork pull
requests are refused: Bugbot skips forks. The workflow file defaults to
bugbot.yml.

  <pr>  https://github.com/<owner>/<repo>/pull/<n>, <owner>/<repo>#<n>,
        or a number with --repo <owner>/<repo>.

Exit codes: 0 review requested, 1 usage, gh error or a fork PR.

--local reviews a diff file on this machine and posts nothing. Its options
are documented in the README.`;

export const MAIN_HELP = `usage: bugbot <command> [options]

Commands:
  review <pr>          Start a review on GitHub through the caller workflow.
                       (Same-repo PRs only; fork PRs are refused.)
  review --local       Review a local diff file; nothing is posted.
  status <pr>          Show the Bugbot check and summary for a PR.
  install-skill        Install the /bugbot skill for a harness.
  --help               Show this help.

Pull request argument:
  https://github.com/<owner>/<repo>/pull/<n>
  <owner>/<repo>#<n>
  <n> --repo <owner>/<repo>
  <n>                 (resolves the repo from the cwd with gh repo view)

status exit codes:
  0  a bugbot check on the PR's head SHA is completed
  2  the check or a bugbot workflow run is queued or in progress (a newer run
     wins over an older completed check)
  3  nothing has run for this head SHA
  1  usage or gh error

Review is comment-only: it never approves, blocks or merges.`;

interface ReviewOptions {
  readonly pr: PullSpec;
  readonly workflow: string;
}

const WORKFLOW_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

/**
 * A branch name from `gh pr view` becomes the value of `--ref`. Reject
 * anything git would not accept, and never a leading `-` that `gh` could
 * read as a flag.
 */
function validBranchName(name: string): boolean {
  return (
    name !== "" &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)
  );
}

function parseReviewArgs(args: readonly string[]): ReviewOptions {
  let prArg: string | null = null;
  let repo: string | null = null;
  let workflow = "bugbot.yml";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--repo") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--repo needs <owner>/<repo>");
      }
      repo = value;
      i += 1;
    } else if (arg === "--workflow") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new Error("--workflow needs a file name");
      }
      workflow = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else if (prArg === null) {
      prArg = arg;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (prArg === null) {
    throw new Error("missing pull request (see `bugbot review --help`)");
  }
  if (!WORKFLOW_RE.test(workflow) || workflow.includes("..")) {
    throw new Error(
      `invalid workflow file ${JSON.stringify(workflow)}: expected a name like bugbot.yml`,
    );
  }

  return { pr: parsePullSpec(prArg, repo), workflow };
}

/** True when gh says the caller workflow or its dispatch trigger is missing. */
export function isMissingDispatch(error: unknown): boolean {
  if (!(error instanceof GhError)) {
    return false;
  }
  const text = `${error.stderr} ${error.stdout}`.toLowerCase();
  return (
    text.includes("workflow_dispatch") ||
    (text.includes("workflows") &&
      (text.includes("could not find") || text.includes("not found")))
  );
}

/** The two PR facts `review` needs before it dispatches. */
interface PullView {
  readonly headRefName: string;
  readonly fork: boolean;
}

function parsePullView(stdout: string): PullView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("gh pr view returned invalid JSON");
  }
  const record = asRecord(parsed);
  const headRefName = record?.["headRefName"];
  const crossRepository = record?.["isCrossRepository"];
  if (typeof headRefName !== "string" || !validBranchName(headRefName)) {
    throw new Error(
      "gh pr view returned no usable head branch for this pull request",
    );
  }
  if (typeof crossRepository !== "boolean") {
    throw new Error(
      "gh pr view returned no fork information for this pull request",
    );
  }
  return { headRefName, fork: crossRepository };
}

export async function runRemoteReview(
  args: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  const gh = deps.gh ?? execFileGh;
  const log = deps.log ?? ((line: string) => console.log(line));
  const fail = deps.error ?? ((line: string) => console.error(line));

  let options: ReviewOptions;
  try {
    options = parseReviewArgs(args);
  } catch (error) {
    fail(`Bugbot: ${errorMessage(error)}`);
    return 1;
  }

  let branch: string | null = null;
  try {
    const pull = await resolvePull(options.pr, gh);
    const repository = `${pull.owner}/${pull.repo}`;
    const target = `${repository}#${pull.number}`;

    const view = await gh([
      "pr",
      "view",
      String(pull.number),
      "-R",
      repository,
      "--json",
      "headRefName,isCrossRepository",
    ]);
    const pullView = parsePullView(view.stdout);
    branch = pullView.headRefName;

    if (pullView.fork) {
      fail(
        `Bugbot: refuses to review ${target}: Bugbot skips fork pull requests, ` +
          "and a fork's head branch cannot be dispatched in the base repository. " +
          "Nothing was started.",
      );
      return 1;
    }

    await gh([
      "workflow",
      "run",
      options.workflow,
      "-R",
      repository,
      "--ref",
      pullView.headRefName,
      "-f",
      `pr=${pull.number}`,
    ]);
    log(
      `Bugbot: requested a review for ${target} ` +
        `(${options.workflow} on ${pullView.headRefName}).`,
    );
    log(`Bugbot: check progress with \`bugbot status ${target}\`.`);
    return 0;
  } catch (error) {
    if (isMissingDispatch(error)) {
      fail(
        `Bugbot: ${oneLine(errorMessage(error))} The caller must be on ` +
          `${branch ?? "the pull request's head branch"} with a ` +
          "workflow_dispatch trigger and a pr input (see examples/caller.yml).",
      );
      return 1;
    }
    fail(`Bugbot: could not start a review: ${oneLine(errorMessage(error))}`);
    return 1;
  }
}

/* ------------------------------------------------------------------ */
/* status <pr>                                                         */
/* ------------------------------------------------------------------ */

export const STATUS_HELP = `usage: bugbot status <pr> [--repo <owner>/<repo>] [--json]

Reads the PR head SHA, its bugbot check runs, and the bot summary comment.
It never writes anything and needs no token of its own: gh supplies auth.

Exit codes:
  0  a bugbot check on the head SHA is completed
  2  the check, or a bugbot workflow run for the head SHA, is queued or
     in progress (a new run wins over an older completed check)
  3  nothing has run for this head SHA (never ran or caller missing)
  1  usage or gh error`;

interface StatusOptions {
  readonly pr: PullSpec;
  readonly json: boolean;
}

function parseStatusArgs(args: readonly string[]): StatusOptions {
  let prArg: string | null = null;
  let repo: string | null = null;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--repo") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--repo needs <owner>/<repo>");
      }
      repo = value;
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else if (prArg === null) {
      prArg = arg;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (prArg === null) {
    throw new Error("missing pull request (see `bugbot status --help`)");
  }

  return { pr: parsePullSpec(prArg, repo), json };
}

/** One check run reduced to what status needs. */
interface CheckSummary {
  readonly status: string;
  readonly conclusion: string | null;
}

interface SummaryCounts {
  readonly passes: number | null;
  readonly openComments: number | null;
  readonly markedFixed: number | null;
  readonly skipped: ReadonlyArray<{
    readonly label: string;
    readonly count: number;
  }>;
}

export interface StatusPayload {
  readonly repository: string;
  readonly pull: number;
  readonly url: string | null;
  readonly headSha: string;
  readonly headSha7: string;
  readonly state: "done" | "running" | "none";
  readonly conclusion: string | null;
  readonly check: CheckSummary | null;
  readonly summary: SummaryCounts | null;
  readonly exitCode: 0 | 2 | 3;
}

const SUMMARY_MARKER = "<!-- bugbot:summary -->";
const SUMMARY_AUTHOR = "andura-bugbot[bot]";
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);
const SHA_RE = /^[0-9a-f]{40}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses one JSON document or the concatenated pages `gh api --paginate` emits. */
export function parseJsonPages(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }

  try {
    const whole: unknown = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // gh --paginate writes one JSON array per page, back to back.
  }

  const docs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (char === undefined) {
      break;
    }
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
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        docs.push(JSON.parse(trimmed.slice(start, i + 1)));
        start = -1;
      }
      if (depth < 0) {
        throw new Error("invalid JSON from gh");
      }
    }
  }

  if (depth !== 0 || start !== -1) {
    throw new Error("invalid or truncated JSON from gh");
  }

  return docs.flatMap((doc) => (Array.isArray(doc) ? doc : [doc]));
}

/** Parses the counts in a Bugbot summary body. Marker/author checks are separate. */
export function parseSummaryBody(body: string): SummaryCounts | null {
  if (!body.includes(SUMMARY_MARKER)) {
    return null;
  }

  const number = (pattern: RegExp): number | null => {
    const match = pattern.exec(body);
    if (match?.[1] === undefined) {
      return null;
    }
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  const passes = number(/^- Passes:\s*(\d+)\s*$/m);
  const openComments = number(/^- Open Bugbot comments:\s*(\d+)\s*$/m);
  const markedFixed = number(/^- Marked fixed this pass:\s*(\d+)\s*$/m);

  const skipped: Array<{ label: string; count: number }> = [];
  const skippedLine = /^- Skipped:\s*(.+?)\s*$/m.exec(body);
  if (skippedLine?.[1] !== undefined) {
    for (const item of skippedLine[1].split(",")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(item);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        skipped.push({ label: match[2], count: Number(match[1]) });
      }
    }
  }

  if (
    passes === null &&
    openComments === null &&
    markedFixed === null &&
    skipped.length === 0
  ) {
    return null;
  }

  return { passes, openComments, markedFixed, skipped };
}

/** Finds the newest bot-authored summary comment on a PR. */
export function findBugbotSummary(
  comments: readonly unknown[],
): SummaryCounts | null {
  let found: SummaryCounts | null = null;
  for (const item of comments) {
    const comment = asRecord(item);
    const user = asRecord(comment?.["user"]);
    const body = comment?.["body"];
    if (
      user?.["login"] !== SUMMARY_AUTHOR ||
      typeof body !== "string" ||
      !body.includes(SUMMARY_MARKER)
    ) {
      continue;
    }
    const parsed = parseSummaryBody(body);
    if (parsed !== null) {
      found = parsed;
    }
  }
  return found;
}

function pickCheck(value: unknown): CheckSummary | null {
  const response = asRecord(value);
  const runs = response?.["check_runs"];
  if (!Array.isArray(runs)) {
    return null;
  }
  const matches = runs
    .map((item) => asRecord(item))
    .filter(
      (run): run is Record<string, unknown> =>
        run !== null &&
        typeof run["name"] === "string" &&
        run["name"].toLowerCase() === "bugbot",
    );
  if (matches.length === 0) {
    return null;
  }

  // The API returns newest first; timestamps make that explicit when present.
  // A queued re-run has `started_at: null` and is newer than any completed
  // check on the same SHA, so a missing timestamp sorts first (N1).
  const startedAt = (run: Record<string, unknown>): string => {
    const value = run["started_at"];
    return typeof value === "string" && value !== "" ? value : "\uffff";
  };
  matches.sort((a, b) => {
    const left = startedAt(a);
    const right = startedAt(b);
    if (left !== right) {
      return left < right ? 1 : -1;
    }
    const leftId = typeof a["id"] === "number" ? a["id"] : 0;
    const rightId = typeof b["id"] === "number" ? b["id"] : 0;
    return rightId - leftId;
  });

  const chosen = matches[0];
  if (chosen === undefined) {
    return null;
  }
  const status =
    typeof chosen["status"] === "string" ? chosen["status"] : "unknown";
  const conclusion =
    typeof chosen["conclusion"] === "string" ? chosen["conclusion"] : null;
  return { status, conclusion };
}

function hasActiveBugbotRun(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((item) => {
    const run = asRecord(item);
    if (run === null) {
      return false;
    }
    const status = typeof run["status"] === "string" ? run["status"] : "";
    if (!ACTIVE_RUN_STATUSES.has(status)) {
      return false;
    }
    const names = [run["workflowName"], run["name"]]
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase());
    return names.includes("bugbot");
  });
}

function formatSkipped(skipped: SummaryCounts["skipped"]): string {
  if (skipped.length === 0) {
    return "none";
  }
  return skipped.map((item) => `${item.label} ${item.count}`).join(", ");
}

function printStatus(payload: StatusPayload, log: (line: string) => void): void {
  const target = `${payload.repository}#${payload.pull}`;
  log(`Bugbot status for ${target}`);
  log(`State: ${payload.state}`);
  log(`Conclusion: ${payload.conclusion ?? "-"}`);
  log(`Head: ${payload.headSha7}`);
  if (payload.summary === null) {
    log("Summary: none");
  } else {
    const summary = payload.summary;
    log(`Passes: ${summary.passes ?? "-"}`);
    log(
      `Open comments: ${
        summary.openComments === null ? "unknown" : summary.openComments
      }`,
    );
    log(`Marked fixed this pass: ${summary.markedFixed ?? "-"}`);
    log(`Skipped: ${formatSkipped(summary.skipped)}`);
  }
}

export async function runStatus(
  args: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  const gh = deps.gh ?? execFileGh;
  const log = deps.log ?? ((line: string) => console.log(line));
  const fail = deps.error ?? ((line: string) => console.error(line));

  let options: StatusOptions;
  try {
    options = parseStatusArgs(args);
  } catch (error) {
    fail(`Bugbot: ${errorMessage(error)}`);
    return 1;
  }

  try {
    const pull = await resolvePull(options.pr, gh);
    const repository = `${pull.owner}/${pull.repo}`;

    const view = await gh([
      "pr",
      "view",
      String(pull.number),
      "-R",
      repository,
      "--json",
      "headRefOid,url",
    ]);
    let viewJson: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(view.stdout);
      viewJson = asRecord(parsed) ?? {};
    } catch {
      throw new Error("gh pr view returned invalid JSON");
    }
    const headSha =
      typeof viewJson["headRefOid"] === "string"
        ? viewJson["headRefOid"]
        : "";
    if (!SHA_RE.test(headSha)) {
      throw new Error(
        `gh pr view returned no head SHA for ${repository}#${pull.number}`,
      );
    }
    const url =
      typeof viewJson["url"] === "string" ? viewJson["url"] : null;

    // Filter by name and take a full page: the bugbot check is created after
    // the CI checks, so it can fall off the default page on a busy SHA (B2).
    const checksResult = await gh([
      "api",
      `repos/${repository}/commits/${headSha}/check-runs` +
        "?check_name=bugbot&filter=all&per_page=100",
    ]);
    let checksJson: unknown;
    try {
      checksJson = JSON.parse(checksResult.stdout);
    } catch {
      throw new Error("gh api check-runs returned invalid JSON");
    }
    const check = pickCheck(checksJson);

    // A queued or in-progress bugbot run means a new pass is starting. It
    // wins over an older completed check on the same SHA, so status right
    // after `review` of an already-reviewed SHA does not report the previous
    // pass as done (N2). The limit keeps a queued run from being cut off (N7).
    let activeRun = false;
    if (check === null || check.status === "completed") {
      const runsResult = await gh([
        "run",
        "list",
        "-R",
        repository,
        "--commit",
        headSha,
        "--limit",
        "100",
        "--json",
        "status,name,workflowName",
      ]);
      let runsJson: unknown;
      try {
        runsJson = JSON.parse(runsResult.stdout);
      } catch {
        throw new Error("gh run list returned invalid JSON");
      }
      activeRun = hasActiveBugbotRun(runsJson);
    }

    let exitCode: 0 | 2 | 3;
    let state: "done" | "running" | "none";
    let conclusion: string | null = null;

    if (check !== null && check.status !== "completed") {
      exitCode = 2;
      state = "running";
    } else if (activeRun) {
      exitCode = 2;
      state = "running";
    } else if (check !== null) {
      exitCode = 0;
      state = "done";
      conclusion = check.conclusion;
    } else {
      exitCode = 3;
      state = "none";
    }

    const commentsResult = await gh([
      "api",
      `repos/${repository}/issues/${pull.number}/comments`,
      "--paginate",
    ]);
    const summary = findBugbotSummary(parseJsonPages(commentsResult.stdout));

    const payload: StatusPayload = {
      repository,
      pull: pull.number,
      url,
      headSha,
      headSha7: headSha.slice(0, 7),
      state,
      conclusion,
      check,
      summary,
      exitCode,
    };

    if (options.json) {
      log(JSON.stringify(payload, null, 2));
    } else {
      printStatus(payload, log);
    }
    return exitCode;
  } catch (error) {
    fail(`Bugbot: could not read status: ${oneLine(errorMessage(error))}`);
    return 1;
  }
}
