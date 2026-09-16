#!/usr/bin/env sh
# Fork-only. Parks a worktree's machine instead of releasing it, so resources are not spent on a
# worktree nobody is actively using. Optional: omit `suspend` from orca.yaml if the provider cannot
# do it, and Orca simply will not offer it.
set -eu

SUSPEND_VERB="team-machines suspend"

if ! command -v jq >/dev/null 2>&1; then
  echo "suspend: jq is required" >&2
  exit 1
fi

resource_id="$(cat | jq -r '.recipeResult.userData.resourceId // empty')"
if [ -z "$resource_id" ]; then
  echo "suspend: no resourceId in the lifecycle payload" >&2
  exit 1
fi

$SUSPEND_VERB "$resource_id"
