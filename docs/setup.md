# Setup

Everything needed to take pr-review-bot from nothing to a running loop: what must already be on the
machine, the fifteen-minute walkthrough, and every key `team.json` accepts.

Setting it up on a second machine, or under a different GitHub account? [`TESTING.md`](../TESTING.md)
covers that case, and walking a sandbox PR end to end.

## Prerequisites

| | |
|---|---|
| **Node** | >= 24 (`package.json` `engines`). No `npm install` — the tool has zero dependencies, and every command in this document is spelled `node <clone>/src/cli.mjs …`. |
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

**One note on the name `pr-review-bot`.** The CLI's own usage line and one of its error messages say
`pr-review-bot doctor`. That is the `bin` name declared in `package.json`, and because there is no
install step, nothing puts it on your `PATH` — `command -v pr-review-bot` finds nothing. Read every
such message as `node ~/code/pr-review-bot/src/cli.mjs doctor`, which is the form used throughout
these documents. If you would rather have the short name, opt in once:

```bash
cd ~/code/pr-review-bot && npm link     # optional — creates `pr-review-bot` on your PATH
```

`npm link` symlinks the clone rather than copying it, so `git pull` still upgrades what the command
runs. Nothing else in this document assumes you did it.

## Adopt in 15 minutes

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

**So pass `--config <dir>` explicitly in anything you do not personally type into a fresh shell** —
a tuning loop, a cron entry, a launchd job, an editor task. Every `--dry-run` invocation in this
document, in [`criteria.md`](criteria.md), in `skills/pr-review/SKILL.md` and in
`criteria/review-criteria.example.md` carries the flag for exactly that reason: the loop that tunes
criteria is the one most likely to be started from the wrong directory, and tier 3 will not tell you
it happened.

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

Everything else has a default; see [Config reference](#config-reference).
`config/team.example.json` is this same file with every optional key written out at its default —
the values are placeholders (`acme`, `C0123ABC`, `your-github-login`) and every one of them must be
replaced.

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
node ~/code/pr-review-bot/src/cli.mjs cycle --dry-run --limit 1 --config ~/code/your-product/.claude/pr-review
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

### 9. Install the plugin

The `pr-watch` command and the `pr-review` skill ship in this repo as a Claude Code plugin. The repo
is also its own single-plugin marketplace — `.claude-plugin/marketplace.json` points back at the
repo it lives in — so there is nothing to publish anywhere. Point `marketplace add` at your clone
and install from it:

```bash
claude plugin marketplace add ~/code/pr-review-bot --scope local
claude plugin install pr-review-bot@pr-review-bot --scope local
```

`marketplace add` accepts a filesystem path, a URL, or a GitHub `owner/repo`, so a team can add the
git URL directly and skip the clone for the plugin's sake. You still want the clone, because the
command it installs runs `node ~/code/pr-review-bot/src/cli.mjs`.

Confirm both components registered — `install` is quiet about what it actually loaded:

```bash
claude plugin list                    # pr-review-bot@pr-review-bot — Status: ✔ enabled
claude plugin details pr-review-bot   # Skills (2)  pr-review, pr-watch
```

If `details` does not name both `pr-review` and `pr-watch`, the install did not take and `/loop`
will run against a command that does not exist.

**Choose `--scope` deliberately.** It decides who gets the plugin and whether that choice is
committed. Both commands write into the settings file for the scope you name — `marketplace add`
adds an `extraKnownMarketplaces` entry, `install` adds an `enabledPlugins` entry — so pass the same
scope to both, or a teammate inherits half of the pair:

| `--scope` | Written to | Use it when |
|---|---|---|
| `user` (the default) | `~/.claude/settings.json` | You want it in every project on this machine |
| `project` | `.claude/settings.json` — **committed** | The whole team should get it from the repo |
| `local` | `.claude/settings.local.json` — gitignored | This machine and this checkout only, uncommitted |

A `project`-scoped install is a real team-wide declaration: the marketplace source is a path or git
URL in a committed file, so it has to be one everyone can reach — a git URL, not `~/code/…`.

**The command is `/pr-review-bot:pr-watch`, not `/pr-watch`.** Plugin commands are namespaced by the
plugin's `name` in `.claude-plugin/plugin.json`; the bare form answers `Unknown command: /pr-watch`.

Before committing to any of that, you can load the clone for one session and nothing more:

```bash
claude --plugin-dir ~/code/pr-review-bot
```

That registers both components for that session and writes nothing into your plugin configuration —
no marketplace entry, no `enabledPlugins`, nothing in `~/.claude/plugins/cache/`. It is the
try-before-you-install path, and the fastest way to check an edit to the command or skill text.

If you followed an earlier version of these instructions and symlinked the clone into
`~/.claude/skills/`, remove the symlink before installing. That directory auto-loads whatever it
contains as a plugin, so leaving it means the same plugin is loaded twice from two places — and it
never produced a bare `/pr-watch` either, since the command is namespaced under the plugin however
it is loaded.

### 10. Go live

In a **dedicated terminal session** started from your config home (or with `PR_REVIEW_CONFIG_DIR`
exported):

```
/loop 5m /pr-review-bot:pr-watch
```

That is the whole operation: one cycle every five minutes, reporting two or three lines each time.
Most cycles print `0 PR(s): none`, which is the healthy result. If you would rather not use the
slash command, `node ~/code/pr-review-bot/src/cli.mjs cycle` on any timer does the identical work,
and needs no plugin installed.

**Exactly one runner per team** — and note that five minutes is a poll interval, not a guarantee
that the previous cycle has finished. See [One runner per team](operating.md#one-runner-per-team)
and [A cycle has no wall-clock bound](operating.md#a-cycle-has-no-wall-clock-bound-so-one-operator-can-overlap-themselves).

## Config reference

Every key `team.json` accepts. Required keys have no default and the run stops at load without them.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `team` | **unvalidated** | **required** | Human-readable team label. Only its *presence* is tested, so `"team": 123` and `"team": null` both load. Not read by any code path — it is there so a config file identifies itself. |
| `owner` | **unvalidated** | **required** | Org or user the team belongs to. Presence-tested only, exactly like `team`: `"owner": {}` loads. Also not read by any code path; `repos` carries the real owner. |
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

Shape is checked for `repos` (a non-empty array), for `labels` (an object of non-empty strings), for
`slack` (an object with a non-empty string `channel`), for `titlePrefix` (a compilable regex) and
for `depth`. **`team` and `owner` are checked for presence and nothing else** — validation tests
only `!== undefined`, so `{"team": 123, "owner": {}}` is a valid config. That is not a gap worth
closing: neither value is read anywhere, so there is no wrong type to catch. Treat the "string" in
your editor's schema as a convention, not a rule. The numeric and boolean keys are likewise taken as
written, so a typo there fails at use rather than at load.

Every value in `team.json` is also scanned for credential shapes; a token-shaped value anywhere in
it stops every command at load with exit `1`. **`review-criteria.md` gets no such check at load** —
see [`criteria.md`](criteria.md).

---

Next: [`criteria.md`](criteria.md) to make the reviews worth reading, and
[`operating.md`](operating.md) for everything after the first green cycle.
