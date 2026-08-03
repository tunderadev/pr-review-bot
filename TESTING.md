# Testing this on a machine that isn't the one it was built on

This is the guide for standing the tool up somewhere new — a second laptop, a
different GitHub account, a different Slack workspace — and driving it end to end
against a throwaway repo until you trust it.

The README explains how to *adopt* the tool. This explains how to *test* it, and
what specifically breaks when the identity underneath it changes.

---

## 1. What travels with the clone, and what does not

Cloning the repo gets you the machinery and nothing else. Everything that
identifies *you* is deliberately outside it.

| Thing | In the repo? | Why |
|---|---|---|
| `src/`, `test/`, `commands/`, `skills/` | yes | the tool |
| `config/team.example.json`, `criteria/review-criteria.example.md` | yes | templates to copy **out** |
| `team.json`, `review-criteria.md` | **no** | yours; live in a config dir you choose |
| `.env` (App ID, key path, installation ID, Slack token) | **no** | credentials, gitignored |
| The App private key `.pem` | **no** | never leaves the machine you downloaded it to |
| `~/.cache/pr-review-bot/clones/` | **no** | local cache, rebuilt on demand |
| `~/.config/pr-review-bot/telemetry.jsonl` | **no** | opt-in, off by default |

So on a new machine you always recreate three things: **`.env`**, a **config
directory**, and the **private key file**. Nothing else carries over.

---

## 2. The part that actually bites: a different GitHub account

This is the failure mode worth understanding before you start, because it is
silent — nothing errors, the tool just behaves as though it has amnesia.

### The bot's identity is derived from the App

Reviews and comments are authored by `<app-slug>[bot]`. The tool recognises its
own prior work by matching that exact login:

- `alreadyReviewedSha` asks "have *I* already reviewed this commit?"
- `findSticky` asks "which comment is *my* ledger?"

**If you test under a different GitHub App, the bot login changes**, so on a PR
that was already reviewed by the first App the new one will:

- not recognise the existing review → **re-review the same commit** and spend quota
- not find the existing ledger → **post a second sticky comment**
- restart round numbering at 1
- open a **new** Slack thread rather than updating the old one

None of this is an error. It is the correct behaviour of a different reviewer
meeting a PR for the first time. Just don't be surprised by it, and prefer a
**fresh sandbox PR** when switching identities rather than reusing one.

### Same App, different account

You have two options, and they differ in what you have to recreate:

**Option A — install the *same* App on the other account's repos.** The App ID
and the private key stay the same. The **Installation ID changes**, because an
installation is per-account. Find the new one at
`https://github.com/settings/installations` → the App → Configure → the numeric
id at the end of the URL. Bot login is unchanged, so ledger continuity is
preserved.

**Option B — create a *new* App under the other account.** New App ID, new
private key, new Installation ID, **and a new bot login**, with the amnesia
consequences above. This is the right choice if the two accounts should not
share a credential.

> If the other account is an organisation, an owner has to approve the
> installation. Budget for that.

### What does *not* change

Your own `git` identity, your SSH keys, and whether you can `git clone` the repo
by hand are all irrelevant to the tool. It never uses your personal git
credentials — every clone and fetch authenticates with a short-lived App
installation token supplied per invocation, and nothing is written to
`.git/config`. So a machine where you cannot `git clone` a private repo manually
will still work fine, provided the App is installed on it.

---

## 3. Prerequisites on the new machine

- **Node >= 24** (`node --version`). No `npm install` — the tool has zero runtime dependencies.
- **git** on `PATH`.
- **Claude Code**, installed and logged in. Reviews are `claude -p` subprocesses.
- **`ANTHROPIC_API_KEY` must NOT be set.** If it is, `claude` authenticates as the
  API and bills per token instead of drawing on your subscription — an unattended
  loop makes that expensive fast. `doctor` fails on it. Check with
  `echo $ANTHROPIC_API_KEY` and check your shell profile, not just the current shell.

Be aware that reviews consume the same Claude quota as your own interactive work,
and Max plans cap Opus more tightly than overall usage.

---

## 4. Setup

```sh
git clone https://github.com/philipj93/pr-review-bot.git ~/code/pr-review-bot
cd ~/code/pr-review-bot
npm test          # 405 tests, no network — proves the clone is sound
```

### 4.1 GitHub App

Create it at **Settings → Developer settings → GitHub Apps → New**, or reuse an
existing one (see §2).

Repository permissions — exactly these:

| Permission | Level |
|---|---|
| Pull requests | Read & write |
| Issues | Read & write |
| Contents | Read |
| Metadata | Read (mandatory) |

Install it on your sandbox repo. Then collect:

- **App ID** — on the App's settings page
- **Installation ID** — the number at the end of the Configure URL
- **Private key** — Generate a private key, save the `.pem` to
  `~/.config/pr-review-bot/app-private-key.pem`, and `chmod 600` it

### 4.2 Slack app

Create at <https://api.slack.com/apps> → From scratch. Bot token scopes — **only
two are needed**:

- `chat:write`
- `reactions:write`

Install to the workspace, copy the `xoxb-…` bot token, then **invite the bot to
your test channel** (`/invite @your-bot`) — it cannot post to a channel it is not
in. Get the channel ID from the channel's details pane (starts with `C`).

Use a **private test channel**. Early runs are noisy.

### 4.3 Secrets

```sh
mkdir -p ~/.config/pr-review-bot
cp .env.example ~/.config/pr-review-bot/.env
$EDITOR ~/.config/pr-review-bot/.env
```

```sh
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/.config/pr-review-bot/app-private-key.pem
GITHUB_APP_INSTALLATION_ID=987654
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

> `PR_REVIEW_CONFIG_DIR` does **not** work from this file. It is read from the
> real environment only — `export` it in your shell if you use it.

### 4.4 Config directory

Four tiers are searched, first match wins:

1. `--config <dir>`
2. `PR_REVIEW_CONFIG_DIR`
3. `./.claude/pr-review/` (relative to cwd)
4. `~/.config/pr-review-bot/default/`

An explicit `--config` or `PR_REVIEW_CONFIG_DIR` that does not resolve is a hard
error, not a fall-through — a typo cannot silently run someone else's profile.
Tier 3 depends on your working directory, which is easy to get wrong from a
scheduled runner, so **prefer `--config` when testing**.

```sh
mkdir -p ~/.config/pr-review-bot/default
cp config/team.example.json ~/.config/pr-review-bot/default/team.json
cp criteria/review-criteria.example.md ~/.config/pr-review-bot/default/review-criteria.md
```

Edit `team.json` — at minimum `repos`, `titlePrefix`, `slack.channel`, and
`authorMap`:

```json
{
  "team": "sandbox",
  "owner": "your-github-user",
  "repos": ["your-github-user/pr-review-sandbox"],
  "titlePrefix": "^\\[TEST\\]",
  "slack": { "channel": "C0123ABC" },
  "authorMap": { "your-github-user": "U0123ABCDEF" }
}
```

`authorMap` maps a GitHub login to a **Slack member ID** (Slack profile → More →
Copy member ID). Without it, mentions degrade to unlinked text — the review still
posts, nobody gets pinged.

> `model` is **rejected** if present. Reviews inherit whatever model your Claude
> CLI is set to; there is no pin.

### 4.5 Install the plugin (optional, for `/pr-review-bot:pr-watch`)

```sh
claude plugin marketplace add ~/code/pr-review-bot --scope local
claude plugin install pr-review-bot@pr-review-bot --scope local
```

The command is **namespaced**: `/pr-review-bot:pr-watch`. The bare `/pr-watch`
does not exist. You can skip all of this and drive the CLI directly.

---

## 5. Preflight

```sh
node ~/code/pr-review-bot/src/cli.mjs doctor --config ~/.config/pr-review-bot/default
```

It checks the App token mints, the installation can read each repo and holds the
right permissions, the three labels exist (creating them if not), Slack
authenticates and can add *and remove* a reaction, `claude` is on `PATH`, no
secrets are committed in your config dir, and which config tier won.

Exit 0 means green; **exit 2 means red checks — fix them before going further.**

What it deliberately does *not* prove: that a review would be *accepted* (branch
protection and rulesets are invisible to it), and that your Claude login works —
verifying that costs real quota, so the first live cycle is the first proof.

---

## 6. The end-to-end walkthrough

Create a throwaway repo (`pr-review-sandbox`), install the App on it, and add
`sandbox` to `repos` in `team.json`.

### 6.1 Open a deliberately flawed PR

Title it `[TEST] add parser` so it matches `titlePrefix`. Include something with
a real, locatable defect — an unguarded index is ideal because it is
unambiguous:

```js
export function firstId(items) {
  return items[0].id      // throws on an empty array
}
```

Add the `review-requested` label.

### 6.2 Dry run first

```sh
node src/cli.mjs cycle --dry-run --limit 1 --config ~/.config/pr-review-bot/default
```

This runs the **real** review and prints the body it would have posted, while
mutating nothing — no labels, no review, no Slack. It **costs real quota**,
disclosed before the first model call. `--limit 1` keeps a tuning iteration to
one PR instead of `maxPerCycle`.

Dry run deliberately ignores the same-SHA skip, so you can re-run it on a PR the
bot has already reviewed. That is intentional, not a bug.

### 6.3 Live

```sh
node src/cli.mjs cycle --config ~/.config/pr-review-bot/default
```

Expect: a `REQUEST_CHANGES` review naming the unguarded index; the Slack message
carrying ❌ with no leftover 👀; a threaded reply tagging you; a ledger comment on
the PR; and neither `review-requested` nor `review-in-progress` left behind.

### 6.4 The same-SHA guard

Re-add `review-requested` **without pushing anything**, and run again.

Expect: outcome `skipped_same_sha`, a threaded "no new commits" reply, the label
cleared, **no new review**, and no model call. This is what stops the bot
re-reviewing unchanged code forever.

### 6.5 The iteration loop

Push a real fix (add the length check and a test), re-add `review-requested`, run
again.

Expect: an `APPROVE` whose body references round 2 and reports the previous
blocker as resolved; the Slack reaction flipping ❌ → ✅ with no ❌ remaining; the
ledger showing two rounds.

### 6.6 Slack is best-effort

Point `SLACK_BOT_TOKEN` at garbage and run a cycle on a fresh labeled PR.

Expect: the **GitHub review still posts**, a log line explains the Slack failure,
and the PR does **not** get `review-error`. Restore the token afterwards.

### 6.7 Cost

```sh
# set "telemetry": true in team.json, run a few rounds, then:
node src/cli.mjs report
node src/cli.mjs report --reset   # prints the summary, then deletes the log
```

Telemetry is off by default and writes nothing when disabled. Turn it back off
when you are done measuring.

---

## 7. Reading the outcome

| Exit | Meaning | What to do |
|---|---|---|
| 0 | clean cycle | nothing |
| 1 | config or usage error, including an unreachable repo | fix the config |
| 2 | `doctor` found red checks | fix what it named |
| 3 | transient abort — rate limit, 5xx, network, git transport | nothing; the PR keeps `review-requested` and retries |
| 4 | at least one PR now wears `review-error` | look at that PR; it is **never** retried automatically |
| 5 | a genuine bug in the tool | file it |

The three labels:

- **`review-requested`** — the only trigger. You add it.
- **`review-in-progress`** — a cycle has claimed the PR. Transient; if it sticks, a cycle crashed.
- **`review-error`** — terminal and human-cleared. A PR wearing it is **skipped**, not retried. To recover: investigate, remove `review-error`, re-add `review-requested`.

---

## 8. Running it continuously

```sh
/loop 5m /pr-review-bot:pr-watch
```

One runner per team — there is no distributed lock, and two runners can both
claim the same PR.

Be aware a cycle has **no wall-clock bound**: reviews and refutations are serial
with generous timeouts, so a cycle can outlast a 5-minute poll and overlap
itself. If that matters, use a longer interval or a runner that waits for the
previous tick.

---

## 9. Security notes for testing

- A PR **cannot** execute code on your machine via files in its own tree —
  `.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md` and `.claude-plugin/` are
  stripped from the worktree before the reviewer runs, the child gets an
  allow-listed environment rather than yours, and MCP discovery is disabled.
- **However**: your own global `~/.claude/settings.json` hooks still fire with the
  PR's checkout as the working directory. If you have global hooks that act on
  repository content, they will run against unreviewed PR code. Consider testing
  under a clean `HOME` if that applies to you.
- The **ledger is unauthenticated**. Anyone with write access can edit the bot's
  sticky comment; the parser answers only when exactly one valid block is present
  and otherwise heals from empty. A heal costs a duplicate Slack announcement,
  restarts round numbering, and — the part that matters — the next review is no
  longer told what it previously blocked on.
- Everything in `criteria/review-criteria.md` is sent **verbatim** into the model
  prompt, and is scanned for secrets only by `doctor`, never at config load.

---

## 10. Cleanup

```sh
rm -rf ~/.cache/pr-review-bot/clones            # clone cache
rm -f  ~/.config/pr-review-bot/telemetry.jsonl  # or: cli.mjs report --reset
claude plugin uninstall pr-review-bot@pr-review-bot --scope local
```

Delete the sandbox repo, uninstall the GitHub App from it, and remove the Slack
app from the workspace if it was created only for the test. The `.pem` and `.env`
are the two things worth deleting deliberately — nothing else on the machine
holds a credential.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Can not approve your own pull request` (422) | The review is not being posted by the App. Check `GITHUB_APP_INSTALLATION_ID` matches the account that owns the repo. |
| Nothing is picked up | Title does not match `titlePrefix`; label name differs from `labels.requested`; the PR carries `review-error`; or the repo is not in `repos`. |
| `not_in_channel` | The bot was never invited to the channel. |
| Reactions fail but posting works | `reactions:write` scope missing; reinstall the Slack app after adding it. |
| Private repo fails to clone | The App is not installed on that repo. The tool never uses your personal git credentials. |
| It re-reviewed a PR it already reviewed | Different App → different bot login → it does not recognise its own prior work. See §2. |
| Reviews cost more than expected | `report` for the real numbers; then tighten `maxDiffLines`, or the blocking rules in your criteria. |
| `doctor` fails on `ANTHROPIC_API_KEY` | It is exported somewhere — check your shell profile, not just the current shell. |
