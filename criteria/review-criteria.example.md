# Review criteria — &lt;team name&gt;

Copy this file into your config directory as `review-criteria.md` and edit it. The machinery is
generic; the judgment is here. Nothing else in this repo moves review quality as much as this
file does, and nothing else decides whether the bot is useful or noisy for your team.

## How this file is used

The whole file is pasted into the reviewer's prompt as authoritative — it is told to judge against
these rules rather than its own preferences. Four facts about the pipeline shape how rules have to
be written:

1. **Every finding is `blocking` or `nit`, and only one of them acts.** A blocking finding that
   survives verification posts `REQUEST_CHANGES` on a colleague's pull request. A nit is a line of
   advice under "Non-blocking notes". Zero surviving blockers is an `APPROVE`.
2. **Only blocking findings are ever checked.** A second headless pass reads the real checkout and
   tries to *refute* each one. Its instruction is explicit: *a claim survives only if a concrete
   path to the stated failure can be traced, and if you are uncertain, refute it.* A blocking
   finding that cannot be substantiated is dropped without a trace. Nits are never checked by
   anything — whatever the reviewer writes about them is published as written.
3. **A finding is exactly four fields: `file`, `line`, `claim`, `why`.** A rule that cannot be
   violated at a specific line, with a specific consequence, cannot produce a finding at all.
4. **The reviewer works in a real checkout of the PR head** and can Read, Grep and Glob the whole
   tree, not just the diff. Rules may require a claim to be confirmed against callers, guards or
   tests that the diff does not show — and should, when that is what makes the claim provable.

Fact 2 is the one that costs you. A vague blocking rule does not produce a bad review; it produces
*nothing*, after paying for a review call plus one verification call per claim it invented.

## The bar for "blocking"

A rule belongs under **Always blocking** only if every violation of it can be written like this:

> `<file>:<line>` — *what is wrong*, because *a named caller, input or code path* reaches it and
> *a specific bad outcome* follows.

If a violation cannot be phrased that way, it is not a blocker. Move it to **Never blocking**, or
rewrite the rule until it can be.

## Always blocking

A finding is `blocking` only if it belongs to this list. Everything else is a `nit`.

- **Swallowed errors.** A `catch` that neither rethrows, nor returns the failure to its caller, nor
  logs at error level — including a fallback value that hides the failure. Name the caller that
  will read that fallback as success.
- **Unhandled null or undefined on a path reachable from untrusted input.** Name the entry point
  (route, handler, CLI argument, queue consumer) and the dereference that throws.
- **New branching logic with no test that enters the branch.** A new `if`, `switch`, `catch` or
  early return that no test exercises. Grep the test files before claiming absence, and name the
  test file that should have covered it.
- **A breaking change to something this codebase does not control.** An exported signature, route
  shape, database column, queue message or event payload that existing consumers depend on, changed
  with no version note and no migration. Name a consumer, or name the migration that is missing.
- **Credentials or customer data in source, logs, fixtures or snapshots.** Anything shaped like a
  live secret — a Slack `xoxb-…` bot token, a GitHub `ghp_…` token, a PEM private key block — plus
  personal data reaching a log line. Name the file and the sink it reaches.
- **Unbounded work on a request path.** A query inside a loop over request data, a network call per
  row, a loop with no ceiling. Name the collection whose size a customer or an attacker controls.
- **An ordering or concurrency hazard the code actually depends on.** A read-modify-write with no
  lock, conditional update or unique constraint, where two callers can genuinely interleave. Name
  both paths.

## Never blocking

Report these as nits, or say nothing at all.

- Formatting, import order, quoting — anything the formatter or the linter already owns.
- Naming preferences, unless the name asserts something false about what the code does.
- Refactoring suggestions about code this PR did not touch.
- "Consider adding a comment" on code that reads plainly.
- Test coverage for type-only declarations, generated files, or one-line pass-throughs.
- Performance worries with no bound — no measurement, no argued size, no named hot path.
- Architectural preferences that are not written down in this file.

A usable heuristic: if the words *could*, *might*, *consider*, *fragile* or *in the future* appear
in a blocking claim, it is a nit that has been mislabelled, and the verification pass will delete
it in a minute's time.

## Project-specific rules

Replace these with yours. Keep the shape — trigger, then the evidence the finding has to name.

- **Database access goes through the repository layer.** A query builder or a raw SQL string inside
  a route handler, controller or component. Name the handler and the call.
- **Every route handler validates its input before using it.** A handler that reads a field off the
  request body before the shared schema helper has run. Name the field and the first line that
  trusts it.
- **Errors crossing a service boundary are wrapped in a typed error.** A raw `throw`, or a provider
  error re-thrown unchanged, escaping a module's public function. Name the caller that now receives
  an untyped error.

## How to judge

- These criteria are authoritative. Do not raise your own preferences as blocking findings.
- One well-evidenced blocking finding beats five speculative ones. There is no credit for volume,
  and each extra blocker costs a verification call that will refute it anyway.
- Read the code. When the diff cannot settle a question, open the file, grep for the callers, look
  for the test. A claim you did not verify will be deleted by the pass that does.
- Every finding needs a file, a line, and a consequence. "This looks fragile" is not a finding.
  "`items` can be empty and line 42 dereferences `items[0].id`, so the checkout page throws" is.
- When a previous round's blocking finding has been fixed, report it under
  `previousBlockersResolved` rather than raising it again.
- If a file you needed was excluded from the diff for size, say so in the summary instead of
  guessing at its contents.

<!-- ───────────────────────────────────────────────────────────────────────────
     Everything below this line is written for the humans who maintain this
     file. It is not a review rule, and it says nothing about the pull request
     under review. Ignore it when reviewing.
     ─────────────────────────────────────────────────────────────────────── -->

## For maintainers: a worked example

**The vague rule**

```
- Error handling should be robust.
```

What it produces:

```json
{ "severity": "blocking", "file": "src/api/orders.ts", "line": 88,
  "claim": "Error handling here is not robust",
  "why": "This could cause problems in production" }
```

What becomes of it: the verification pass is handed that claim and asked to trace a concrete path
to the stated failure. There is no stated failure — "problems in production" names nothing to go
and look for — so it refutes on uncertainty and the finding vanishes. The author sees an approval.
You paid for a review call and a verification call to publish nothing at all.

**The same defect, under a concrete rule**

```
- **Swallowed errors.** A `catch` that neither rethrows, nor returns the failure to its caller,
  nor logs at error level. Name the caller that will read that fallback as success.
```

What it produces:

```json
{ "severity": "blocking", "file": "src/api/orders.ts", "line": 88,
  "claim": "listOrders() catches the query error and returns [], so no caller can tell an empty account from a failed lookup",
  "why": "renderDashboard (src/pages/dashboard.tsx:31) has no error branch and renders \"No orders yet\", so a database outage shows every customer an empty order history" }
```

What becomes of it: the verifier greps for callers of `listOrders`, finds `renderDashboard`, looks
for an error branch, and cannot find one. It cannot refute the claim, so the finding survives and
lands in the review as:

> - **src/api/orders.ts:88** — listOrders() catches the query error and returns [], so no caller can tell an empty account from a failed lookup
>   - renderDashboard (src/pages/dashboard.tsx:31) has no error branch and renders "No orders yet", so a database outage shows every customer an empty order history
>   - _Verified: no caller distinguishes the empty result from a failure_

The difference between the two rules is not tone. It is that the second one tells the reviewer
which two things to go and find, and gives the verifier something it can fail to refute.

## For maintainers: the tuning loop

When a review gets something wrong, change this file. Arguing with the output changes nothing —
this file is the entire interface.

**A false blocker was posted.**

1. Find the rule that produced it; the claim usually echoes its wording.
2. Narrow that rule by adding the condition it was missing, or add the exempting pattern to
   **Never blocking**. Deleting the rule outright is usually an overcorrection — it caught
   something, just too much.
3. If the finding was true but not worth blocking a colleague over, say so in the rule and let it
   produce nits instead.

**A real problem was missed.**

1. Write it as a rule that clears the bar above: trigger, evidence to name, consequence to state.
2. If the evidence lives outside the diff, say so in the rule. The reviewer has the whole tree
   checked out, but it will not go looking unless a rule tells it to.

**After either edit, read what the rule actually does — against a real PR, without publishing
anything:**

```bash
node ~/code/pr-review-bot/src/cli.mjs cycle --dry-run --limit 1 --config <your config dir>
```

That is the whole loop: **edit this file → dry-run → read the rendered review → adjust → repeat.**
A dry run performs the complete review — it fetches the PR and its files, checks out the head,
runs the model against these criteria, runs the refutation pass over the blocking findings, and
renders the review body — then prints that body instead of posting it:

```
[dry-run] 1 PR(s) would be reviewed:
  owner/repo#12 (abc1234) "[PLAT] Add order history"
[dry-run] Reviewing them now for real: same prompts, same criteria, same model calls, so this spends the same Claude subscription quota a live review does. Nothing is posted, labelled, or mirrored to Slack — each review is printed below instead.

[dry-run] owner/repo#12 — would post REQUEST_CHANGES:

## 🔧 Changes requested — Round 1

Adds an order history page.

### Blocking (1)

- **src/api/orders.ts:88** — listOrders() catches the query error and returns []
  - a database outage shows every customer an empty order history

---
<sub>Automated review · criteria `sha256:9814ac3eaf08` · re-add the review-requested label after pushing fixes.</sub>

owner/repo#12 dry_run (changes_requested)
1 PR(s): 1 dry_run
```

Three things to know before you run it:

- **It costs real quota.** A dry run makes the identical model calls a live review does, billed to
  the same Claude subscription that funds your interactive work. The warning above is printed
  before the first call, so you can stop it. `--limit 1` exists for this loop: without it a dry run
  reviews up to `maxPerCycle` PRs (default 3) and you pay for all of them on every iteration.
- **It mutates nothing.** No review, no labels, no ledger comment, no Slack message or reaction.
  The PR keeps its `review-requested` label, so you can run it again immediately.
- **It ignores the same-head-SHA skip on purpose.** A live cycle skips a PR it has already reviewed
  at that commit; a dry run previews it anyway, because re-running against an already-reviewed PR
  *is* this loop. It prints a line saying a live cycle would have skipped it. That is not a bug.

It still needs the GitHub and Slack credentials — listing and fetching the PR are real API calls —
so run `doctor` first if it will not start.

**Telling a criteria change from a code change.** Every review body ends with the hash of the
criteria that produced it:

> Automated review · criteria `sha256:ab12cd34ef56` · re-add the review-requested label after pushing fixes.

The same value is stored in the sticky ledger comment as `criteriaVersion`. When round 3 disagrees
with round 2, compare the two hashes: the same hash means the code changed, a different hash means
you did. The hash is content-only — no clock, no machine identity — so it is stable across runs and
across machines, and it moves on any edit to this file, including this sentence.

**Two last cautions.**

- This file is prompt, not documentation. Rules nobody enforces dilute the ones that matter;
  delete them rather than leaving them for later.
- Never paste a real token here, not even as an example of what to catch — and do not rely on
  anything to stop you. `team.json` is scanned at load, so a token-shaped value in it stops every
  command with exit `1`. **This file is not.** It is read into the config object after validation
  has already finished and travels verbatim into the prompt, so a token pasted here reaches a model
  without a single command failing. The only thing that catches it is `doctor`'s
  `no credentials in config` check, and only when someone runs `doctor`.
