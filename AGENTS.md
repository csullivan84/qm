# qm

To run and test, see [`README.md`](./README.md).

## Working on the code

Two habits that keep task-focused changes from scarring the rest of the repo:

- **Fix every instance, not just the reported one.** When you find a bug or a pattern
  worth changing, grep the whole repo (`src/`, `plugins/`, `test/`, `scripts/`) for the
  same pattern and fix all of it in the same change. One autocorrected call site with
  five untouched siblings is a regression waiting to be rediscovered.
- **Fixes should make the system simpler, not more complex.** Prefer removing or
  consolidating code over adding a new layer, flag, or special case. If a fix grows the
  system's surface area, look for the version that shrinks it.
- **Never leave comments in the repo.** The standard is zero comments: no explanatory
  comments or docblocks, TODO/FIXME notes, lint/type suppression directives, or commented-out
  code. Express intent through names, structure, and tests; put rationale in commit messages or
  PR descriptions. Interpreter shebangs are executable directives, not comments.
- **Solve at the layer all paths flow through.** Before patching a call site, ask
  whether the fix belongs in the shared helper, the store interface, or the base
  module instead. Check for an existing helper before writing a new one-liner.
  The helper homes: `src/util/errors.ts` (errMessage/swallow), `src/util/async.ts`
  (sleep, createKeyedQueue), `src/util/sweeper.ts` (periodic loops),
  `src/sandbox/process-poll.ts` (process polling/liveness), `src/memory/notebook.ts`
  (memory line grammar). Plugins are separate packages and keep their own local
  copies rather than importing core code — the one exception is the shared
  `plugins/chassis` package (the sanctioned home for the plugin↔core plumbing:
  source-auth signer, signed core-client, node:http helpers, error helpers, CORE_*
  env), imported by relative path and never importing core. The bar cuts both ways:
  don't manufacture an abstraction for a pattern with one caller.
- **Never merge to `main` without a fresh-context pass that tries to break the change.**
  Not a blessing — hunt for the bug, the missed edge case, the unstated assumption, the
  thing that regresses. Always dispatch `/code-review` or an independent review agent that
  did not watch you write the change: the context that produced a diff already believes it
  is correct, and that belief is the bias review exists to defeat. Never self-review in the
  authoring context, however small the diff; a green CI run is not review either. What
  scales with risk is how deep the reviewer goes — a change with a narrow blast radius
  warrants one reviewer at modest effort scoped to the diff, while core control flow, auth
  and credentials, data loss or migrations, concurrency and retry logic, spend, public API
  contracts, the shared helpers above that every path flows through, or a diff too large to
  hold in your head warrant high effort and several reviewers with distinct lenses. Judge
  blast radius by checking callers, not by counting files — a one-line edit to a helper with
  fifty importers is not a small change. The reviewer, not the author, has the last word on
  depth: a modest pass that spots risk it wasn't scoped for escalates on its own initiative
  rather than staying in its lane. Resolve what they find before merging.
- **Verify locally with the affected tests, not the whole suite.** Run the tests covering
  what you changed plus typecheck and lint, then push and let CI be the full gate — CI
  shards the suite across parallel runners, and reproducing that serially costs several
  times the wall clock for the same signal. Judge "affected" by callers rather than by diff
  size, for the same reason as above; run everything locally when you can't tell what a
  change reaches.
- **Verify non-trivial behavior changes in a live dev instance before opening a PR.**
  When a change is substantial enough that unit tests alone won't prove it works
  end-to-end — new or changed agent behavior, or anything touching the Slack/web
  surfaces, orchestrator, directory, or cron flows — boot this worktree with the
  `/dev-instance` skill and exercise it through a browser against the configured Slack
  development workspace before opening a PR. Do this Slack QA in **Firefox**, never the
  Slack Mac app, and don't ask permission first — do it on your own; don't wait to be
  asked. Skip it for trivial refactors, docs, config, or pure-logic changes already
  covered by tests.
- **Screenshot every front-end change in the PR.** Anything an operator or user sees
  rendered — admin/web/portal UI, Slack surfaces, emails — ships with a screenshot of the
  after state (before/after when it's a change to something that already existed) in the PR
  description, so a reviewer sees the result without booting it. Can't reach the surface
  live? Render it against realistic data and say so.

## Repository boundary

This repository is an independently maintained QM downstream. The operator's standing
instruction is an inbound-only relationship with `yc-software/qm`:

- `origin` (`csullivan84/qm`) is the only permitted write target.
- The `upstream` remote is read-only and may be used only to fetch or pull updates into
  this repository.
- Never push to upstream or create, modify, review, comment on, reference, or otherwise
  interact with upstream issues, pull requests, discussions, releases, workflows, or
  repository settings.
- Never create or use an outbound contribution workflow or redirect locally useful work
  to upstream.
- Core divergence is deliberate. Development, review, commits, branches, issues, pull
  requests, releases, and security work stay in this repository.
- Inspect `git remote -v` before GitHub or Git operations and pass the explicit selector
  `--repo csullivan84/qm` to `gh` commands that can read or change repository state.

Upstream updates are inputs, not a collaboration channel. Merge them deliberately and
resolve them around the local Matrix, accessibility, Recovery, PostgreSQL, and deployment
work without rebasing away local history.

## Durable by default

A recurring mistake: stashing state the system later relies on in process memory. The
core runs blue-green and multi-instance — an in-memory `Map` or ring buffer is
per-instance and wiped by every deploy. Anything an operator or the system reads back
later (audit, logs, resolved config, queued or in-flight work) must live in a durable
store, never RAM alone. RAM-only is fine only as a cache in front of a durable store, or
for genuinely disposable, re-derivable state. If you're adding a log, audit, queue, or
resolved config, back it with Postgres; the spec's data-model & durability section tracks the gaps.

> `CLAUDE.md` is a symlink to `AGENTS.md`, so every tool (Claude Code, Codex,
> Cursor, …) reads the same guidance from this one file. If a tool-specific
> deviation ever becomes necessary, replace the symlink with a real file in the
> commit that introduces the deviation.
