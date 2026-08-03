# pr-review-bot

A local CLI that watches your team's repos for pull requests the author has explicitly labelled
`review-requested`, reviews them with headless Claude against criteria your team wrote, posts an
approve or request-changes review as a GitHub App, and mirrors the verdict onto a Slack thread. You
run it yourself, in a terminal you own, on your own Claude subscription — there is no server, no
webhook, no queue and no database. Every team runs its own copy with its own GitHub App, its own
Slack app, its own channel, its own repo allowlist, its own title prefix and its own criteria file,
so two teams sharing a monorepo never see each other's reviews.

## What it does

```
author adds `review-requested`
        │
        ▼
 local cycle (every 5 min)  ──► Slack: announce + 👀
        │
        ├─ same head SHA? ──► thread "no new commits", drop label, stop
        │
        ▼
 review vs. criteria ──► refute blockers ──► GitHub: APPROVE | REQUEST_CHANGES
        │
        ▼
 Slack: swap 👀 → ✅ / ❌  (+ threaded @author on ❌)
        │
        ▼
 drop `review-in-progress`, update ledger comment
```

The label is the only trigger. Nothing is reviewed because it was opened, updated or merged —
only because a human asked.

## Getting started

Fifteen minutes, in this order. [`docs/setup.md`](docs/setup.md) carries every step in full — the
commands, the exact permissions, and what each screen asks for.

1. **[Clone it — never fork.](docs/setup.md#1-clone-it--never-fork)** No team configuration ever
   lives in this repo, so upgrading is `git pull` with nothing to rebase.
2. **[Create the GitHub App](docs/setup.md#2-create-the-github-app)** with four repository
   permissions and no webhook, install it on the repos you want reviewed, then capture the App ID,
   the installation ID and a private key. The App identity is not a formality: GitHub answers
   `422 Can not approve your own pull request` to a personal token, and only at post time.
3. **[Create the Slack app](docs/setup.md#3-create-the-slack-app)** with exactly two bot scopes,
   invite it to your review channel, and copy the channel ID.
4. **[Write the secrets file](docs/setup.md#4-write-the-secrets-file)** — four variables in
   `~/.config/pr-review-bot/.env`.
5. **[Choose a config home](docs/setup.md#5-choose-a-config-home)** for `team.json` and
   `review-criteria.md`, meant to be committed to a repo your team owns, then
   **[edit `team.json`](docs/setup.md#6-edit-teamjson)** — repos, title prefix, channel, authors.
6. **[Run `doctor`](docs/setup.md#7-run-doctor--it-must-be-all-green).** It must be all green
   before anything else happens.
7. **[Dry-run against a real labelled PR](docs/setup.md#8-dry-run-against-a-real-labelled-pr)** to
   read a review without publishing one. It spends real quota, so pair it with `--limit 1`.
8. **[Install the plugin](docs/setup.md#9-install-the-plugin)**, then
   **[go live](docs/setup.md#10-go-live)** in a dedicated terminal session:

   ```
   /loop 5m /pr-review-bot:pr-watch
   ```

Two things to know before you start, both about cost: `ANTHROPIC_API_KEY` — and `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX` — silently switches
billing from your Claude subscription to metered API usage, and reviews draw on the operator's own
personal Claude quota. `doctor` fails on all five variables. See
[Prerequisites](docs/setup.md#prerequisites).

## How it works

Two layers, deliberately separated.

**Deterministic Node plumbing** does everything that must not vary: listing PRs, filtering by label
and title prefix, moving labels, building the diff, checking out the head, posting the review,
reconciling Slack reactions, writing the ledger. It has zero dependencies. The model never chooses
a label, a verdict mapping or an API call.

**Headless Claude** does only the judgment. A `claude -p` child reads a real checkout of the PR head
with `Read`, `Grep` and `Glob` and returns a strict JSON verdict. A second child then tries to
*refute* each blocking finding — the first fifteen of them, and nits never — a claim surviving only
if a concrete path to the stated failure can be traced. Surviving blockers map to
`REQUEST_CHANGES`, none to `APPROVE`. Anything the refutation could not judge, including findings
past that cap, is named in the review's *Not verified* section and blocks nobody; see
[`docs/criteria.md`](docs/criteria.md).

**All state lives in GitHub.** There is no local database. Two facts carry everything: the bot's own
past reviews (used for a head-SHA check — an unchanged head is never re-reviewed, and costs zero
model calls) and a sticky ledger comment holding the round history, the Slack message binding, and
the hash of the criteria that produced each verdict. Kill the process mid-cycle and the next run
picks up from what GitHub says. That second fact is a plain GitHub comment, editable by anyone with
write access on the repo, and it is not an audit trail — see
[The ledger is not tamper-proof](docs/operating.md#the-ledger-is-not-tamper-proof) for what an edit
costs.

**Three labels carry the whole lifecycle.** `review-requested` is the author's ask and the only
trigger. `review-in-progress` is the claim a cycle takes out on a PR, and should exist for minutes,
not hours. `review-error` is a per-PR failure: sticky, an outright exclusion from selection, and
never cleared by anything but a human. The names are configurable, and `doctor` creates whatever you
configured in each allowlisted repo. See
[The three labels](docs/operating.md#the-three-labels).

**The label transitions rather than simply being removed** because the transition *is* the lock and
the audit trail. Removing `review-requested` and adding `review-in-progress` happens before any
expensive work, so an overlapping cycle sees the PR is already taken. And when a run ends, the label
it leaves behind is the whole decision: `review-requested` means try again next cycle,
`review-error` means stop and fetch a human. A PR wearing no label at all would be one no cycle ever
looks at again.

## Documentation

| Document | What it covers |
|---|---|
| [`docs/setup.md`](docs/setup.md) | Prerequisites, the full fifteen-minute walkthrough, and every key `team.json` accepts |
| [`docs/criteria.md`](docs/criteria.md) | Writing criteria that produce findings worth reading. The highest-value document if you are adopting this |
| [`docs/operating.md`](docs/operating.md) | Day-2 operations: the labels, re-reviews, clearing `review-error`, cost, upgrades, exit codes, troubleshooting |
| [`docs/architecture.md`](docs/architecture.md) | Notes for contributors: the module map, the injection convention, the depth-2 seam |
| [`TESTING.md`](TESTING.md) | Standing the tool up on a second machine or under a different GitHub account, and walking a sandbox PR end to end |

> **Setting this up somewhere new?** Read [§2 of `TESTING.md`](TESTING.md) first if the GitHub
> account is changing — the bot recognises its own past work by an identity derived from the App, so
> a different App reviews previously-reviewed PRs from scratch.

## Non-goals

- **Merging PRs, or pushing code fixes.** The bot reviews; humans merge. There is no merge, push or
  write-to-branch call anywhere in `src/`, and no change may add one.
- **Auto-applying labels.** The author's `review-requested` label is the only trigger.
- **Reviewing PRs whose titles do not match the team prefix.**
- **Cross-organization support** in v1.
- **Leader election or distributed locking between runners.** One runner per team, by convention.
- **Publishing to a shared or third-party plugin marketplace.** The repo carries its own
  single-plugin `.claude-plugin/marketplace.json` pointing back at itself, so
  `claude plugin marketplace add <clone or git URL>` installs it directly. Nothing is submitted
  anywhere, and there is no marketplace for a team to maintain.
- **Inline, line-anchored review comments** in v1 — findings reference `file:line` in the review
  body instead. Inline comments require validating each line against the diff hunks or the API
  rejects the whole review; a documented later enhancement, config-gated and default off.
- **Any web UI or dashboard.**

Draft PRs **are** reviewed when labelled — the label is explicit opt-in.
