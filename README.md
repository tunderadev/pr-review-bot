# pr-review-bot

A local CLI that watches your team's repos for pull requests the author has explicitly labelled
`review-requested`, reviews them with headless Claude against criteria your team wrote, posts an
approve or request-changes review as a GitHub App, and mirrors the verdict onto a Slack thread. You
run it yourself, in a terminal you own, on your own Claude subscription — there is no server, no
webhook, no queue and no database. Every team runs its own copy with its own GitHub App, its own
Slack app, its own channel, its own repo allowlist, its own title prefix and its own criteria file,
so two teams sharing a monorepo never see each other's reviews.

## 1. What it does

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

## 2. How it works

Two layers, deliberately separated.

**Deterministic Node plumbing** does everything that must not vary: listing PRs, filtering by label
and title prefix, moving labels, building the diff, checking out the head, posting the review,
reconciling Slack reactions, writing the ledger. It has zero dependencies. The model never chooses
a label, a verdict mapping or an API call.

**Headless Claude** does only the judgment. A `claude -p` child reads a real checkout of the PR head
with `Read`, `Grep` and `Glob` and returns a strict JSON verdict. A second child then tries to
*refute* each blocking finding; a claim survives only if a concrete path to the stated failure can
be traced. Surviving blockers map to `REQUEST_CHANGES`, none to `APPROVE`.

**All state lives in GitHub.** There is no local database. Two facts carry everything: the bot's own
past reviews (used for a head-SHA check — an unchanged head is never re-reviewed, and costs zero
model calls) and a sticky ledger comment holding the round history, the Slack message binding, and
the hash of the criteria that produced each verdict. Kill the process mid-cycle and the next run
picks up from what GitHub says.

**The label transitions rather than simply being removed** because the transition *is* the lock and
the audit trail. Removing `review-requested` and adding `review-in-progress` happens before any
expensive work, so an overlapping cycle sees the PR is already taken. And when a run ends, the label
it leaves behind is the whole decision: `review-requested` means try again next cycle,
`review-error` means stop and fetch a human. A PR wearing no label at all would be one no cycle ever
looks at again.

## 3. Prerequisites

| | |
|---|---|
| **Node** | >= 24 (`package.json` `engines`). No `npm install` — the tool has zero dependencies. |
| **git** | On the `PATH` of the process that runs the loop. Used for the managed clone and worktrees. |
| **Claude Code CLI** | Installed and **logged in with a Claude subscription**. Every review is a `claude -p` subprocess. |
| **GitHub** | Permission to create a GitHub App in your org and install it on the repos you want reviewed. |
| **Slack** | Permission to create a Slack app and install it to the workspace, plus one channel per team. |

Three things about cost, stated plainly before you start:

- **`ANTHROPIC_API_KEY` in the environment silently switches billing from your Claude subscription
  to metered API usage.** So do `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`. A loop polling every five minutes makes
  that expensive quietly, because nothing on screen says the run stopped being free. `doctor` fails
  on all five.
- **Reviews draw on the operator's personal Claude quota** — the same quota funding their own
  interactive work, and Max plans cap Opus more tightly than they cap overall usage. Whoever runs
  the loop pays for it in headroom, so choose deliberately rather than by whoever set it up first.
- **`--dry-run` spends real quota.** It is the live path with the mutating calls removed: it runs
  the actual review and prints what it would have posted. Pair it with `--limit 1`.

## 4. Adopt in 15 minutes

Everything below is copy-pasteable. Substitute your own paths, IDs and names.

### 1. Clone it — never fork

```bash
git clone <this repo> ~/code/pr-review-bot
```

**Clone, do not fork.** No team configuration ever lives in this repo, so upgrading is `git pull`
with nothing to rebase. A fork's only effect is to make upgrades your problem.

### 2. Create the GitHub App

GitHub → your org → **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook**: uncheck *Active*. This tool polls; it receives nothing.
- **Repository permissions** — exactly these:

  | Permission | Level | Why |
  |---|---|---|
  | Pull requests | **Read and write** | Post `APPROVE` / `REQUEST_CHANGES` reviews |
  | Issues | **Read and write** | Move the three labels and maintain the sticky ledger comment |
  | Contents | **Read** | Clone the PR head to review it |
  | Metadata | **Read** | Mandatory; GitHub selects it for you |

  `doctor` reads the installation's actual grant and fails if `pull_requests` is below `write`,
  `issues` below `write`, or `contents` below `read`. Grant nothing else.

- Create it, then **Install App** on the repos you want reviewed.

Now capture three things:

- **App ID** — on the App's *General* settings page.
- **Installation ID** — open the App's **Configure** page for your org and read it out of the URL:
  `…/settings/installations/<this number>`.
- **Private key** — *General → Private keys → Generate a private key*. It downloads a `.pem`:

  ```bash
  mkdir -p ~/.config/pr-review-bot
  mv ~/Downloads/your-app.*.private-key.pem ~/.config/pr-review-bot/app-private-key.pem
  chmod 600 ~/.config/pr-review-bot/app-private-key.pem
  ```

The App identity is not a formality. GitHub answers `422 Can not approve your own pull request` to a
personal token, and only at post time — after a full review has already been paid for.

### 3. Create the Slack app

api.slack.com/apps → **Create New App → From scratch**, pick your workspace.

- **OAuth & Permissions → Bot Token Scopes** — exactly two:

  | Scope | Why |
  |---|---|
  | `chat:write` | Post the announcement and the threaded reply |
  | `reactions:write` | Add **and remove** the state reaction (both halves need it) |

  Nothing in the cycle looks a user up by email or profile, so `users:read` and `users:read.email`
  are not required — authors are mapped explicitly in `authorMap`.

- **Install to Workspace**, then copy the **Bot User OAuth Token** (starts `xoxb-`).
- **Invite the bot to your review channel**: type `/invite @your-bot-name` in the channel. Without
  this every Slack call fails with `not_in_channel`.
- **Copy the channel ID**: right-click the channel → *View channel details* → the ID (`C…`) is at
  the bottom of that panel.

### 4. Write the secrets file

```bash
mkdir -p ~/.config/pr-review-bot
cp ~/code/pr-review-bot/.env.example ~/.config/pr-review-bot/.env
$EDITOR ~/.config/pr-review-bot/.env
```

Four variables, all required, all non-empty:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/.config/pr-review-bot/app-private-key.pem
GITHUB_APP_INSTALLATION_ID=987654
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

This file is read first and anything already exported in the shell wins, so an `export` is always a
deliberate override. **`PR_REVIEW_CONFIG_DIR` is read from the real process environment only —
putting it in this file does nothing at all.**

### 5. Choose a config home

The config directory holds two files, `team.json` and `review-criteria.md`, and **both must be
present**. It is meant to be committed to a repo your team owns.

*Single-repo team* — put it in the product repo, where `cd`-ing in is enough:

```bash
mkdir -p ~/code/your-product/.claude/pr-review
cp ~/code/pr-review-bot/config/team.example.json         ~/code/your-product/.claude/pr-review/team.json
cp ~/code/pr-review-bot/criteria/review-criteria.example.md ~/code/your-product/.claude/pr-review/review-criteria.md
```

*Multi-repo team* — a small config repo, selected explicitly:

```bash
mkdir -p ~/code/team-review-config
cp ~/code/pr-review-bot/config/team.example.json         ~/code/team-review-config/team.json
cp ~/code/pr-review-bot/criteria/review-criteria.example.md ~/code/team-review-config/review-criteria.md
export PR_REVIEW_CONFIG_DIR=~/code/team-review-config   # in the shell that starts the loop
```

Resolution has four tiers, tried in order:

| Tier | Source | Behaviour |
|---|---|---|
| 1 | `--config <dir>` | **Hard error** if it holds no `team.json` — never falls through |
| 2 | `PR_REVIEW_CONFIG_DIR` | **Hard error** if it holds no `team.json` — never falls through |
| 3 | `./.claude/pr-review/` | Relative to the **process's working directory** |
| 4 | `~/.config/pr-review-bot/default/` | Last resort |

An explicit flag or env var is an instruction, not a suggestion: falling through from a typo would
run the bot under another team's profile and post real reviews under it. Tier 3 depends on where you
started the process, which is easy to get wrong from a loop — `doctor` prints which tier won, and
says so when a `PR_REVIEW_CONFIG_DIR` you set lost to a `--config` flag.

**Never put secrets in `team.json`.** It is meant to be committed. Validation rejects
credential-shaped values and stops every command at load.

### 6. Edit `team.json`

```json
{
  "team": "platform",
  "owner": "acme",
  "repos": ["acme/storefront", "acme/checkout-api"],
  "titlePrefix": "^\\[PLAT\\]",
  "slack": { "channel": "C0123ABC" },
  "authorMap": { "your-github-login": "U0123ABC" }
}
```

- `repos` — the allowlist, `owner/name`, non-empty. The App must be installed on each.
- `titlePrefix` — a **JavaScript regex source string**, tested against the PR title. Anchor it
  yourself with `^`; `"\\[PLAT\\]"` without the anchor matches anywhere in the title. Remember JSON
  needs the backslashes doubled.
- `slack.channel` — the channel **ID** (`C…`), not `#name`.
- `authorMap` — GitHub login → Slack member ID (their profile → *Copy member ID*). An unmapped
  author still gets their thread reply, but as unlinked text rather than a ping.

Everything else has a default; see [section 5](#5-config-reference).

### 7. Run `doctor` — it must be all green

```bash
cd ~/code/your-product          # or: export PR_REVIEW_CONFIG_DIR=…
node ~/code/pr-review-bot/src/cli.mjs doctor
```

```
✓ claude auth mode — No ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX — headless reviews draw on your Claude subscription.
✓ claude cli — 2.1.220 (Claude Code) at /Users/you/.local/bin/claude — the binary is present and executable. …
✓ config dir — /Users/you/code/your-product/.claude/pr-review (from cwd).
✓ secrets not committed — No .env or .env.local tracked by git in the config dir.
✓ no credentials in config — No token-shaped values in team.json or review-criteria.md.
✓ github identity — Authenticated as the GitHub App installation acme-pr-review[bot], …
✓ review capability — The installation grants pull_requests: write, issues: write and contents: read, …
✓ repos configured — 2 repo(s) allowlisted: acme/storefront, acme/checkout-api
✓ repo access: acme/storefront — installation can read pull requests (3 open)
✓ label review-requested on acme/storefront — present (created if it was missing)
✓ label review-in-progress on acme/storefront — present (created if it was missing)
✓ label review-error on acme/storefront — present (created if it was missing)
… (the same access + three label checks repeat for acme/checkout-api)
✓ slack post — Posted ts 1735689600.000100 to C0123ABC.
✓ slack reactions — Added and removed :white_check_mark: on the check message — reactions:write is present.
✓ author mapping — 1 author(s) mapped. Every open PR author is covered.
✓ telemetry — Disabled (the default) — no telemetry file is written and no cost data is collected.

All checks passed.
```

`doctor` exits `0` when everything is green and `2` when anything is red. It posts one real message
to your Slack channel (that is the connectivity check), creates the three labels in each repo if
they are missing, and makes **no model call** — so it proves the binary is present but not that you
are logged in. The first live cycle proves that.

### 8. Dry-run against a real labelled PR

Open a PR whose title matches your prefix, add `review-requested`, then:

```bash
node ~/code/pr-review-bot/src/cli.mjs cycle --dry-run --limit 1
```

```
[dry-run] 1 PR(s) would be reviewed:
  acme/storefront#12 (abc1234) "[PLAT] Add order history"
[dry-run] Reviewing them now for real: same prompts, same criteria, same model calls, so this spends the same Claude subscription quota a live review does. Nothing is posted, labelled, or mirrored to Slack — each review is printed below instead.

[dry-run] acme/storefront#12 — would post REQUEST_CHANGES:

## 🔧 Changes requested — Round 1
…
acme/storefront#12 dry_run (changes_requested)
1 PR(s): 1 dry_run
```

It mutates nothing — no review, no labels, no ledger comment, no Slack — so the PR keeps its label
and you can run it again immediately. It also ignores the same-head-SHA skip on purpose, which is
what lets you re-run against an already-reviewed PR while tuning. `--limit 1` is not optional
etiquette: without it a dry run reviews up to `maxPerCycle` PRs and you pay for all of them on every
iteration.

### 9. Go live

Make `/pr-watch` available by loading this clone as a plugin — symlink it into your skills
directory, which auto-loads next session:

```bash
mkdir -p ~/.claude/skills
ln -s ~/code/pr-review-bot ~/.claude/skills/pr-review-bot
```

Then, in a **dedicated terminal session** started from your config home (or with
`PR_REVIEW_CONFIG_DIR` exported):

```
/loop 5m /pr-watch
```

That is the whole operation: one cycle every five minutes, reporting two or three lines each time.
Most cycles print `0 PR(s): none`, which is the healthy result. If you would rather not use the
slash command, `node ~/code/pr-review-bot/src/cli.mjs cycle` on any timer does the identical work.

**Exactly one runner per team.** See [section 7](#7-day-2-operations).

## 5. Config reference

Every key `team.json` accepts. Required keys have no default and the run stops at load without them.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `team` | string | **required** | Human-readable team label. Not read by any code path — it is there so a config file identifies itself. |
| `owner` | string | **required** | Org or user the team belongs to. Also not read by any code path; `repos` carries the real owner. |
| `repos` | array of `"owner/name"` | **required** | The allowlist. Must be non-empty. The App must be installed on each. |
| `titlePrefix` | string (JS regex source) | **required** | Tested against the PR title. Must compile as a regex. Anchor it with `^` yourself. |
| `slack.channel` | string | **required** | Channel **ID** (`C…`), non-empty. The bot must be invited to it. |
| `slack.emoji.inReview` | string | `eyes` | Reaction while a review is running (👀). |
| `slack.emoji.approved` | string | `white_check_mark` | Reaction on approve (✅). |
| `slack.emoji.changesRequested` | string | `x` | Reaction on request-changes (❌). |
| `slack.emoji.error` | string | `warning` | Reaction on a per-PR failure (⚠️). |
| `labels.requested` | string | `review-requested` | The trigger label. |
| `labels.inProgress` | string | `review-in-progress` | The claim label. |
| `labels.error` | string | `review-error` | The sticky failure label. |
| `authorMap` | object, login → Slack member ID | `{}` | Who to `@`-mention on request-changes. Unmapped authors degrade to unlinked text. |
| `maxPerCycle` | number | `3` | Cap on PRs reviewed per cycle, applied **across** repos so no repo starves another. |
| `maxDiffLines` | number | `3000` | Diff budget. Files are added smallest-first; anything excluded is named in the review body. |
| `depth` | `"standard"` | `"standard"` | Only `"standard"` is accepted. `"deep"` is rejected with a message — it is not implemented. |
| `telemetry` | boolean | `false` | When false nothing is written to disk and no cost data is collected. |
| `clonesDir` | string (path) | `~/.cache/pr-review-bot/clones` | Where the managed `--filter=blob:none` clones live, one per repo, reused across runs. |
| `model` | — | **rejected** | Not supported and refused outright. Headless children are spawned without `--model` so they inherit the model you saved as your own Claude CLI default. Accepting the key and ignoring it would leave you believing otherwise; change your model with `/model`. |

Shape is checked for the required keys, for `labels` (an object of non-empty strings), for `slack`
(an object with a non-empty string `channel`), for `titlePrefix` (a compilable regex) and for
`depth`. The numeric and boolean keys are taken as written, so a typo there fails at use rather than
at load. Every value is also scanned for credential shapes; a token-shaped value anywhere in
`team.json` stops every command at load with exit `1`.

## 6. Writing good review criteria

`review-criteria.md` is pasted into the reviewer's prompt as authoritative. It is the entire
interface, and it is where all of the review quality lives — the machinery is generic.
`criteria/review-criteria.example.md` in this repo is the annotated starting template; read it
before editing rules.

The one fact that shapes everything: **only `blocking` findings are ever verified, and the verifier
is told to refute when uncertain.** A vague blocking rule does not produce a bad review, it produces
*nothing* — after you have paid for a review call plus one verification call per claim it invented.

A finding is exactly four fields: `file`, `line`, `claim`, `why`. A rule that cannot be violated at
a specific line, with a specific consequence, cannot produce a finding at all.

### Worked example

**Vague rule:**

```
- Watch for error handling issues.
```

What it produces:

```json
{ "severity": "blocking", "file": "src/api/orders.ts", "line": 88,
  "claim": "There is an error handling issue here",
  "why": "This could cause problems" }
```

What becomes of it: the verifier is handed that claim and asked to trace a concrete path to the
stated failure. "Problems" names nothing to go and look for, so it refutes on uncertainty and the
finding vanishes. The author sees an approval. You paid two model calls to publish nothing.

**The same defect, under a concrete rule:**

```
- **Swallowed errors.** A caught error that is logged and then discarded is blocking; name the
  swallowed error and the caller that cannot see it.
```

What it produces:

```json
{ "severity": "blocking", "file": "src/api/orders.ts", "line": 88,
  "claim": "listOrders() catches the query error, logs it at debug, and returns [], so no caller can tell an empty account from a failed lookup",
  "why": "renderDashboard (src/pages/dashboard.tsx:31) has no error branch and renders \"No orders yet\", so a database outage shows every customer an empty order history" }
```

What becomes of it: the verifier greps for callers of `listOrders`, finds `renderDashboard`, looks
for an error branch, and cannot find one. It cannot refute the claim, so it survives:

> - **src/api/orders.ts:88** — listOrders() catches the query error, logs it at debug, and returns [], so no caller can tell an empty account from a failed lookup
>   - renderDashboard (src/pages/dashboard.tsx:31) has no error branch and renders "No orders yet", so a database outage shows every customer an empty order history
>   - _Verified: no caller distinguishes the empty result from a failure_

The difference is not tone. The second rule tells the reviewer which two things to go and find, and
gives the verifier something it can fail to refute.

### The feedback loop

- **A false blocker was posted** → find the rule whose wording the claim echoes, and either narrow
  it with the condition it was missing or add the exempting pattern to **Never blocking**. Deleting
  the rule outright is usually an overcorrection.
- **A real problem was missed** → write it as a rule under **Always blocking** that clears the bar:
  trigger, evidence to name, consequence to state. If the evidence lives outside the diff, say so —
  the reviewer has the whole tree checked out but will not go looking unless a rule tells it to.
- **Then verify**, against a real PR, publishing nothing:

  ```bash
  node ~/code/pr-review-bot/src/cli.mjs cycle --dry-run --limit 1
  ```

  Edit → dry-run → read the rendered review → adjust → repeat.

Heuristic: if *could*, *might*, *consider*, *fragile* or *in the future* appears in a blocking
claim, it is a mislabelled nit and the verification pass will delete it a minute later.

Never tune by editing the prompts in `src/review.mjs`. Criteria belong in the config dir so your
team owns them and their history. Every review body ends with `criteria sha256:…`, also stored in
the ledger — when round 3 disagrees with round 2, the same hash means the code changed and a
different hash means you did.

## 7. Day-2 operations

### The three labels

| Label | Meaning | Who moves it |
|---|---|---|
| `review-requested` | The author is asking for a review. **The only trigger.** | Author adds it. The bot removes it when it claims the PR, and restores it on a transient failure. |
| `review-in-progress` | A cycle has claimed this PR. Transient — it should exist for minutes, not hours. | Bot only. If it sticks, a cycle was killed mid-review; remove it by hand. |
| `review-error` | A per-PR failure. **Sticky — never retried automatically.** | Bot adds it. **Only a human removes it.** |

Names are configurable under `labels`; `doctor` creates whatever you configured in each allowlisted
repo if it is missing.

### Requesting a re-review

Push your fixes, then **add `review-requested` again**. The label is removed when a review is
posted, so it is always an explicit ask. If you re-add it without pushing, the head-SHA check
catches it: the bot thread-replies "no new commits since round N", drops the label, and makes zero
model calls.

### The emoji

Exactly one state reaction is carried on the announcement message at a time — the previous one comes
off as the new one goes on, so a PR that went ❌ then ✅ never wears both.

| Emoji | Key | State |
|---|---|---|
| 👀 | `inReview` | A review is running right now |
| ✅ | `approved` | Approved — no blocking findings survived verification |
| ❌ | `changesRequested` | Changes requested — the thread reply names the surviving blockers |
| ⚠️ | `error` | The review failed; the PR wears `review-error` and a human is needed |

### Clearing `review-error`

Nothing will ever clear it for you, and that is the point — a PR that failed once would otherwise
fail every five minutes forever, on your quota, with nobody watching.

1. Read the cycle log line: `owner/repo#12 failed: <reason>`.
2. Fix the cause (it is usually configuration, a wedged review, or a PR the diff budget cannot cope
   with).
3. Remove `review-error`.
4. Add `review-requested` to re-queue it.

A stuck `review-in-progress` is different: it means a cycle was killed mid-review, not that anything
is wrong with the PR. Remove it by hand and re-add `review-requested`.

### Upgrades

```bash
cd ~/code/pr-review-bot && git pull
```

That is all of it. No team configuration lives in this repo, so there is nothing to merge and
nothing to re-apply. Run `doctor` afterwards.

### Measuring cost

Telemetry is **off by default** and writes nothing at all when disabled. To measure — before
deciding whether a deeper review mode is affordable, or when reviews feel expensive:

1. Set `"telemetry": true` in `team.json`.
2. Let it run for a few days of real traffic.
3. Read it:

```bash
node ~/code/pr-review-bot/src/cli.mjs report          # avg/max/total per review, by phase and model
node ~/code/pr-review-bot/src/cli.mjs report --json   # same numbers, machine-readable
node ~/code/pr-review-bot/src/cli.mjs report --reset  # print the summary, THEN delete the log
```

```
Reviews measured: 2
Cost per review: avg $0.226, max $0.226
Total: $0.45
  review: 2 call(s), $0.410
  verify: 1 call(s), $0.041
  claude-opus-4-5: 3 call(s), 56300 in / 4080 out, $0.451

Depth 2 runs roughly 3-4x the review phase. Projected avg: $0.789 per review.
```

4. Turn it back off.

`--reset` starts a clean measurement window: it prints the summary **first** and then deletes
`~/.config/pr-review-bot/telemetry.jsonl`, so nothing accumulates on disk and you cannot lose the
figure you were about to read. Nothing is kept — no rotation, no `.bak`.

`report` is purely local. It needs no config directory and no credentials, so "what did this cost
me" is answerable even from a broken installation.

What drives the bill: one review call per PR (two if the first response was not valid JSON), plus
one verification call per **blocking** finding (two if its first answer was unparseable). Nits are
never verified. Criteria that generate many blockers cost proportionally more whether or not those
blockers survive.

### One runner per team

Designate exactly one person to run the loop for a given config, and say who it is.

- **There is no distributed lock.** The `review-in-progress` claim is a read-modify-write with a
  small race window. It makes double-review unlikely, not impossible — two runners can both read
  "unclaimed" in the same instant and both review the same PR, posting two reviews.
- **Each runner spends their own subscription quota**, on the same plan funding their interactive
  work, so "who runs it" is a real cost decision and not an implementation detail.

### Exit codes

The loop and any cron wrapper branch on these, so each means exactly one thing.

| Code | Meaning | What to do |
|---|---|---|
| 0 | Cycle completed | Nothing |
| 1 | Configuration or usage error — nothing ran | Read the message; it names what to fix. Then `doctor` |
| 2 | `doctor` found red checks | Fix them. Only `doctor` returns this |
| 3 | Transient abort | **Nothing.** The PR is back under `review-requested` and retries next cycle |
| 4 | At least one PR failed | It wears `review-error` and is never auto-retried. A human must look |
| 5 | A bug in this tool | Re-run with `PR_REVIEW_DEBUG=1` for the stack trace |

3 and 4 are the pair that matters: 3 clears itself, 4 never does.

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| `422 Can not approve your own pull request` in a failure line, or the review body appears as a plain comment headed with a warning | The credential in use is **not** the App installation — usually a personal `GITHUB_TOKEN` shadowing the App variables. Run `doctor` and read `github identity`; it must say `…[bot]`. The review body is preserved as a comment rather than lost, and the PR wears `review-error` |
| `Slack chat.postMessage failed: not_in_channel` | The bot is not a member of the channel. `/invite @your-bot-name` in it |
| `Slack chat.postMessage failed: channel_not_found` | `slack.channel` is a name or a stale ID. It must be the channel **ID** (`C…`) from *View channel details*, and the bot must be able to see the channel |
| `doctor` is green on `slack post` but red on `slack reactions` | `reactions:write` is missing — it is a separate scope from `chat:write`. Add it and **reinstall** the app; a scope added without reinstalling does not take effect |
| Everything is green but nothing is ever picked up | (a) the PR title does not match `titlePrefix` — it is a regex, and `^\\[PLAT\\]` will not match `Add [PLAT] thing`; (b) the label on the PR is not the one in `labels.requested`; (c) the App is not installed on that repo |
| `No team.json found. Searched: …` | You are relying on the `./.claude/pr-review/` tier from the wrong working directory. Start the loop from the config home, or export `PR_REVIEW_CONFIG_DIR`, or pass `--config` |
| `doctor` reports a config dir you did not expect | Another tier won. The `config dir` line names the winner and says when a `PR_REVIEW_CONFIG_DIR` you set was shadowed by `--config` |
| The review landed on GitHub but Slack is silent | Expected under failure — Slack is a mirror, never a gate. Every Slack call is best-effort and logs `Slack … failed for owner/repo#N: …` above the summary. The GitHub review is the critical path |
| Mentions arrive as plain text instead of pings | The author is missing from `authorMap`. `doctor`'s `author mapping` check lists open-PR authors that are unmapped |
| A private repo fails to clone or fetch | The App needs `Contents: read` **and** must be installed on that repo. git runs with `GIT_TERMINAL_PROMPT=0` and cannot ask for a password, so a missing credential is a hard failure, not a prompt |
| Reviews cost far more than expected | Run `report`. Then trim the criteria (fewer, sharper blocking rules — each blocker costs a verification call whether or not it survives) or lower `maxDiffLines` |
| Every PR fails identically | Almost always `claude` not being on the `PATH` the bot actually runs under — a launchd/cron `PATH` is not your interactive shell's. `doctor`'s `claude cli` check settles it |
| `review-error` keeps coming back after you clear it | The PR genuinely keeps failing. Read the `owner/repo#N failed: …` line from the cycle log before re-queueing it again; re-adding the label without changing anything just buys the same failure |
| Exit 3 with `refutation could not verify … and none survived` | Deliberate. Verification could not reach a verdict on any blocker, so the correct verdict is unknown; nothing is posted and the PR is re-queued. An approval built on findings nobody checked is the worst thing this tool can do |
| Reviews suddenly cost money on the API instead of the subscription | One of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` is set in the shell that starts the loop. `doctor`'s `claude auth mode` check names the offender and prints the `unset` line |
| `"model" is not supported…` at startup | Remove the key. Headless children inherit your saved Claude CLI default by design; change it with `/model` |

## 9. Architecture notes for contributors

```bash
node --test        # the whole suite; no network, no `claude`, no remotes
```

| File | Responsibility |
|---|---|
| `src/config.mjs` | Config dir resolution precedence, validation, defaults, secret-leak detection |
| `src/discover.mjs` | Pure PR selection: label + prefix + state filtering, normalization, fairness ordering, cap |
| `src/github-auth.mjs` | App JWT minting, installation token exchange, app slug → bot login |
| `src/github.mjs` | GitHub REST client + transient/fatal error classification |
| `src/state.mjs` | Sticky-comment ledger parse/render, head-SHA already-reviewed check |
| `src/slack.mjs` | Slack Web API client (post, thread reply, add/remove reaction, email lookup) |
| `src/reactions.mjs` | Pure reaction reconciliation + author mention resolution |
| `src/checkout.mjs` | Managed clone + detached worktree at PR head; cleanup |
| `src/review.mjs` | Review prompt construction, headless `claude` invocation, strict verdict parsing |
| `src/verify.mjs` | Refutation prompt, refutation application to blocking findings |
| `src/render.mjs` | Review body markdown, Slack message text, verdict → GitHub event mapping |
| `src/telemetry.mjs` | Opt-in JSONL recording + aggregation for the depth-2 cost decision |
| `src/cycle.mjs` | The per-PR state machine, wiring all modules via injection. Supports dry-run |
| `src/doctor.mjs` | Preflight checks: tokens, installs, labels, Slack, secrets, Claude auth mode |
| `src/cli.mjs` | Arg parsing, command dispatch, secret redaction, the composition root |

Tests mirror source: `test/<module>.test.mjs`.

One note on that table: `slack.mjs` exposes `lookupUserByEmail`, and `reactions.mjs`'s
`resolveMention` still has an email tier, but **nothing in the cycle calls either** — GitHub does
not reliably expose an author's email on a PR payload, so `authorMap` is the only mapping that runs.
That is why the Slack app needs no `users:read` scope.

### The injection convention

Every module that reaches outside the process takes its escape hatch as a defaulted parameter:

- **`fetchImpl`** — every network module (`github.mjs`, `github-auth.mjs`, `slack.mjs`).
- **`spawnImpl`** — every module that starts a process (`review.mjs`, and `verify.mjs` through it).
- **`runGit`** — `checkout.mjs`, which also injects `remoteUrlFor`, `credentialFor` and `onClone`.

`src/cli.mjs`'s `main()` is the composition root: every collaborator is a defaulted parameter, so a
test can observe the whole wiring without a network, a git binary or a real `claude`.

**No test may make a live network call, spawn a real `claude`, or run git against a remote.** The
one deliberate exception is `test/checkout.test.mjs`, which drives the real `git` binary against a
local temp repository — offline and deterministic, and the only way to verify actual worktree
semantics.

### The depth-2 seam

`runReview` is **one lens**: a single prompt built from the criteria, run once, parsed strictly.
Depth 2 becomes a loop over configured lenses plus a synthesis step that merges their findings —
and leaves the refutation pass unchanged, because refutation operates on findings and does not care
where they came from. The decision to adopt it is made by enabling telemetry for a period and
reading measured cost per review against remaining subscription headroom, not by guessing; that is
what `report`'s projection line exists for. `depth: "deep"` is rejected today with a message
pointing at that path.

## 10. Non-goals

- **Merging PRs, or pushing code fixes.** The bot reviews; humans merge. There is no merge, push or
  write-to-branch call anywhere in `src/`, and no change may add one.
- **Auto-applying labels.** The author's `review-requested` label is the only trigger.
- **Reviewing PRs whose titles do not match the team prefix.**
- **Cross-organization support** in v1.
- **Leader election or distributed locking between runners.** One runner per team, by convention.
- **Publishing to a plugin marketplace.**
- **Inline, line-anchored review comments** in v1 — findings reference `file:line` in the review
  body instead. Inline comments require validating each line against the diff hunks or the API
  rejects the whole review; a documented later enhancement, config-gated and default off.
- **Any web UI or dashboard.**

Draft PRs **are** reviewed when labelled — the label is explicit opt-in.
