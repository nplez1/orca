#!/usr/bin/env sh
# Fork-only. Brings a parked machine back. Counterpart to suspend.sh.
set -eu

RESUME_VERB="team-machines resume"

if ! command -v jq >/dev/null 2>&1; then
  echo "resume: jq is required" >&2
  exit 1
fi

resource_id="$(cat | jq -r '.recipeResult.userData.resourceId // empty')"
if [ -z "$resource_id" ]; then
  echo "resume: no resourceId in the lifecycle payload" >&2
  exit 1
fi

$RESUME_VERB "$resource_id"
