# Bugbot

Bugbot is Andura's pull request reviewer. It looks for real bugs, security
holes and missed edge cases, then posts inline comments on the exact lines
plus one summary comment. It also exposes a `bugbot` check run so a babysitter
can tell when a review pass is done.

**Bugbot is comment-only.** It never approves, never requests changes and
never blocks, fails or merges a pull request. If it cannot review, the check
goes `neutral` and the summary says why.

Status: step 2, repository skeleton. The TypeScript modules other than the
finding filter and the draft/fork gate are typed stubs; the review pipeline is
built in later steps.

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
- `examples/caller.yml` - per-repo caller workflow with explicit secrets
- `test/` - Vitest tests

## Development

```sh
npm install
npm test
npm run build
```

Bugbot targets Node 20.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 anduraio.

The review prompts are adapted from pstack, which is MIT licensed:
Copyright (c) 2026 Lauren Tan.
