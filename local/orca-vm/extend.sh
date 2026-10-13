#!/usr/bin/env sh
# Fork-only. Buys more time on the machine create.sh allocated, so a host outliving its default
# lease can be kept alive from the workspace instead of being recreated.
#
# Orca runs this ON THE LAPTOP from the repo root and passes one JSON line on stdin. stdout is the
# same contract as create: exactly one JSON object, the recipe result, with the lifetime metadata
# moved to the deadline the provider reports. Every message goes to stderr.
#
# To wire: point the two verbs below at the provisioner, and declare only lifetimes it will sell —
# orca.yaml's extendDurations is the entire menu Orca offers.
set -eu

# Asks for the extra time. Takes the resource id and a `<count><unit>` lifetime such as 4h.
EXTEND_VERB="team-machines extend"
# Reports the resource as JSON, including its absolute deadline.
SHOW_VERB="team-machines show"

log() { printf '%s\n' "$*" >&2; }

if ! command -v jq >/dev/null 2>&1; then
  log "extend: jq is required"
  exit 1
fi

payload="$(cat)"
resource_id="$(printf '%s' "$payload" | jq -r '.recipeResult.userData.resourceId // empty')"
lifetime="$(printf '%s' "$payload" | jq -r '.lifetime // empty')"
if [ -z "$resource_id" ] || [ -z "$lifetime" ]; then
  # Why not the payload: it carries the connection, including any pairing code, and stderr can reach
  # a log the user pastes elsewhere. Name the keys instead.
  log "extend: payload is missing resourceId and/or lifetime (keys: $(printf '%s' "$payload" | jq -r 'keys | join(",")'))"
  exit 1
fi

log "extending $resource_id by $lifetime"
$EXTEND_VERB "$resource_id" "$lifetime" >&2

# Why re-read instead of adding the duration locally: only the provider's own deadline is enforced,
# so a local sum would count down to an instant nobody guarantees.
resource="$($SHOW_VERB "$resource_id" --json)"
release_at="$(printf '%s' "$resource" | jq -r '.expiresAt // empty')"
remaining="$(printf '%s' "$resource" | jq -r '.remainingSeconds // empty')"
if [ -z "$release_at" ]; then
  log "provider reported no expiresAt — refusing to report an extension that moved no deadline"
  exit 1
fi

# Everything else is passed through untouched: an unchanged `connection` is what keeps the host
# attached with its live terminals rather than forcing a reconnect.
result="$(printf '%s' "$payload" | jq -c --arg release "$release_at" '.recipeResult | .userData.releaseAt = $release')"
if [ -n "$remaining" ]; then
  result="$(printf '%s' "$result" | jq -c --argjson seconds "$remaining" '.userData.lifetimeSeconds = $seconds')"
fi
printf '%s\n' "$result"
