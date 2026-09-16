#!/usr/bin/env sh
# Fork-only. Releases the machine create.sh allocated for a worktree.
#
# Orca runs this on the laptop and passes a JSON payload on stdin; the machine's handle is the
# userData that create printed.
#
# Make the destroy verb idempotent on the provider side: destroying an already-destroyed machine is
# normal here (a failed create cleans up after itself, and a worktree may be deleted twice).
set -eu

DESTROY_VERB="team-machines destroy"

log() { printf '%s\n' "$*" >&2; }

payload="$(cat)"
resource_id="$(printf '%s' "$payload" | jq -r '.recipeResult.userData.resourceId // empty')"
if [ -z "$resource_id" ]; then
  log "no resourceId in the destroy payload: $payload"
  exit 1
fi

log "releasing $resource_id"
$DESTROY_VERB "$resource_id"
