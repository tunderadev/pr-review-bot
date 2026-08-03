# Architecture notes for contributors

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

## The injection convention

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

## The depth-2 seam

`runReview` is **one lens**: a single prompt built from the criteria, run once, parsed strictly.
Depth 2 becomes a loop over configured lenses plus a synthesis step that merges their findings —
and leaves the refutation pass unchanged, because refutation operates on findings and does not care
where they came from. The decision to adopt it is made by enabling telemetry for a period and
reading measured cost per review against remaining subscription headroom, not by guessing; that is
what `report`'s projection line exists for. `depth: "deep"` is rejected today with a message
pointing at that path.

---

Related: [`operating.md`](operating.md#exit-codes) for what each exit code the CLI returns is
supposed to mean, and [`operating.md`](operating.md#measuring-cost) for the telemetry the depth-2
decision reads.
