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

errors="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fork-release-guard.XXXXXX")"
# Why the error file: "the release is missing" and "gh could not tell me" are different answers, and
# reading every failure as "no release yet" is how a ref, auth or network problem created a tag.
if ! target="$(gh release view "$tag" --repo "$repo" --json targetCommitish --jq '.targetCommitish' 2>"$errors")"; then
  if grep -qiE 'not found|HTTP 404' "$errors"; then
    echo "$tag does not exist yet; this run creates it at $sha"
    exit 0
  fi
  echo "::error::cannot read release $tag: $(head -3 "$errors" | tr '\n' ' ')" >&2
  exit 1
fi

if [ "${target,,}" = "${sha,,}" ]; then
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
