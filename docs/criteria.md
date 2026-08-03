# Writing good review criteria

Everything else in this tool is generic. The plumbing is the same for every team, the prompts are
the same, the verdict mapping is the same — the one thing that differs, and the one thing that
decides whether the reviews are worth reading, is your team's `review-criteria.md`.

So this is the document to spend time on. A team with sharp criteria gets reviews that name a real
defect at a real line and say what breaks; a team with vague criteria pays for two model calls per
finding and publishes an approval. The difference is entirely in the file, and the sections below
are the rules that make one file behave like the first and the other like the second: what the
criteria are used for, the cap on how much of a review gets verified, a worked example of a vague
rule and a concrete one side by side, and how to tune from a review that came out wrong.

The file itself lives in your config directory, alongside `team.json` — see
[Choose a config home](setup.md#5-choose-a-config-home) if you have not put one there yet.

## What the criteria file is

`review-criteria.md` is pasted into the reviewer's prompt as authoritative. It is the entire
interface, and it is where all of the review quality lives — the machinery is generic.
`criteria/review-criteria.example.md` in this repo is the annotated starting template; read it
before editing rules.

Two consequences of "pasted into the prompt", neither of them obvious:

- **The whole file is prompt, verbatim.** It is read straight off disk into the review prompt with
  no parsing, no allowlist and no escaping. Anything in it that reads as an instruction is an
  instruction, not a rule the reviewer weighs.
- **It is not scanned for secrets when it is loaded.** `team.json` is: a token-shaped value anywhere
  in it stops every command at load with exit `1`. `review-criteria.md` gets no equivalent check —
  it is read into the config object after validation has already run, so a token pasted into it
  reaches a model without a single command failing. The only thing that catches it is `doctor`'s
  `no credentials in config` check, and only when someone runs `doctor`. Never paste a real token
  here, not even as an example of what to catch.

The one fact that shapes everything: **only `blocking` findings are ever verified, and the verifier
is told to refute when uncertain.** A vague blocking rule does not produce a bad review, it produces
*nothing* — after you have paid for a review call plus one verification call per claim it invented.

A finding is exactly four fields: `file`, `line`, `claim`, `why`. A rule that cannot be violated at
a specific line, with a specific consequence, cannot produce a finding at all.

## Verification stops at fifteen blocking findings

The refutation pass is the only unbounded fan-out in the pipeline — one `claude` child per blocking
finding, run one after another, each allowed five minutes and each retried once — so it is capped at
the **first fifteen blocking findings** a review raises. Nits are never verified and do not count
against the cap.

Findings past the cap are never examined, and the cap is deliberately not silent about it. They are
recorded as **unverified**, which has three consequences:

- They **never block the author.** Nothing checked them, and uncertainty must not cost somebody a
  round trip on a claim that may well be wrong.
- They **cannot be silently approved over either.** An unverified finding makes the whole pass
  *degraded*, and a degraded pass with no surviving blockers posts no verdict at all — the PR is
  re-queued instead. So "we ran out of budget" can never turn into a green check.
- They are **named in the review body**, in a section that exists only when something genuinely went
  unchecked:

  > ### Not verified (5)
  >
  > These were raised by the review and then dropped **without being judged** — the verification
  > pass could not reach a verdict on them. They are **not blocking** and may well be wrong; they are
  > listed because a review that could not check them is weaker than one that did.
  >
  > - **src/api/orders.ts:88** — … _(not verified: this review raised 20 blocking findings and only the first 15 are verified)_

That same section is where a timed-out or errored refutation lands, so hitting the cap looks to a
reader exactly like what it is: findings nobody checked.

**Treat the cap as a signal about your criteria.** A review claiming more than fifteen blocking
defects is not an actionable review — nobody works through a list that long — so reaching the cap
means a rule is firing far too widely. It is the most practical reason to keep **Always blocking**
short and specific: a review that raises twenty blockers does not review harder, it reviews *less*,
and it may post nothing at all.

## Worked example

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

## The feedback loop

- **A false blocker was posted** → find the rule whose wording the claim echoes, and either narrow
  it with the condition it was missing or add the exempting pattern to **Never blocking**. Deleting
  the rule outright is usually an overcorrection.
- **A real problem was missed** → write it as a rule under **Always blocking** that clears the bar:
  trigger, evidence to name, consequence to state. If the evidence lives outside the diff, say so —
  the reviewer has the whole tree checked out but will not go looking unless a rule tells it to.
- **Then verify**, against a real PR, publishing nothing:

  ```bash
  node ~/code/pr-review-bot/src/cli.mjs cycle --dry-run --limit 1 --config <your config dir>
  ```

  Edit → dry-run → read the rendered review → adjust → repeat. `--config` is not optional here even
  though a bare `cycle` would often resolve the same directory: this loop is run over and over from
  whatever shell happens to be open, and tier 3 resolves against the process's working directory
  without saying so.

Heuristic: if *could*, *might*, *consider*, *fragile* or *in the future* appears in a blocking
claim, it is a mislabelled nit and the verification pass will delete it a minute later.

Never tune by editing the prompts in `src/review.mjs`. Criteria belong in the config dir so your
team owns them and their history. Every review body ends with `criteria sha256:…`, also stored in
the ledger — when round 3 disagrees with round 2, the same hash means the code changed and a
different hash means you did.

---

Related: [`setup.md`](setup.md#config-reference) for where the file lives and how it is resolved,
and [`operating.md`](operating.md#when-the-bot-cannot-verify-a-pr-at-all) for what happens when the
verification pass cannot reach a verdict at all.
