# Bugbot

Bugbot is Andura's pull request reviewer. It looks for real bugs, security
holes and missed edge cases, then posts inline comments on the exact lines
plus one summary comment. It also exposes a `bugbot` check run so a babysitter
can tell when a review pass is done.

**Bugbot is comment-only.** It never approves, never requests changes and
never blocks, fails or merges a pull request. If it cannot review, the check
goes `neutral` and the summary says why.

Status: step 5, filter, self-filter and dedupe. `review --local` builds a
review from a diff file and prints the findings plus the comments that would
post; it never posts. The GitHub review path is still a stub until step 6.

## Layout

- `action.yml` - composite action: inputs, then `node dist/cli.js review`
- `.github/workflows/review.yml` - reusable workflow for opted-in repos
- `src/context.ts` - diff, changed files, `AGENTS.md`, token budget
- `src/prompt.ts` - assembles the vendored prompts and the context
- `src/model.ts` - OpenRouter call, JSON-only, retries
- `src/filter.ts` - finding schema, confidence/severity/triage gate, hash,
  cross-pass dedupe, comment body and marker
- `src/gate.ts` - pure draft/fork gate shared by the workflow and the CLI
- `src/github.ts` - inline comments, summary, check run, reply/resolve
- `src/cli.ts` - `bugbot review|status`
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
