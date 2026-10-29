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
# How many times to ask for the deadline when the extend verb's own answer does not carry it.
SHOW_ATTEMPTS=3

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
# Captured rather than streamed: the grant often reports the new deadline itself, and that answer
# cannot be reread once it has gone straight to stderr.
extended="$($EXTEND_VERB "$resource_id" "$lifetime")"
if [ -n "$extended" ]; then
  printf '%s\n' "$extended" >&2
fi

# Why not add the duration locally: only the provider's own deadline is enforced, so a local sum would
# count down to an instant nobody guarantees. The grant's own answer counts; the follow-up read is the
# fallback because it is the step that can fail.
release_at="$(printf '%s' "$extended" | jq -r '.expiresAt // empty' 2>/dev/null || true)"
remaining="$(printf '%s' "$extended" | jq -r '.remainingSeconds // empty' 2>/dev/null || true)"

# Why retry: the lease is already extended here, so one failed read would throw away the deadline the
# user just paid for and leave the app counting down to the old one — reclaiming the host early.
attempt=0
while [ -z "$release_at" ] && [ "$attempt" -lt "$SHOW_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  resource="$($SHOW_VERB "$resource_id" --json || true)"
  release_at="$(printf '%s' "$resource" | jq -r '.expiresAt // empty' 2>/dev/null || true)"
  remaining="$(printf '%s' "$resource" | jq -r '.remainingSeconds // empty' 2>/dev/null || true)"
  if [ -z "$release_at" ] && [ "$attempt" -lt "$SHOW_ATTEMPTS" ]; then
    sleep 1
  fi
done
if [ -z "$release_at" ]; then
  log "extend: the provider granted the extension but reported no deadline for $resource_id in $SHOW_ATTEMPTS reads — Orca keeps the old deadline, so this host can be reclaimed early. Re-run extend to pick the new deadline up."
  exit 1
fi

# Everything else is passed through untouched: an unchanged `connection` is what keeps the host
# attached with its live terminals rather than forcing a reconnect.
result="$(printf '%s' "$payload" | jq -c --arg release "$release_at" '.recipeResult | .userData.releaseAt = $release')"
# Why the shape check: jq exits non-zero on a non-numeric argument, and the extension has already been
# granted by this point — a countdown we cannot format must not turn a moved deadline into a failure.
case "$remaining" in
  '' | *[!0-9]*) ;;
  *) result="$(printf '%s' "$result" | jq -c --argjson seconds "$remaining" '.userData.lifetimeSeconds = $seconds')" ;;
esac
printf '%s\n' "$result"
