# Bugbot

Bugbot is Andura's pull request reviewer. It looks for real bugs, security
holes and missed edge cases, then posts inline comments on the exact lines
plus one summary comment. It also exposes a `bugbot` check run so a babysitter
can tell when a review pass is done.

**Bugbot is comment-only.** It never approves, never requests changes and
never blocks, fails or merges a pull request. If it cannot review, the check
goes `neutral` and the summary says why.

Status: step 3, prompts vendored. The review texts live in `prompts/`; step 4
assembles them. The TypeScript modules other than the finding filter and the
draft/fork gate are typed stubs; the review pipeline is built in later steps.

## Layout

- `action.yml` - composite action: inputs, then `node dist/cli.js review`
- `.github/workflows/review.yml` - reusable workflow for opted-in repos
- `src/context.ts` - diff, changed files, `AGENTS.md`, token budget
- `src/prompt.ts` - assembles the vendored prompts and the context
- `src/model.ts` - OpenRouter call, JSON-only, retries
- `src/filter.ts` - Zod finding schema, confidence/severity gate, hash, marker
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
