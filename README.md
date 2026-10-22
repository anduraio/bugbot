# Bugbot

Bugbot is Andura's pull request reviewer. It looks for real bugs, security
holes and missed edge cases, then posts inline comments on the exact lines
plus one summary comment. It also exposes a `bugbot` check run so a babysitter
can tell when a review pass is done.

**Bugbot is comment-only.** It never approves, never requests changes and
never blocks, fails or merges a pull request. If it cannot review, the check
goes `neutral` and the summary says why. When a re-check proves a finding is
gone, Bugbot replies `Looks fixed as of <sha7>.` and leaves resolving the
thread to a person.

Status: step 10, the CLI to start a review, inspect its check and summary, and
install the `/bugbot` skill. `review --local` builds a review from a diff file
and prints the findings plus the comments that would post; it never posts.

## Layout

- `action.yml` - composite action: inputs, then `node dist/cli.js review`
- `.github/workflows/review.yml` - reusable workflow for opted-in repos
- `src/context.ts` - diff, changed files, `AGENTS.md`, token budget
- `src/prompt.ts` - assembles the vendored prompts and the context
- `src/model.ts` - OpenRouter call, JSON-only, retries
- `src/filter.ts` - finding schema, confidence/severity/triage gate, hash,
  cross-pass dedupe, comment body and marker
- `src/gate.ts` - pure draft/fork gate shared by the workflow and the CLI
- `src/github.ts` - inline comments, summary, check run, replies
- `src/gh.ts` - the `gh` CLI runner behind `review <pr>` and `status <pr>`
- `src/skill.ts` - `install-skill` for each harness
- `src/cli.ts` - `bugbot review|status|install-skill`
- `skill/bugbot/SKILL.md` - the `/bugbot` skill
- `prompts/` - pstack review texts, vendored with source headers (MIT)
- `scripts/sync-prompts.sh` - manual refresh of `prompts/` from a local pstack
- `examples/caller.yml` - per-repo caller workflow with explicit secrets
- `test/` - Vitest tests

## Prompts

`prompts/` holds the pstack review texts Bugbot will use: the interrogate
reviewer angles, blast radius, the Bugbot triage self-filter, comment-sicko,
TypeScript patterns and two principle skills. Every file starts with an HTML
comment naming its pstack source path, the pstack version and the sha256 of the
original file. `prompts/README.md` has the full table and the directory shape.

They are vendored from pstack 0.15.25, MIT licensed,
Copyright (c) 2026 Lauren Tan. The license text is in
[prompts/LICENSE-pstack](prompts/LICENSE-pstack).

Refresh manually from a local pstack checkout:

```sh
scripts/sync-prompts.sh                          # uses ~/.pstack
PSTACK_DIR=/path/to/pstack scripts/sync-prompts.sh
```

The script rewrites the headers and the README hashes, prints what changed,
and makes no network calls. CI never runs it and it never commits.

## CLI

The three commands below talk to GitHub only through `gh`, so `gh auth login`
supplies the auth. The CLI never reads, takes or prints a token. `review <pr>`
makes one write request (`gh workflow run`); `status` only reads.

All three accept the same pull request argument:

- `https://github.com/<owner>/<repo>/pull/<n>`
- `<owner>/<repo>#<n>`
- a bare number with `--repo <owner>/<repo>`, or a bare number in a checkout
  (the repo is resolved with `gh repo view --json nameWithOwner`)

Anything else is rejected before `gh` runs. An unknown command or any other
usage error exits `1`; `2` is reserved for `status` reporting that a run is
still queued or in progress, so a typo can never look like "keep polling".

### `bugbot review <pr>`

Starts the repository's caller workflow:

```sh
gh workflow run bugbot.yml -R <owner>/<repo> --ref <head-branch> -f pr=<n>
```

`--workflow <file>` overrides `bugbot.yml`. The caller must be on the PR's
head branch with a `workflow_dispatch` trigger and a `pr` input;
`examples/caller.yml` shows the shape. Dispatching on the head branch makes the
run's head SHA equal to the PR head, so `status` can see it while it is queued.

Fork pull requests are refused: Bugbot skips forks, and a fork's head branch
cannot be dispatched in the base repository. Nothing is started.

Exit codes: `0` review requested, `1` usage, `gh` error or a fork PR.

### `bugbot status <pr> [--json]`

Reads the PR head SHA, the check runs named `bugbot` on that SHA, and the
summary comment by `andura-bugbot[bot]` carrying `<!-- bugbot:summary -->`.
It prints the state (`done`, `running`, `none`), conclusion, head SHA, and the
summary's passes, open comments, marked fixed and skipped counts. `--json`
prints one machine-readable object instead.

Check runs are requested filtered by name with a full page, and the queued-run
lookup asks for up to 100 runs, so a busy head SHA cannot hide the `bugbot`
check or run. A queued or in-progress `bugbot` workflow run wins over an older
completed check on the same SHA: right after `review` of a commit that was
reviewed before, `status` reports `running` for the new pass instead of `done`
for the previous one.

Fork PRs are never dispatched, because `review` refuses them. On the
`pull_request` path a fork PR, and a draft that lacks the draft label, are
skipped before the CLI runs, so no `bugbot` check is ever posted: `status` says
`3` and stays `3`. That is expected, not a missing caller.

Exit codes:

- `0` a `bugbot` check on the head SHA is completed
- `2` the check, or a `bugbot` workflow run for the head SHA, is queued or in
  progress (poll again)
- `3` nothing has run for this head SHA (never ran, or the caller is missing)
- `1` usage or `gh` error

### `bugbot install-skill --harness <name> [--force] [--dry-run]`

Copies `skill/bugbot/SKILL.md` to the harness skills folder under `$HOME`:

| Harness | Destination |
| --- | --- |
| `claude` | `~/.claude/skills/bugbot/SKILL.md` |
| `claude-personal` | `~/.claude-personal/skills/bugbot/SKILL.md` |
| `grok` | `~/.grok/skills/bugbot/SKILL.md` |
| `opencode` | `~/.config/opencode/skills/bugbot/SKILL.md` |
| `agents` | `~/.agents/skills/bugbot/SKILL.md` |

An identical file is a no-op. A different file is only overwritten with
`--force`; `--dry-run` prints the destination and writes nothing. Bugbot never
writes under `~/.pstack`, and refuses when any part of the destination path is
a symlink or resolves outside `$HOME`.

## Local review

`review --local` runs the same prompts against a local diff file and prints the
validated findings as JSON, then the planned comments and the summary counts.
Nothing is posted to GitHub.

```sh
OPENROUTER_API_KEY=... node dist/cli.js review --local \
  --diff path/to/change.diff \
  --repo-dir path/to/checkout \
  --title "PR title" \
  --body "PR body"
```

`--repo-dir` (default: cwd) is the root for the post-change files and
`AGENTS.md`. Only paths named in the diff are read. Absolute paths, any path
with a `..` segment, and symlinks whose target resolves outside `--repo-dir`
(a file or a directory link, and `AGENTS.md` itself) are refused: the file's
diff stays in the prompt but its contents are never read or sent.
`--max-tokens N` sets the input budget (default 120000). The budget is
measured on the assembled system prompt and user message, including the block
wrappers, truncation notes and the skipped/truncated path lists (each list
shows at most 50 paths, then a count).

Add `--print-prompt` to print the estimated input tokens, the skipped and
truncated file lists, and the system and user prompt sizes in characters. It
makes no model call and needs no key, so it is safe in CI and while working on
the prompts:

```sh
node dist/cli.js review --local --diff change.diff --repo-dir . --print-prompt
```

The model comes from `BUGBOT_MODEL` (default
`deepseek/deepseek-v4.1-flash-1017`) and is sent through OpenRouter. Tokens in
and out are logged as `tokens_in` and `tokens_out` for every run. Prices are
never hardcoded: read them from OpenRouter's model page for the model you
choose.

`--local` extras:

- `--comment-sicko` adds `prompts/comment-sicko.md` to the system prompt. The
  same switch can be set with `BUGBOT_COMMENT_SICKO=true`.
- `BUGBOT_MIN_CONFIDENCE` sets the inline-comment confidence bar (default 0.8).
  A value outside `0` to `1`, or a malformed one, falls back to 0.8; a valid
  lower value such as `0.1` is honored on purpose.
- `BUGBOT_BIG_PR_MODEL` is the fallback model for a PR over 1500 changed lines
  or a context that is over budget after truncation. Without it, those
  reviews are skipped with a reason instead of sent past the budget.
- `BUGBOT_MAX_OUTPUT_TOKENS` is the model output cap sent as `max_tokens`
  (default 8000). A set value must be a whole number from 1000 to 64000;
  anything else ends the pass with a clear message before any model request.
  A `length` stop with empty content retries with twice the cap, up to 32000,
  and bounds reasoning to `low` when the stop spent tokens on reasoning. Each
  attempt's timeout (120 s by default) grows with the cap it sends, bounded at
  300 s, so the biggest retry has time to finish.

## Workflow inputs

The reusable workflow and the composite action accept `model`, `big_pr_model`,
`max_tokens` (input budget, default 120000), `max_output_tokens` (model output
cap, default 8000), `min_confidence`, `dry_run` and `comment_sicko`.
`max_output_tokens` is passed to the CLI as `BUGBOT_MAX_OUTPUT_TOKENS`.

An empty model reply logs one line with `finish_reason`,
`native_finish_reason`, the reasoning character count, the usage numbers and
any provider `error` code and message. It never logs the prompt or the
reasoning text. Safe usage from those failed attempts is still counted in the
summary's `Tokens` line.

## Development

```sh
npm install
npm test
npm run build
```

Bugbot targets Node 20.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 anduraio.

The review prompts in `prompts/` are vendored from pstack, which is MIT
licensed: Copyright (c) 2026 Lauren Tan. See
[prompts/LICENSE-pstack](prompts/LICENSE-pstack).
