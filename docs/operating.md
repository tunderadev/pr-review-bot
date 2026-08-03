# Day-2 operations

Everything after the first green cycle: what the labels mean and who moves them, how to ask for a
re-review, what to do when a PR gets benched, how to upgrade, what a review costs and how to
measure it, the exit codes a wrapper branches on, and the symptoms worth recognising on sight.

## The three labels

| Label | Meaning | Who moves it |
|---|---|---|
| `review-requested` | The author is asking for a review. **The only trigger.** | Author adds it. The bot removes it when it claims the PR, and restores it on a transient failure. |
| `review-in-progress` | A cycle has claimed this PR. Transient — it should exist for minutes, not hours. | Bot only. If it sticks, a cycle was killed mid-review; remove it by hand. |
| `review-error` | A per-PR failure. **Sticky — never retried automatically, and an outright exclusion from selection.** | Bot adds it. **Only a human removes it.** |

Names are configurable under `labels`; `doctor` creates whatever you configured in each allowlisted
repo if it is missing.

**`review-error` excludes a PR from selection.** A PR wearing it is not picked up, not re-attempted
and not re-reviewed — it is stepped over before any work happens, so it costs nothing at all. That
exclusion is exactly what makes the recovery below work: clear `review-error`, re-add
`review-requested`, and the next cycle treats the PR as an ordinary request. Without it the bot
would fail on the PR again, re-apply the label every cycle forever, and hand it straight back to
whoever had just cleared it.

A PR that wears *both* labels is somebody asking for a re-review that is never coming, so every
cycle says so out loud and names it:

```
acme/api: 1 PR(s) carry the review-error label and were skipped — #12. That label is never cleared
automatically: fix what failed, remove it, then re-add review-requested.
```

**The bot never leaves both labels on.** They are opposite instructions — `review-requested` means
try again next cycle, `review-error` means stop and fetch a human — so a run that ends in a per-PR
failure removes the trigger label as it applies the sticky one. A failure that happened *before* the
PR was claimed used to leave both: selection saw `review-requested`, failed in exactly the same way,
and re-applied `review-error`, every cycle, forever. Only a human can put the two together now, and
the log line above is what tells you one did.

## Requesting a re-review

Push your fixes, then **add `review-requested` again**. The label is removed when a review is
posted, so it is always an explicit ask. If you re-add it without pushing, the head-SHA check
catches it: the bot thread-replies "no new commits since round N", drops the label, and makes zero
model calls.

## The emoji

Exactly one state reaction is carried on the announcement message at a time — the previous one comes
off as the new one goes on, so a PR that went ❌ then ✅ never wears both.

| Emoji | Key | State |
|---|---|---|
| 👀 | `inReview` | A review is running right now |
| ✅ | `approved` | Approved — no blocking findings survived verification |
| ❌ | `changesRequested` | Changes requested — the thread reply names the surviving blockers |
| ⚠️ | `error` | The review failed; the PR wears `review-error` and a human is needed |

## Clearing `review-error`

Nothing will ever clear it for you, and that is the point — a PR that failed once would otherwise
fail every five minutes forever, on your quota, with nobody watching. While the label is on, the PR
is excluded from selection entirely, so nothing at all happens to it until you do this:

1. Read the cycle log line: `owner/repo#12 failed: <reason>`.
2. Fix the cause (it is usually configuration, a wedged review, a PR the diff budget cannot cope
   with, or the repeated-verification failure described next).
3. Remove `review-error`.
4. Add `review-requested` to re-queue it.

Do it in that order. Adding `review-requested` first only produces the "carry the review-error label
and were skipped" line above, because the exclusion wins until the sticky label is gone.

A stuck `review-in-progress` is different: it means a cycle was killed mid-review, not that anything
is wrong with the PR. Remove it by hand and re-add `review-requested`.

## When the bot cannot verify a PR at all

Every blocking finding is checked by a second pass that tries to refute it. Sometimes that pass
cannot reach a verdict on *anything* — `claude` is broken on this machine, a gateway is erroring on
every call, the subscription is walled. Zero surviving blockers then reads exactly like a clean
review, so the cycle refuses to post a verdict at all and re-queues the PR instead (exit `3`).

That is the right answer for a condition that clears itself and the wrong one for a condition that
does not, and a single occurrence cannot tell them apart. So the attempts are counted in the ledger,
per head SHA. **On the third consecutive attempt at the same commit where nothing could be verified,
the PR gets `review-error` instead of being re-queued**, and the failure line says so:

```
acme/api#12 failed: refutation could not verify 2 blocking finding(s) on acme/api#12 and none
survived, so the correct verdict is unknown; nothing posted. That is 3 consecutive attempts at
abc1234, so the cause is not clearing itself — check that `claude` runs from the command line and
that reviews are not hitting a wall. The PR is benched until a human clears the label.
```

**Read that as a statement about the bot, not about the pull request.** It is not saying your PR is
bad, and it is not withholding findings it will not name. It is saying it could not get a
trustworthy answer about the PR three times running, and would rather stop than keep spending your
quota guessing. Nothing was posted, so there is no verdict to argue with — the thing to fix is the
reviewer, not the code.

Two details worth knowing:

- **The count is keyed to the head SHA.** Pushing a new commit starts a fresh set of attempts. New
  code deserves them, and a push is also the likeliest thing to change the outcome.
- **The count survives the escalation.** Clearing the label without fixing the cause costs one more
  cycle to discover that, not another three. Reaching a real verdict is what resets it.

## Upgrades

```bash
cd ~/code/pr-review-bot && git pull
```

That upgrades everything that reviews anything. No team configuration lives in this repo, so there
is nothing to merge and nothing to re-apply, and `/pr-review-bot:pr-watch` runs
`node ~/code/pr-review-bot/src/cli.mjs` straight out of the clone, so it picks the new code up on
the next cycle. Run `doctor` afterwards.

**The installed plugin is a separate copy, and `git pull` does not touch it.**
`claude plugin install` copies the repo into `~/.claude/plugins/cache/` under the `version` in
`.claude-plugin/plugin.json`. That copy supplies only the command and skill *text* — never the code
— so a stale one costs you nothing but a stale description. It is also genuinely pinned:
`claude plugin update` answers `already at the latest version (0.1.0)` and refreshes nothing while
the version is unchanged. When the command or skill text changes, either bump `version` and update,
or reinstall:

```bash
claude plugin uninstall pr-review-bot@pr-review-bot --scope local
claude plugin install   pr-review-bot@pr-review-bot --scope local
```

## Measuring cost

Telemetry is **off by default** and writes nothing at all when disabled. To measure — before
deciding whether a deeper review mode is affordable, or when reviews feel expensive:

1. Set `"telemetry": true` in `team.json`.
2. Let it run for a few days of real traffic.
3. Read it:

```bash
node ~/code/pr-review-bot/src/cli.mjs report          # avg/max/total per review, by phase and model
node ~/code/pr-review-bot/src/cli.mjs report --json   # same numbers as JSON — but read the caveat below
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

**`--json` is machine-readable only once the telemetry file exists.** When
`~/.config/pr-review-bot/telemetry.jsonl` is absent — which is the normal state, since telemetry is
off by default — `report --json` prints a plain-English notice on **stdout** and exits `0`. The flag
is not consulted on that path, so `report --json | jq` fails on the first character:

```console
$ node ~/code/pr-review-bot/src/cli.mjs report --json
No telemetry recorded at /Users/you/.config/pr-review-bot/telemetry.jsonl. Set "telemetry": true in team.json to start measuring.
$ echo $?
0
```

Once the file exists it is JSON on every path, including an empty file
(`{"reviews": 0, "totalCostUsd": 0, …}`). So a script must either check the file exists first, or
treat unparseable stdout with exit `0` as "nothing measured yet" rather than as a failure. Under
`--reset`, the "log cleared" notice goes to stderr, so stdout stays pipeable.

`report` is purely local. It needs no config directory and no credentials, so "what did this cost
me" is answerable even from a broken installation.

What drives the bill: one review call per PR (two if the first response was not valid JSON), plus
one verification call per **blocking** finding (two if its first answer was unparseable), for the
first fifteen blocking findings of a review. Nits are never verified. Criteria that generate many
blockers cost proportionally more whether or not those blockers survive — up to that cap, past
which they stop costing money and start costing the verdict, since the round posts nothing at all.

## One runner per team

Designate exactly one person to run the loop for a given config, and say who it is.

- **There is no distributed lock.** The `review-in-progress` claim is a read-modify-write with a
  small race window. It makes double-review unlikely, not impossible — two runners can both read
  "unclaimed" in the same instant and both review the same PR, posting two reviews.
- **Each runner spends their own subscription quota**, on the same plan funding their interactive
  work, so "who runs it" is a real cost decision and not an implementation detail.

## A cycle has no wall-clock bound, so one operator can overlap themselves

`5m` in `/loop 5m /pr-review-bot:pr-watch` is a poll interval, not a schedule. Nothing in this tool
bounds how long a cycle takes, and a cycle is entirely serial — PRs one at a time, blocking findings
one at a time — under timeouts sized to catch a *wedged* child, not a slow one:

| Step | Limit | Attempts |
|---|---|---|
| git clone / fetch | 5 min per git invocation | — |
| Review call | 20 min | up to 2 — a second if the first response is not valid JSON |
| Refutation call | 5 min | up to 2, **per blocking finding**, one after another — the first 15 findings of a review only |

So a single PR with three blocking findings can legitimately occupy 40 minutes of review plus 30
minutes of refutation before the cycle even reaches the second of `maxPerCycle` PRs, and the
fifteen-finding cap puts the ceiling for one PR near three hours. Nothing is wrong when that
happens — that is the design, and a review worth having is worth waiting for.

The consequence is the one the previous section describes for two operators, except you do not need
a second person to reach it. **If your runner starts a tick on a fixed interval regardless of
whether the previous one finished** — a cron entry, a `while true; do …; sleep 300; done` — then a
long cycle and the next tick overlap, and two cycles *of yours* can both read the same PR as
unclaimed and both review it. The `review-in-progress` claim narrows that window; it does not close
it. So:

- Confirm how your runner behaves before relying on it. If it does not serialise ticks, either
  serialise them yourself (a lockfile, or a loop that sleeps *after* the cycle returns) or pick an
  interval you are confident exceeds a cycle.
- `maxPerCycle` is the real lever: it caps the serial work in a tick, so lowering it shortens the
  worst case proportionally.
- Watch the terminal rather than the clock. A tick that has not reported yet is a cycle still
  working, not a hung one.

## The ledger is not tamper-proof

The sticky ledger comment is an ordinary GitHub comment, and every collaborator with write access on
the repo can edit it. The parser is deliberately strict — anything it cannot read unambiguously
returns nothing at all, and the cycle heals by starting from an empty state rather than guessing.
The cheapest way to trigger that is to paste the marker string into the comment with no closing
`-->`:

```
<!-- pr-review-bot:state
```

That is one line typed into a comment box, using no privilege the person did not already have. What
the reset costs, in order of how much it matters:

- **The next review is no longer told what the last one blocked on.** The reviewer is handed the
  previous round's surviving blockers, read from the last row of the ledger. After a reset there is
  no last row, so it reviews as though the PR had never been reviewed — and it can approve code it
  had previously demanded be fixed.
- **The real history is overwritten.** The next successful round rewrites the comment from the empty
  state. The bot's posted reviews are still on the PR, but the round history, the criteria hashes
  and the Slack binding are gone.
- **Round numbering restarts at 1**, so a review body reads "Round 1" on a PR that has had four.
- **The Slack binding is lost**, so the PR is announced again as a brand-new message. The reaction
  on the previous announcement is orphaned, and nothing ever comes back to move it.

Two related facts about what the ledger never records:

- **A failed round leaves no row.** When a PR errors, only the Slack binding is written back — no
  `errored` round is appended. That is deliberate: an error round would carry an empty blocker list,
  which would make the next review forget the outstanding blockers in exactly the way a reset does.
  The ledger's round count is therefore a count of completed reviews, not of attempts.
- The strictness cuts both ways. GitHub truncates long comment bodies, and the block it truncates is
  the bot's own, because that is written last — so an ordinary busy PR can reset the ledger with
  nobody touching anything.

There is no fix short of keeping state somewhere the PR's collaborators cannot write, which this
tool deliberately does not do. Treat the ledger as a convenience. When a verdict matters, the GitHub
review is the record.

## Your own hooks still run against the PR's code

A pull request can no longer execute code through files in its own tree. The worktree handed to the
reviewer is stripped of `.claude/`, `.claude-plugin/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`
and `AGENTS.md` — case-insensitively, so a `.CLAUDE/` committed on a case-sensitive filesystem does
not slip past on macOS. The child is spawned with `--strict-mcp-config` so no `.mcp.json` is
discovered wherever it sits, its `PATH` is stripped of relative entries so a `claude` committed at
the repo root cannot be resolved, and its environment is an explicit allowlist carrying none of this
tool's credentials.

What is **not** stripped, and cannot be, is your own configuration. The child inherits `HOME`, so
the hooks declared in your `~/.claude/settings.json` load normally — and its working directory is
the checkout of the PR head. **If you have global hooks that act on repository content** — a
`SessionStart` hook that formats, lints, indexes, installs, or shells out at all — **they will run,
as you, with unreviewed pull-request code as the working directory.** On a repo that accepts fork
PRs, whoever opened the PR chose that content.

That is a property of hooks being global rather than a defect here, and there is nothing this tool
can remove to prevent it. If your user-level hooks do more than read, scope them to the projects
they belong to, or accept that they run here too.

## Exit codes

The loop and any cron wrapper branch on these, so each means exactly one thing.

| Code | Meaning | What to do |
|---|---|---|
| 0 | Cycle completed | Nothing |
| 1 | Configuration, usage, or repo-discovery error — nothing was reviewed | Read the message; it names what to fix. Then `doctor` |
| 2 | `doctor` found red checks | Fix them. Only `doctor` returns this |
| 3 | Transient abort | **Nothing.** The affected PR is back under `review-requested` and retries next cycle |
| 4 | At least one PR failed | It wears `review-error` and is never auto-retried. A human must look |
| 5 | A bug in this tool | Re-run with `PR_REVIEW_DEBUG=1` for the stack trace |

3 and 4 are the pair that matters: 3 clears itself, 4 never does. And **an aborted cycle wins over a
per-PR failure**: if one PR earned `review-error` and a later one hit a transient condition, the
cycle exits `3`, because the abort is what stopped the run. Read the per-PR lines to see whether any
PR was left wearing the sticky label.

What lands in each code:

**`0` — nothing needs a human.** A cycle that found no labelled PRs; a review posted normally; a PR
skipped because its head SHA was already reviewed; a PR stepped over because it wears
`review-error`; and a PR whose author's GitHub account has been deleted — that last one is reviewed
exactly like any other, and only the Slack mention degrades to unlinked text.

**`1` — the operator has to change something, and nothing was reviewed.** Every configuration and
usage cause (bad arguments, a missing environment variable, no `team.json`, an unreadable private
key, an invalid config), **plus every deterministic failure to list a repo's pull requests**:

| Discovery failure | Usual cause |
|---|---|
| `404` | The repo is misspelled in `repos`, or the App is not installed on it |
| `403` that is not a rate limit | The App is installed but lacks pull-request read on that repo |
| `401` | The credentials are not valid for this installation |
| A `200` carrying something that is not a list | A proxy or a redirect answered instead of the API |
| A `Link` header with an unparseable `rel="next"` | Not GitHub's own pagination — something is rewriting responses |
| Still paginating after 10 pages | The same; the list is refused rather than silently truncated |

Each is raised as a `DiscoveryError` that names the repo and what to change. **These used to exit
`5`**, which told the operator it was a bug in this tool and not to attempt a fix — for something as
ordinary as a typo in `repos`.

**`2` — `doctor` ran and found red checks.** The command worked; the setup did not. Only `doctor`
returns this.

**`3` — a transient abort, and there is nothing to do.** During discovery — a `429`, any `5xx`, a
`403` that *is* a rate limit, or a retryable network errno — nothing has been claimed yet, so no PR
is processed and **no label is touched at all**; the next cycle simply asks again. During a PR: a
Claude usage limit, a transient GitHub failure, a **git transport failure** (DNS, a refused or reset
connection, a `408`/`429`/`5xx` from the remote), or a verification pass that came back degraded
with no survivors while still under the escalation threshold described above. The PR keeps
`review-requested` either way.

**`4` — the cycle finished, and at least one PR now wears the sticky `review-error`.** A review that
timed out; a `claude` run the CLI itself reported as failed; a verdict that would not parse even
after a retry; a GitHub `422` on the review POST; a **git repository error** (a repo that is not
there, a ref that does not exist, a credential refused); a **missing `git` binary**; **git killed by
its own five-minute time budget**; and the **third consecutive degraded-with-no-survivors attempt at
the same head SHA**.

**`5` — a genuine bug in this tool, and nothing else.** Not a misconfiguration, not a network
condition, and no longer a mistyped repo name. Re-run with `PR_REVIEW_DEBUG=1` for the stack trace.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `422 Can not approve your own pull request` in a failure line | GitHub refuses a review whose author is the identity posting it, so **the PR was opened by the same App installation that is reviewing it**. Not a stray personal token: nothing in `src/` reads `GITHUB_TOKEN`, and the only credential is minted from the App ID, private key and installation ID (`src/github-auth.mjs`), so there is no variable a personal token could shadow. `doctor`'s `github identity` line names the identity in use and says this outright — *(A PR opened by the bot itself would still be refused.)* If it reads `…[bot]` and matches whoever opened the PR, that is the whole answer |
| The review body appears as a plain comment headed with a warning | Wider than the row above: **any** non-transient rejection of the review POST preserves the body as a comment rather than losing it, not only a 422. Read the `owner/repo#N failed: …` line — it carries the status and message GitHub actually returned. Either way the PR wears `review-error` |
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
| `review-error` keeps coming back after you clear it | The PR genuinely keeps failing — the label is no longer re-applied to a PR that was merely skipped. Read the `owner/repo#N failed: …` line from the cycle log before re-queueing it again; re-adding the trigger label without changing anything just buys the same failure |
| `N PR(s) carry the review-error label and were skipped` every cycle | Someone added `review-requested` to a PR that still wears `review-error`. The sticky label wins, and the PR is stepped over untouched. Remove `review-error` **first**, then re-add `review-requested` |
| Exit 3 with `refutation could not verify … and none survived` | Deliberate. Verification could not reach a verdict on any blocker, so the correct verdict is unknown; nothing is posted and the PR is re-queued. An approval built on findings nobody checked is the worst thing this tool can do |
| The same message, but exit 4 and `That is 3 consecutive attempts at <sha>` | The escalation. Three attempts at one head SHA all failed to verify anything, so the cause is not clearing itself and the PR is benched for a human. It says nothing about the PR's quality — fix the reviewer (usually `claude` on the bot's `PATH`, or a walled subscription), then clear the label. See [When the bot cannot verify a PR at all](#when-the-bot-cannot-verify-a-pr-at-all) |
| A review body ends with a `Not verified` section | Findings the verification pass could not judge — it timed out, errored, or the review raised more than the fifteen blocking findings that get verified. They are not blocking, and they are listed rather than dropped so the review's weaker parts are visible. Many of them means a criteria rule is firing too widely |
| Reviews suddenly cost money on the API instead of the subscription | One of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` is set in the shell that starts the loop. `doctor`'s `claude auth mode` check names the offender and prints the `unset` line |
| `"model" is not supported…` at startup | Remove the key. Headless children inherit your saved Claude CLI default by design; change it with `/model` |

---

Related: [`setup.md`](setup.md#config-reference) for the keys named above, and
[`criteria.md`](criteria.md) when the fix is a criteria rule rather than a configuration change.
