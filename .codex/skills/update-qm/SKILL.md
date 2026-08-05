---
name: update-qm
description: Pull upstream QM updates into this independent downstream without writing to or otherwise interacting with upstream. Use when asked to "update qm", "sync from upstream", "pull in the latest qm".
---

# update-qm

This independent downstream intentionally diverges from upstream QM. This skill imports
upstream changes while preserving local Matrix, accessibility, Recovery, PostgreSQL, and
deployment work. The relationship is inbound-only: fetch and merge are permitted, but
upstream pushes, issues, pull requests, discussions, releases, and workflow changes are
forbidden.

See [`deploy/layers/README.md`](../../../deploy/layers/README.md) for the private layer
boundary. There is no outbound contribution workflow.

## Check that there is anything to sync

```bash
git remote -v
```

If `origin` is `yc-software/qm`, stop: this skill is only for the independent downstream.

Otherwise proceed. Judge by where `origin` points, not by the repository's name. Never
push to `upstream` or use GitHub features against it.

If the clone has no `upstream` remote, add it with the public read-only URL:

```bash
git remote add upstream https://github.com/yc-software/qm.git
```

Whether the remote was new or already present, normalize its fetch URL and replace every
push URL with the non-routable local sentinel before fetching:

```bash
git remote set-url upstream https://github.com/yc-software/qm.git
git config --unset-all remote.upstream.pushurl || true
git remote set-url --add --push upstream DISABLED
git remote get-url upstream
git remote get-url --push upstream
```

## Merge, never rebase

`origin/main` is published history that deploys and other clones track. Rebasing it onto
upstream rewrites those commits, so always merge.

```bash
git switch main
git pull --ff-only origin main
git fetch upstream
git switch -c sync-upstream-<yyyy-mm-dd>
git log --oneline main..upstream/main
git merge upstream/main
```

Record the commit range before resolving anything so the downstream sync record can state it. If the merge
reports "Already up to date", delete the branch and report that instead of opening an empty
PR.

## Resolving conflicts

A merge conflict means upstream and this downstream changed the same path. Preserve local
security boundaries and product capabilities while integrating compatible upstream work.
Organization-specific material remains under `deploy/layers/<org>/`; generic downstream
divergence remains in core. Never resolve a conflict by sending local work upstream.

List every conflict and resolution in the local sync record or origin pull request.

## Verify before opening the PR

A sync changes the runtime, the CLI, and possibly the deployment contract at once, so run
everything. The root suite does not cover the CLI, and the CLI is where a contract change
lands:

```bash
npm install
npm run typecheck
npm run lint
npm test
npm --prefix cli test
```

A sync can raise the deployment contract major, and the CLI rejects a layer config written
for the old one. Check each organization layer with the in-tree CLI (`npm exec qm` does not
work in a source checkout; the workspace symlink points at `cli/`, which is unbuilt):

```bash
node cli/bin/qm.ts check --config deploy/layers/<org>/qm.config.jsonc
```

If that reports an unsupported contract major, updating the layer config to the new shape
is part of this sync.

## Open a downstream PR when requested

```bash
git push -u origin sync-upstream-<yyyy-mm-dd>
gh pr create --repo <downstream-repository> --base main \
  --title "Sync upstream qm through <short-sha>" \
  --body-file .generated/sync-body.md
```

Pass `--repo` to every `gh` command you run in a downstream repository. Without it, `gh` picks a base
repository from the clone's remotes and may choose `upstream`: the sync PR gets opened
against qm, and `gh pr edit 1` overwrites whatever PR is number 1 in the source repository.
The same applies to `gh pr view`, `gh pr list`, and `gh issue`.

The description should state the upstream commit range merged, any file outside
`deploy/layers/` that conflicted and how it was resolved, and the results of the checks
above.

If the downstream deploys from `main`, merging this PR ships upstream's changes to production,
so merge when someone can watch it.

A downstream runs imported CI workflows in its own account. A sync that
adds or changes CI changes what runs on the next PR, and workflows that need secrets the
downstream never received will fail until those are supplied.

## Never do these

- `git push --mirror` to an existing downstream. It deletes refs the destination has and the
  source does not, discarding the organization's own branches. It is safe only for the
  first population of an empty repository.
- Pushing any branch or tag to upstream.
- Rebasing `main` onto `upstream/main`, or force-pushing a downstream's `main`.
- Resolving a conflict by deleting the upstream side wholesale to quiet the merge. That
  silently diverges core from upstream, and the divergence returns as a larger conflict in
  the next sync.
