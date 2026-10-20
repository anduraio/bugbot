# Prompts

These are the pstack review texts, vendored so Bugbot's prompts are versioned
and reviewable instead of drifting on someone's Mac. Bugbot loads them as
plain text in step 4; nothing here is executed.

Source: pstack **0.15.25**, from
<https://github.com/cursor/plugins> (pstack lives at
<https://github.com/cursor/plugins/tree/main/pstack>). `~/.pstack` is not a
git checkout, so each file's header cites the pstack version and the sha256 of
the original file instead of a commit. The table below repeats them, and the
body under each header is byte-identical to that original.

License: MIT, Copyright (c) 2026 Lauren Tan. See
[LICENSE-pstack](LICENSE-pstack) for the full text. Every vendored file keeps
the notice in its header.

## Refresh

```sh
scripts/sync-prompts.sh                          # uses ~/.pstack
PSTACK_DIR=/path/to/pstack scripts/sync-prompts.sh
```

The script is manual only: CI never runs it, it never commits, and it makes no
network calls. It copies the same file list, rewrites the headers with fresh
sha256s and the current pstack version, updates the hash column below, and
prints the files it changed. If pstack has not changed, it leaves `prompts/`
byte-for-byte identical.

## Files

The directory shape mirrors pstack: skills keep their folder and references,
and the single-file texts sit at the top level.

| Vendored file | pstack source path | Role in Bugbot (SPEC section 4) | sha256 |
|---|---|---|---|
| `prompts/interrogate/SKILL.md` | `skills/interrogate/SKILL.md` | Core review: several independent reviewer angles (correctness, security/data, edge cases), run as separate passes or one prompt with sections. | `a7e2248e46d7209519bb21e5586ef453c31ab95af32d951e5c843b0109b7357b` |
| `prompts/interrogate/references/reviewer-prompt.md` | `skills/interrogate/references/reviewer-prompt.md` | The per-reviewer adversarial prompt template the core review pass fills in. | `f6005cc2b535006fca97a96c5bfda49df57312eedf1ffd8d1aaaf3eb33817c25` |
| `prompts/interrogate/references/rubric.md` | `skills/interrogate/references/rubric.md` | Review rubric: correctness, root causes vs symptoms, structural integrity, verification, complexity, security. | `0f9c6bdb0b96e26dbde5f6407f417e0c02f54080e7a1268d8994f3c3ec6c5ac0` |
| `prompts/interrogate/references/code-quality-review.md` | `skills/interrogate/references/code-quality-review.md` | Code-quality lens applied on top of the rubric during the core review. | `79162fda183eafd40d51661fbb5e151c7ba250f89e506ba17f5bd135dcbd50a8` |
| `prompts/interrogate/references/lead-judgment.md` | `skills/interrogate/references/lead-judgment.md` | How to weigh findings and bucket them (act, consider, noted, dismissed) before posting. | `355f5195a76bc75a655125292369f2a8231a2b61fabe5188d8f1386060922b87` |
| `prompts/blast-radius/SKILL.md` | `skills/blast-radius/SKILL.md` | What the change breaks beyond the diff: callers, shared types, routes, migrations. | `70a3ba17a2c821ded5ce439e7778f0eefb353dc70336d12b83b75f500f7d96b5` |
| `prompts/bugbot-triage.md` | `skills/poteto-mode/references/bugbot-triage.md` | Fix-vs-skip rules drawn from real PRs. Inverted into a self-filter: drop any finding the triage would mark "skip" before posting. | `b2d146c770d8d3593e1ef3d77b668039b8e1f78093ea1a86f1d45d7f99614309` |
| `prompts/comment-sicko.md` | `agents/comment-sicko.md` | Optional second pass (`comment_sicko: true`): pointless comments and `@ts-ignore` / `eslint-disable` suppressions. Off by default. | `3e239e40b7b4b9beb2cf7f3ccc57f2388eb8b69bd1ba8ae888ef87ef6e0e2116` |
| `prompts/typescript-best-practices/SKILL.md` | `skills/typescript-best-practices/SKILL.md` | TypeScript bug patterns only (unsafe `any`, unchecked nulls, floating promises), not style. | `fab7f3f3f4a98ad445eb42d54ba864f4ee37adbbedd453dfc48ef79964f00bc2` |
| `prompts/typescript-best-practices/references/patterns.md` | `skills/typescript-best-practices/references/patterns.md` | Worked examples for the TypeScript rules, used to recognise the same bug shapes in a diff. | `faa1362055374452efccac1b629677c61acfb0bcc6c4e3311836b5715638ee18` |
| `prompts/principle-fix-root-causes/SKILL.md` | `skills/principle-fix-root-causes/SKILL.md` | Flags symptom-only fixes. | `78f857b726cc4aee5a6c0d9f60df9f10566221d010d86188497388821ce1944a` |
| `prompts/principle-test-behavior-not-implementation/SKILL.md` | `skills/principle-test-behavior-not-implementation/SKILL.md` | Flags tests that can't catch the bug they claim to cover. | `e486481257ea4279a32030e232424c1562e40e92a35a8d6154b8b1f444d0573b` |
