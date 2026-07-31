---
name: pr-review
description: Use when running or debugging the automated PR review pipeline, or when tuning the review criteria that drive its verdicts
---

# PR Review Pipeline

A local CLI polls allowlisted repos for PRs labeled `review-requested`, reviews them with headless
Claude against team-authored criteria, posts approve or request-changes as a GitHub App bot, and
mirrors the verdict onto a Slack thread. Orchestration is deterministic Node with no dependencies;
the model never touches a label, a verdict mapping or an API call.

Paths below assume the clone is at `~/code/pr-review-bot`. Substitute yours.

## Running it

```bash
node ~/code/pr-review-bot/src/cli.mjs doctor     # before the first live run, and after any config change
node ~/code/pr-review-bot/src/cli.mjs cycle      # exactly one cycle
```

Continuously: open a dedicated terminal session and run `/loop 5m /pr-watch`. One runner per team
config — the `review-in-progress` claim is a read-modify-write with a small race window.

Three commands, and each flag is refused by the commands that do not implement it:

| | `--config <dir>` | `--dry-run` | `--json` | `--reset` |
|---|---|---|---|---|
| `cycle` (default) | yes | yes | yes | — |
| `doctor` | yes | — | yes | — |
| `report` | — | — | yes | yes |

Config resolves in this order, and `doctor` prints which tier won: `--config` → `PR_REVIEW_CONFIG_DIR`
→ `./.claude/pr-review/` → `~/.config/pr-review-bot/default/`. The directory must hold both
`team.json` and `review-criteria.md`. `PR_REVIEW_CONFIG_DIR` is read from the process environment
only — putting it in `~/.config/pr-review-bot/.env` does nothing.

## What one cycle does

For each allowlisted repo it lists open PRs and keeps those labeled `review-requested` whose title
matches `titlePrefix` (drafts included — the label is the opt-in). Candidates are sorted
oldest-updated first *across* repos, then capped at `maxPerCycle` (default 3). Then, per PR:

1. Read the bot's own past reviews and the sticky ledger comment.
2. **Same-SHA guard.** If the bot already reviewed this head SHA, thread-reply "no new commits",
   drop the label, done — zero model calls.
3. **Claim.** Remove `review-requested`, add `review-in-progress`. This happens before any
   expensive work, so an overlapping cycle sees the PR is taken.
4. Build the diff under `maxDiffLines` (default 3000), smallest files first so one lockfile cannot
   crowd out source. Excluded files are named in the review body, never silently dropped.
5. Announce in Slack if this PR has no message yet, and set the in-review reaction.
6. **Review.** A `claude -p` child runs with `Read Grep Glob` in a detached worktree checked out at
   the PR head, against the criteria, the diff, and last round's unresolved blockers.
7. **Verify.** A second child tries to refute each *blocking* finding. Nits are never checked.
   Survivors only.
8. **Verdict.** Surviving blockers → `REQUEST_CHANGES`; none → `APPROVE`, posted as the App.
9. Reconcile the Slack reaction; on changes requested, thread-reply tagging the author with the
   surviving blockers.
10. Append the round to the sticky ledger, remove `review-in-progress`.

Clones live under `clonesDir` (default `~/.cache/pr-review-bot/clones`), one `--filter=blob:none`
clone per repo, reused across runs; worktrees are removed after each review.

**One guard worth knowing.** If verification could not reach a verdict on *any* blocker and nothing
survived, the correct verdict is unknown, so nothing is posted at all and the PR is re-queued —
the cycle exits 3. That is deliberate: an approval built on findings nobody checked is the worst
thing this tool can do.

## The three labels

| Label | Meaning |
|---|---|
| `review-requested` | The author is asking for a review. The only trigger. Re-add it after pushing fixes. |
| `review-in-progress` | A cycle has claimed this PR. Transient. If it sticks, a cycle was killed mid-review. |
| `review-error` | A per-PR failure. **Never retried automatically.** Investigate, remove it, then re-add `review-requested`. |

Names are configurable under `labels` in `team.json`; `doctor` creates them in each allowlisted
repo if they are missing. Slack reactions are configurable too, under `slack.emoji` — the keys are
`inReview`, `approved`, `changesRequested` and `error` (defaults `eyes`, `white_check_mark`, `x`,
`warning`). Exactly one state reaction is carried at a time: the previous one comes off as the new
one goes on.

## Tuning criteria

Criteria live in `review-criteria.md` in the config dir, and `criteria/review-criteria.example.md`
in this repo is the annotated template — it explains the blocking/nit bar, carries a worked
before/after, and describes the tuning loop. Read it before editing rules.

The short version:

- Only `blocking` findings are verified; the verifier is told to refute when uncertain, so a
  weakly-evidenced blocker is dropped after being paid for. Vague rules cost tokens and produce
  nothing.
- A finding is `file`, `line`, `claim`, `why`. A rule that cannot name a locatable consequence
  cannot produce a finding.
- After an edit, `cycle --dry-run --config <dir>` proves the file loads and shows which PRs would
  be picked up. It spends no model call and posts nothing — but it does still need the credentials,
  because it lists PRs to build that queue. It cannot show what a rule *finds*; only a live cycle
  does that.
- Every review body ends with `criteria sha256:…`, also stored in the ledger as `criteriaVersion`.
  Same hash across rounds means the code changed; a different hash means the criteria did.

Never tune by editing the prompts in `src/review.mjs`. Criteria belong in the config dir so the
team owns them and their history.

## Cost

Telemetry is **off by default**: no file is written and no cost data is collected. To measure
before considering depth 2, set `"telemetry": true` in `team.json`, let it run a few days, then:

```bash
node ~/code/pr-review-bot/src/cli.mjs report          # avg/max/total per review, by phase and model
node ~/code/pr-review-bot/src/cli.mjs report --json   # same numbers, machine-readable
node ~/code/pr-review-bot/src/cli.mjs report --reset  # print the summary, then delete the log
```

Turn it back off afterward. `report` is purely local — it reads
`~/.config/pr-review-bot/telemetry.jsonl` and needs no config dir and no credentials, so "what did
this cost me" is answerable even from a broken installation.

Use `--reset` to start a fresh measurement window — after tuning criteria, or when old numbers are
no longer comparable. It prints the summary *first* and then deletes the log, so nothing
accumulates on disk and you cannot lose the figure you were about to read.

What drives the bill: one review call per PR (two if the first response was not valid JSON), plus
one verification call per blocking finding (two if its first answer was unparseable). Criteria that
generate many blockers cost proportionally more, whether or not those blockers survive.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Cycle completed. |
| 1 | Configuration or usage error — nothing ran. The message names what to fix. |
| 2 | `doctor` found red checks. The command worked; the setup did not. Only `doctor` returns this. |
| 3 | Transient abort. The PR is back under `review-requested` and retries next cycle. Do nothing. |
| 4 | At least one PR failed and now wears `review-error`. Never auto-retried; a human must look. |
| 5 | A bug in this tool. Re-run with `PR_REVIEW_DEBUG=1` for the stack trace. |

3 and 4 are the pair that matters: 3 clears itself, 4 never does.

## When something looks stuck

- **`review-in-progress` stuck on a PR** — a cycle was killed mid-review. Remove it and re-add
  `review-requested`.
- **Every PR fails identically** — run `doctor`. The usual causes are `claude` not being on the
  PATH the bot actually runs under, or the credential not being the App installation (GitHub
  answers 422 "Can not approve your own pull request" only at post time, after the review is paid
  for).
- **A review body appears as a plain comment headed with a warning** — GitHub rejected the formal
  review, so the text was preserved rather than lost. The PR wears `review-error`.
- **Slack is silent but reviews land** — expected under failure. Slack is a mirror, never a gate;
  every Slack call is best-effort and logs `Slack … failed for owner/repo#N`.
- **Mentions are plain text, not pings** — the author is missing from `authorMap` in `team.json`.
  `doctor` lists open-PR authors that are unmapped.

## Do not

- Do not add merge or push calls. The bot reviews; humans merge.
- Do not run two loops against the same team config.
- Do not pass `--model`, or add a `"model"` key to `team.json` — it is refused outright, with a
  message. Headless children inherit the operator's saved Claude CLI default by design; change it
  with `/model`.
- Do not set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` in the shell that starts the loop. Each
  takes reviews off your Claude subscription and meters them elsewhere, forever, silently.
  `doctor`'s `claude auth mode` check reports them.
- Do not put secrets in `team.json` or `review-criteria.md` — both are scanned, at different
  moments. A token-shaped value in `team.json` stops every command at load (exit 1); one in
  `review-criteria.md` is caught only by `doctor`, as a red check. Secrets belong in
  `~/.config/pr-review-bot/.env` or exported env vars.
- Do not clear a `review-error` label without reading why it was applied.
