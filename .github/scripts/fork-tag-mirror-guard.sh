#!/usr/bin/env bash
# Refuse a tag mirror that would move or delete a tag this fork already publishes.
#
# Why: `.github/workflows/fork-upstream-tags.yml` pushes `refs/tags/v*` without `--force`, so today
# an existing tag cannot be moved — but that was a property of the command line, not of the job, and
# nothing said so if someone added `--force`, `--mirror` or a refspec. Worse, the PAT the mirror
# authenticates with belongs to the account that is the `exempt` bypass actor on the only ruleset
# protecting `refs/heads/nplez1/main`, and no tag ruleset exists at all — so there is no server-side
# backstop either.
#
# This makes the guarantee explicit and testable: read both remotes, and refuse when a tag the mirror
# is about to send already exists somewhere else. Tags that exist only on the fork are left alone (the
# mirror only adds), and a tag identical on both is a no-op.
#
# usage: fork-tag-mirror-guard.sh ORIGIN-REMOTE UPSTREAM-REMOTE
# exit: 0 only additions, 1 a tag would move, 2 environment problem
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: fork-tag-mirror-guard.sh ORIGIN-REMOTE UPSTREAM-REMOTE" >&2
  exit 2
fi

origin="$1"
upstream="$2"

# `--refs` drops the `^{}` dereference lines, so an annotated tag compares as its tag object on both
# sides rather than as tag object here and commit there.
remote_tags() {
  git ls-remote --tags --refs "$1" 'v*' 2>/dev/null | awk '{ sub(/^refs\/tags\//, "", $2); print $2, $1 }'
}

upstream_tags="$(remote_tags "$upstream")" || {
  echo "mirror guard: cannot read tags from $upstream" >&2
  exit 2
}
origin_tags="$(remote_tags "$origin")" || {
  echo "mirror guard: cannot read tags from $origin" >&2
  exit 2
}

if [ -z "$upstream_tags" ]; then
  echo "mirror guard: $upstream publishes no v* tags — refusing to push an empty mirror" >&2
  exit 2
fi

declare -A existing=()

declare -A existing=()
while read -r name sha; do
  [ -n "${name:-}" ] && existing["$name"]="$sha"
done <<<"$origin_tags"

moved=0
added=0
while read -r name sha; do
  [ -n "${name:-}" ] || continue
  current="${existing[$name]:-}"
  if [ -z "$current" ]; then
    added=$((added + 1))
  elif [ "$current" != "$sha" ]; then
    printf 'mirror guard: refusing to move %s — %s has it at %s, %s now has it at %s\n' \
      "$name" "$origin" "$current" "$upstream" "$sha" >&2
    moved=$((moved + 1))
  fi
done <<<"$upstream_tags"

if [ "$moved" -gt 0 ]; then
  echo "mirror guard: $moved tag(s) already exist at another commit; nothing was pushed." >&2
  exit 1
fi

printf 'mirror guard: %d tag(s) to add, 0 to move\n' "$added"
