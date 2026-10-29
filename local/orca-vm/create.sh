#!/usr/bin/env sh
# Fork-only. Allocates ONE ephemeral machine per Orca worktree, torn down with that worktree.
#
# Orca runs this ON THE LAPTOP from the repo root. stdout is a contract: exactly one JSON object and
# nothing else — the result is parsed by a strict schema that rejects unknown keys and otherwise
# fails with "Recipe stdout must be one JSON object.". Every message goes to stderr via log().
#
# To wire: fill in the six verbs below. Nothing else is provider-specific.
set -eu

# --- wire these to the provisioning CLI ---------------------------------------------------
MACHINE_IMAGE=orca-dev-base
MACHINE_CPU=8
MACHINE_MEMORY=16G
PROVISION_VERB="team-machines create --image $MACHINE_IMAGE --cpu $MACHINE_CPU --memory $MACHINE_MEMORY --json"
DESTROY_VERB="team-machines destroy"
SUSPEND_VERB="team-machines suspend"
RESUME_VERB="team-machines resume"
SSH_USER="${SSH_USER:-$(id -un)}"
# Why bounded: an ephemeral host holds agent processes. 0 means "keep alive until reset", which is
# wrong for a disposable machine — one hour past disconnect is enough to reconnect after a sleep.
RELAY_GRACE_SECONDS=3600
# ------------------------------------------------------------------------------------------

log() { printf '%s\n' "$*" >&2; }

# jq reads the provisioner output and builds the result, so a missing jq must fail before allocating.
if ! command -v jq >/dev/null 2>&1; then
  log "create: jq is required"
  exit 1
fi

name="orca-${ORCA_WORKSPACE_NAME}"
# Why the instance id: Orca files this host under it, and a machine left behind is reported under it,
# so the two lines are what let an operator match a provider console row to Orca's own record.
log "allocating $name (instance ${ORCA_VM_INSTANCE_ID:-unknown})"

released=0
# Why empty rather than unset: the trap is armed before the provisioner answers, and `set -u` would end
# the handler on an undefined id — which is the one case that most needs its warning.
resource_id=''
# Why this exists: a create that half-succeeds must not leave a machine nobody knows about.
release() {
  if [ "$released" -eq 1 ]; then
    return 0
  fi
  released=1
  # Why its own message: a cancel that lands before the provisioner printed an id may still have left a
  # machine behind, and there is nothing here to release it with — so this is for a human to check.
  if [ -z "$resource_id" ]; then
    log "WARNING: cancelled before an id was reported — a machine may exist under $name"
    return 0
  fi
  log "releasing $resource_id"
  $DESTROY_VERB "$resource_id" >&2 ||
    log "WARNING: cleanup failed — $resource_id may still be running"
}

# Why a trap and not just the explicit exits: Orca cancels a create by killing the recipe's process
# group, so every explicit `exit` below is skipped exactly when the machine is likeliest to leak. PIPE
# is here for the other half of the same defect: the app closing this script's pipes (a quit) ends the
# next write, and that is also a create nobody is waiting for any more.
on_signal() {
  # Why PIPE is ignored inside the handler: its own release writes to the pipes that just closed, and
  # a SIGPIPE there would end the handler before the machine was released.
  trap '' PIPE
  log "cancelled — releasing $resource_id" || true
  release
  exit 130
}

# Armed before the first allocation rather than after it: a cancel during the provisioning call itself is
# exactly the case where a machine appears and no `exit` path runs.
trap on_signal INT TERM HUP PIPE

created="$($PROVISION_VERB --name "$name")" || { log "provisioning failed"; exit 1; }
resource_id="$(printf '%s' "$created" | jq -r '.id // empty')"
host="$(printf '%s' "$created" | jq -r '.address // empty')"

if [ -z "$resource_id" ] || [ -z "$host" ]; then
  log "could not read id/address from provisioner output: $created"
  release
  exit 1
fi

# Why bounded: Orca imposes no timeout on a recipe, so a machine that never accepts SSH would hang
# the worktree-create until cancelled. Fail, clean up, and say why.
attempt=0
until ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
  "${SSH_USER}@${host}" true >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    log "no SSH after 120s — giving up"
    release
    exit 1
  fi
  sleep 2
done
log "ssh ready in ~$((attempt * 2))s"

# Orca runs `git worktree add` on the guest, so the repository has to exist there first.
repo_name="$(basename "${ORCA_REPO_URL%.git}")"
project_root="/home/${SSH_USER}/${repo_name}"
if ! ssh "${SSH_USER}@${host}" "test -d '${project_root}/.git'" >/dev/null 2>&1; then
  branch_arg=''
  if [ -n "${ORCA_REPO_BRANCH:-}" ]; then
    branch_arg="--branch ${ORCA_REPO_BRANCH}"
  fi
  log "cloning into $project_root"
  if ! ssh "${SSH_USER}@${host}" \
    "git clone ${branch_arg} '${ORCA_REPO_URL}' '${project_root}'" >&2; then
    log "clone failed"
    release
    exit 1
  fi
fi

# Why jq and not printf: a provider address or workspace name carrying a quote or a backslash used to
# exit 0 with unparseable JSON, so Orca got no recipeResult at all and the machine went unrecorded.
jq -c -n \
  --arg projectRoot "$project_root" \
  --arg label "$name" \
  --arg host "$host" \
  --arg username "$SSH_USER" \
  --argjson relayGrace "$RELAY_GRACE_SECONDS" \
  --arg resourceId "$resource_id" \
  '{schemaVersion:1,
    connection:{type:"ssh",projectRoot:$projectRoot,
      target:{label:$label,host:$host,port:22,username:$username,relayGracePeriodSeconds:$relayGrace}},
    userData:{resourceId:$resourceId}}'
