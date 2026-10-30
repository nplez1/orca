#!/usr/bin/env bash
# Refuse a tag mirror that would move a tag this fork already publishes, and name exactly what to push.
#
# Why: `.github/workflows/fork-upstream-tags.yml` pushes `refs/tags/v*` without `--force`, so today an
# existing tag cannot be moved — but that was a property of the command line, not of the job, and
# nothing said so if someone added `--force`, `--mirror` or a refspec. Worse, the PAT the mirror
# authenticates with belongs to the account that is the `exempt` bypass actor on the only ruleset
# protecting `refs/heads/nplez1/main`, and no tag ruleset exists at all — so there is no server-side
# backstop either.
#
# This makes the guarantee explicit and testable: compare the tags this checkout is about to push
# against the tags the fork already has, refuse when one name exists at another commit, and print the
# refspecs for the tags that are genuinely new — so the push is `git push --atomic origin <those>` and
# cannot carry anything the guard did not read, including the fork's own non-`v*` tags.
#
# Written for bash 3.2, which is what macOS still ships: no associative arrays, and the comparison is
# awk, so a workstation without Homebrew bash runs the same code the runner does.
#
# usage: fork-tag-mirror-guard.sh ORIGIN-REMOTE
# stdout: one `refs/tags/NAME:refs/tags/NAME` refspec per line, for the tags to add
# exit: 0 nothing to move, 1 a tag would move, 2 environment problem
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: fork-tag-mirror-guard.sh ORIGIN-REMOTE" >&2
  exit 2
fi

origin="$1"
# Why the template with Xs: GNU mktemp (the runner) rejects a bare prefix, BSD mktemp (this Mac)
# accepts both. `${RUNNER_TEMP}` is what the sibling release guard uses.
scratch="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
remote_file="$(mktemp "$scratch/orca-mirror-remote.XXXXXX")"
local_file="$(mktemp "$scratch/orca-mirror-local.XXXXXX")"
trap 'rm -f "$remote_file" "$local_file"' EXIT

# `--refs` drops the `^{}` dereference lines, so an annotated tag compares as its tag object on both
# sides rather than as tag object locally and commit remotely.
if ! git ls-remote --tags --refs "$origin" 'v*' 2>/dev/null |
  awk '{ sub(/^refs\/tags\//, "", $2); print $2, $1 }' >"$remote_file"; then
  echo "mirror guard: cannot read tags from $origin — nothing was pushed" >&2
  exit 2
fi

# What the push will actually send: the checkout's own v* tags, which the mirror job fetched from
# upstream a moment ago.
if ! git for-each-ref --format='%(refname:short) %(objectname)' 'refs/tags/v*' >"$local_file"; then
  echo "mirror guard: cannot read this checkout's tags — nothing was pushed" >&2
  exit 2
fi

if [ ! -s "$local_file" ]; then
  echo "mirror guard: this checkout has no v* tags to mirror, so the fetch found nothing upstream — nothing was pushed" >&2
  exit 2
fi

# An empty remote file is the first-run case: the fork has no v* tags at all, so every local tag is
# new. Skipping the join is what keeps `added` honest there.
if [ -s "$remote_file" ]; then
  counts="$(awk -v origin="$origin" '
    NR == FNR { remote[$1] = $2; next }
    {
      if (!($1 in remote)) { added++; next }
      if (remote[$1] != $2) {
        printf "mirror guard: refusing to move %s — %s has it at %s, this checkout has it at %s\n", $1, origin, remote[$1], $2 > "/dev/stderr"
        moved++
      }
    }
    END { printf "%d %d\n", added, moved }
  ' "$remote_file" "$local_file")"
else
  counts="$(awk 'END { printf "%d 0\n", NR }' "$local_file")"
fi
read -r added moved <<<"$counts"

if [ "${moved:-0}" -gt 0 ]; then
  # Why no automatic remedy: the fork's own tag and a moved upstream tag are both legitimate, and
  # choosing which one wins is a release decision this job must not make.
  echo "mirror guard: at least one tag already exists at another commit; nothing was pushed." >&2
  echo "mirror guard: decide deliberately — adopt upstream's commit for that tag by hand, or stop" >&2
  echo "mirror guard: mirroring that name — then re-run. The mirror never moves a tag itself." >&2
  exit 1
fi

if [ -s "$remote_file" ]; then
  awk 'NR == FNR { remote[$1] = 1; next } !($1 in remote) { print "refs/tags/" $1 ":refs/tags/" $1 }' \
    "$remote_file" "$local_file"
else
  awk '{ print "refs/tags/" $1 ":refs/tags/" $1 }' "$local_file"
fi

printf 'mirror guard: %s tag(s) to add, 0 to move\n' "${added:-0}" >&2
