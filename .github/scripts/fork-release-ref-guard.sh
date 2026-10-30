#!/usr/bin/env bash
# Gate a release dispatch before any artifact is built. The tag this fork publishes is the update
# feed every installed build reads, so a dispatch from another ref — or into a tag that already
# points at another commit — has to fail here rather than replace assets under a tag whose notes
# name the old revision.
#
# Usage: fork-release-ref-guard.sh REF TAG SHA REPOSITORY
# Exit: 0 this dispatch is the one that tag belongs to, 1 refuse, 2 usage.
set -euo pipefail

ref=${1:-}
tag=${2:-}
sha=${3:-}
repo=${4:-}
if [ -z "$ref" ] || [ -z "$tag" ] || [ -z "$sha" ] || [ -z "$repo" ]; then
  echo "usage: fork-release-ref-guard.sh REF TAG SHA REPOSITORY" >&2
  exit 2
fi

if [ "$ref" != "refs/heads/nplez1/main" ]; then
  echo "::error::a release must be dispatched from refs/heads/nplez1/main, not $ref — this tag is the update feed every installed build reads." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Why the version here, before anything else: an unpublishable version has to fail whatever else this
# dispatch is doing. The shape is the part that can strand every install; it is checked on a
# re-dispatch too, because a re-dispatch into a bad tag publishes it just the same.
if ! node "$script_dir/fork-release-version-guard.mjs" "$tag"; then
  exit 1
fi

# Why the tag on the version check: electron-builder creates the tag when it publishes, so the tags
# in this checkout are the releases this fork already published. `v:refname` is git's own version
# sort, so no second opinion on ordering is coded here — but the shape is filtered first, because one
# stray tag (`v1.4.214-np.41-hotfix`) sorting first would make every later release uncomparable.
newest_tag="$(git tag -l 'v[0-9]*-np.*' --sort=-v:refname 2>/dev/null \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-np\.[0-9]+$' \
  | head -1 || true)"

errors="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fork-release-guard.XXXXXX")"
# Why the error file: "the release is missing" and "gh could not tell me" are different answers, and
# reading every failure as "no release yet" is how a ref, auth or network problem created a tag.
if ! target="$(gh release view "$tag" --repo "$repo" --json targetCommitish --jq '.targetCommitish' 2>"$errors")"; then
  if grep -qiE 'not found|HTTP 404' "$errors"; then
    # Why the monotonicity check only here: a re-dispatch of an existing tag is already published,
    # so it cannot be stepped above itself, and refusing it would block the retry it exists for.
    if ! node "$script_dir/fork-release-version-guard.mjs" "$tag" "$newest_tag"; then
      exit 1
    fi
    echo "$tag does not exist yet; this run creates it at $sha"
    exit 0
  fi
  echo "::error::cannot read release $tag: $(head -3 "$errors" | tr '\n' ' ')" >&2
  exit 1
fi

# Why not ${var,,}: macOS /bin/bash is 3.2, and tests/tools/fork-release-guard.test.mjs runs
# this script with an unqualified `bash`.
lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

if [ "$(lower "$target")" = "$(lower "$sha")" ]; then
  echo "$tag already exists at $sha; uploading into it"
  exit 0
fi
# Why the tag's own commit for a non-SHA target: electron-builder records the branch a release was
# published from, and resolving that name against the checkout always equals this run's commit — so
# comparing it would accept a re-dispatch from any commit on that branch.
if resolved="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null)" && [ "$resolved" = "$sha" ]; then
  echo "$tag already exists at $sha; uploading into it"
  exit 0
fi
echo "::error::$tag already exists at $target, not $sha. Re-dispatching from a newer commit would replace its assets while the tag and notes still point at the old revision." >&2
exit 1
