#!/usr/bin/env bash
set -euo pipefail

die() {
  printf '%s\n' "$1" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

host="${QM_REMOTE_HOST:?Set QM_REMOTE_HOST to the SSH destination}"
remote_url="${QM_PUBLIC_REPO_URL:-https://github.com/csullivan84/qm.git}"
mirror="${QM_REMOTE_MIRROR:-/srv/qm/source.git}"
build_root="${QM_REMOTE_BUILD_ROOT:-/srv/qm/builds}"
branch="${QM_REMOTE_BRANCH:-$(git branch --show-current)}"

[[ -n "$branch" ]] || die "source sync requires a named local branch"
[[ -z "$(git status --porcelain)" ]] || die "worktree must be clean before source sync"
[[ "$mirror" == /* && "$mirror" == *.git && "$mirror" != "/.git" ]] || die "QM_REMOTE_MIRROR must be a specific absolute .git path"
[[ "$build_root" == /* && "$build_root" != "/" ]] || die "QM_REMOTE_BUILD_ROOT must be a specific absolute path"

for value in "$host" "$remote_url" "$mirror" "$build_root" "$branch"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "source sync values cannot contain line breaks"
done

sha="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short=8 HEAD)"
checkout="$build_root/qm-$short_sha"

git remote get-url origin >/dev/null 2>&1 || die "origin remote is required"
git push origin "HEAD:refs/heads/$branch"

ssh "$host" bash -s -- "$remote_url" "$mirror" "$build_root" "$branch" "$sha" "$checkout" <<'REMOTE'
set -euo pipefail

remote_url="$1"
mirror="$2"
build_root="$3"
branch="$4"
sha="$5"
checkout="$6"

if [[ -e "$mirror" && ! -d "$mirror" ]]; then
  printf 'mirror path exists and is not a directory: %s\n' "$mirror" >&2
  exit 1
fi

if [[ ! -d "$mirror" ]]; then
  mkdir -p "$(dirname "$mirror")"
  git clone --bare "$remote_url" "$mirror"
fi

bare="$(git --git-dir="$mirror" rev-parse --is-bare-repository 2>/dev/null || true)"
[[ "$bare" == "true" ]] || {
  printf 'mirror is not a bare Git repository: %s\n' "$mirror" >&2
  exit 1
}

if git --git-dir="$mirror" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$mirror" remote set-url origin "$remote_url"
else
  git --git-dir="$mirror" remote add origin "$remote_url"
fi

git --git-dir="$mirror" fetch --no-tags --prune origin "+refs/heads/$branch:refs/heads/$branch"
resolved="$(git --git-dir="$mirror" rev-parse "refs/heads/$branch^{commit}")"
[[ "$resolved" == "$sha" ]] || {
  printf 'remote branch resolved to %s instead of %s\n' "$resolved" "$sha" >&2
  exit 1
}

mkdir -p "$build_root"
status="created"
if [[ -e "$checkout" ]]; then
  existing="$(git -C "$checkout" rev-parse HEAD 2>/dev/null || true)"
  [[ "$existing" == "$sha" ]] || {
    printf 'checkout path already exists with different content: %s\n' "$checkout" >&2
    exit 1
  }
  status="already-synced"
else
  git --git-dir="$mirror" worktree add --detach "$checkout" "$sha"
fi

printf 'source_status=%s\n' "$status"
printf 'source_checkout=%s\n' "$checkout"
printf 'source_sha=%s\n' "$sha"
REMOTE
