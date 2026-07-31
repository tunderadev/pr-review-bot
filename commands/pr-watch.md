---
description: Run one PR review cycle — check for labeled PRs, review, post to GitHub and Slack
---

Run exactly one review cycle and report what it printed. You are the runner, not the reviewer.

## 1. Run it, once

```bash
node ~/code/pr-review-bot/src/cli.mjs cycle; echo "cycle exit: $?"
```

If the clone lives somewhere else, change the path and nothing else. Add no flags.

## 2. Report the outcome in at most three lines

A run that reached the end prints one line per processed PR, then the totals as the **last** line.
Most cycles find nothing, and that is a healthy result, not a problem to investigate:

```
0 PR(s): none
```

```
owner/repo#12 reviewed (approved)
owner/repo#14 reviewed (changes_requested)
owner/repo#9 skipped_same_sha
3 PR(s): 2 reviewed, 1 skipped_same_sha
```

Each per-PR line is `owner/repo#number <outcome>`, with the verdict in parentheses when there is
one. The outcomes are `reviewed`, `skipped_same_sha` and `error`; the verdicts are `approved` and
`changes_requested`. Report them as printed — they are the answer, so you never need to open a PR
page, and never fill in a verdict that was not printed.

Other lines may appear **above** those, emitted by the cycle while it works. Pass them through too:

- `owner/repo#12 deferred: …` — transient, the PR is back under `review-requested`, next cycle retries it.
- `owner/repo#12 failed: …` — per-PR failure, the PR now wears `review-error`.
- `Slack … failed for owner/repo#12: …` — the GitHub review still landed; only the mirror is degraded.

If the summary ends with ` — aborted: <reason>`, state the reason plainly and say the cycle
stopped early on purpose.

## 3. Read the exit code out loud

The `cycle exit:` line above is where the code comes from — the shell command itself always
succeeds, so the tool will not flag a failed cycle for you.

| Code | Meaning | What to say |
|---|---|---|
| 0 | Cycle completed | Report the summary. Nothing to do. |
| 1 | Configuration or usage error — nothing ran | Show the message; suggest `node ~/code/pr-review-bot/src/cli.mjs doctor`. |
| 2 | Health checks red | Only `doctor` returns this, never `cycle`. If you see it here, something is wrong with the invocation itself. |
| 3 | Transient abort | The affected PR is back under `review-requested` and retries next cycle. Say so, and do nothing. |
| 4 | At least one PR failed | It carries the sticky `review-error` label and is **never** retried automatically. Name the PR; a human has to look and clear the label. |
| 5 | Bug in the tool, not a misconfiguration | Say so, and mention `PR_REVIEW_DEBUG=1` re-runs it with a stack trace. Do not attempt a fix. |

## 4. Stop

- Do **not** review any PR yourself, summarize a diff, or open a PR page to form an opinion.
- Do **not** edit files — not `src/`, not `team.json`, not `review-criteria.md`. A criteria change
  in the middle of a watch loop changes verdicts silently.
- Do **not** re-run the command. On exit 3 the next loop tick is the retry; on exit 4 a re-run
  cannot pick the PR up again, because the label it needs is gone.
- Do **not** remove a `review-error` label. That is the human's decision and their signal.
