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
one. The outcomes are `reviewed`, `skipped_same_sha`, `dry_run` and `error`; the verdicts are
`approved` and `changes_requested`. Report them as printed — they are the answer, so you never need
to open a PR page, and never fill in a verdict that was not printed.

`dry_run` should never appear here, because the command above adds no flags — it replaces `reviewed`
only under `--dry-run`. If you see one, the command was changed: say so, and say that nothing was
posted, labelled or mirrored to Slack.

Other lines may appear **above** those, emitted by the cycle while it works. Pass them through too:

- `owner/repo#12 deferred: …` — transient, the PR is back under `review-requested`, next cycle retries it.
- `owner/repo#12 failed: …` — per-PR failure, the PR now wears `review-error`.
- `owner/repo#12 failed: refutation could not verify … That is 3 consecutive attempts at <sha>` —
  the bot could not get a trustworthy answer about this PR three times running, so it stopped rather
  than keep guessing. Say that plainly: it is a statement about the reviewer, **not** a judgement on
  the PR, and nothing was posted. The PR now wears `review-error`.
- `acme/api: N PR(s) carry the review-error label and were skipped — …` — those PRs were stepped
  over untouched. Pass the line through; a human has to clear the label before anything happens.
- `Slack … failed for owner/repo#12: …` — the GitHub review still landed; only the mirror is degraded.

If the summary ends with ` — aborted: <reason>`, state the reason plainly and say the cycle
stopped early on purpose.

## 3. Read the exit code out loud

The `cycle exit:` line above is where the code comes from — the shell command itself always
succeeds, so the tool will not flag a failed cycle for you.

| Code | Meaning | What to say |
|---|---|---|
| 0 | Cycle completed | Report the summary. Nothing to do. A `skipped_same_sha` line, a PR stepped over for wearing `review-error`, and a PR whose author account was deleted all land here. |
| 1 | Configuration, usage, or repo-discovery error — nothing was reviewed | Show the message; it names what to fix. A discovery failure (a 404, a plain 403, a 401, a non-list payload, unparseable or overflowing pagination) names the repo it could not list — usually a typo in `repos` or an App not installed on it. Suggest `node ~/code/pr-review-bot/src/cli.mjs doctor`. |
| 2 | Health checks red | Only `doctor` returns this, never `cycle`. If you see it here, something is wrong with the invocation itself. |
| 3 | Transient abort | The affected PR is back under `review-requested` and retries next cycle. If it aborted during discovery — a 429, a 5xx, a 403 rate limit, a network errno — no PR was touched at all. Say so, and do nothing. |
| 4 | At least one PR failed | It carries the sticky `review-error` label and is **never** retried automatically — it is excluded from selection until a human clears it. Name the PR; a human has to look. |
| 5 | Bug in the tool, not a misconfiguration | Say so, and mention `PR_REVIEW_DEBUG=1` re-runs it with a stack trace. Do not attempt a fix. |

**An aborted cycle wins over a per-PR failure.** If one PR earned `review-error` and a later one hit
a transient condition, the exit code is `3`, not `4` — so `3` does not prove every PR is fine. Read
the per-PR lines: any `failed:` line means that PR is now wearing the sticky label and needs a human,
whatever the exit code says.

## 4. Stop

- Do **not** review any PR yourself, summarize a diff, or open a PR page to form an opinion.
- Do **not** edit files — not `src/`, not `team.json`, not `review-criteria.md`. A criteria change
  in the middle of a watch loop changes verdicts silently.
- Do **not** re-run the command. On exit 3 the next loop tick is the retry; on exit 4 a re-run
  cannot pick the PR up again, because `review-error` excludes it from selection outright — the
  cycle steps over it before doing any work.
- Do **not** remove a `review-error` label, and do **not** add `review-requested` to a PR that
  wears one. That is the human's decision and their signal. The documented recovery is theirs to
  perform, in this order: fix the cause, remove `review-error`, then re-add `review-requested`.
