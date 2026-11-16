#!/usr/bin/env bash
# Refuse to let an artifact leg upload unless this run's release exists and is still a draft.
#
# Why every leg checks for itself, immediately before electron-builder publishes: the draft is
# `release-draft`'s, and a leg can run without that job running again — "Re-run job" on one leg, or
# `gh run rerun --failed` after the draft was deleted. electron-builder then does one of two silent
# things (electron-publish 26.15.3, `GitHubPublisher.getOrCreateRelease`):
#
# - no release for the tag: it creates one of its own, so legs re-run together race to create it;
# - a published release: under the config's `releaseType: draft` it returns null, `doUpload` logs
#   "skipped publishing" and the leg exits 0. The old manifest is still on the release, so the leg's
#   own manifest check — and `publish`'s — pass on assets this run never uploaded.
#
# Usage: fork-release-require-draft.sh REPOSITORY TAG
# Exit: 0 the release is a draft, 1 refuse, 2 usage.
set -euo pipefail

repo=${1:-}
tag=${2:-}
if [ -z "$repo" ] || [ -z "$tag" ]; then
  echo "usage: fork-release-require-draft.sh REPOSITORY TAG" >&2
  exit 2
fi

errors="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fork-release-draft.XXXXXX")"
# Why the error file: "no release" and "gh could not tell me" are different failures, and both
# refuse — but only one of them is fixed by re-running the whole workflow.
if ! draft="$(gh release view "$tag" --repo "$repo" --json isDraft --jq '.isDraft' 2>"$errors")"; then
  if grep -qiE 'not found|HTTP 404' "$errors"; then
    echo "::error::$tag has no release, so electron-builder would create one of its own. The draft is created by release-draft: re-run every job (gh run rerun <id>) or dispatch again — not --failed and not a single job." >&2
  else
    echo "::error::cannot read release $tag: $(head -3 "$errors" | tr '\n' ' ')" >&2
  fi
  exit 1
fi

if [ "$draft" != "true" ]; then
  echo "::error::$tag is already published (isDraft=$draft). electron-builder skips the upload to a published release under releaseType: draft and exits 0, so this leg would pass on the assets already there. Dispatch a new version instead." >&2
  exit 1
fi
echo "$tag is a draft; this leg uploads into it"
