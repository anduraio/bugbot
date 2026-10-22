---
name: bugbot
description: Start a Bugbot review on a pull request, wait for the check, then triage the comments.
disable-model-invocation: true
---

# Bugbot

Bugbot reviews a pull request for real bugs, security holes and missed edge
cases, then posts inline comments plus one summary comment. It is
comment-only: it never approves, requests changes, blocks or merges.

## When to use

After you push a pull request and want it reviewed.

## Steps

1. Start a review:

   ```sh
   bugbot review <pr>
   ```

   `<pr>` is a pull request URL, `<owner>/<repo>#<n>`, or a number together
   with `--repo <owner>/<repo>`.

2. Poll until the review is done:

   ```sh
   bugbot status <pr>
   ```

   - Exit 0: a `bugbot` check on the head commit is completed. Read the
     summary counts and the inline comments.
   - Exit 2: the check or the caller workflow run is queued or in progress.
     Wait about a minute, then poll again.
   - Exit 3: nothing ran for this head commit. Check that the repository has a
     caller workflow with a `workflow_dispatch` trigger and a `pr` input (see
     `examples/caller.yml` in the Bugbot package), then start the review again.
   - Exit 1: usage or `gh` error. Fix it before polling again.

3. Triage the comments with the pstack poteto-mode babysit playbook at
   `~/.pstack/skills/poteto-mode/playbooks/babysit.md`: it drives the loop of
   reading Bugbot's threads, fixing the real findings, replying, and asking a
   person to resolve what is fixed.

For a local look that posts nothing, use `bugbot review --local` (see the
Bugbot README for its options).
