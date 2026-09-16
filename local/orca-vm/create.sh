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

name="orca-${ORCA_WORKSPACE_NAME}"
log "allocating $name"

created="$($PROVISION_VERB --name "$name")" || { log "provisioning failed"; exit 1; }
resource_id="$(printf '%s' "$created" | jq -r '.id // empty')"
host="$(printf '%s' "$created" | jq -r '.address // empty')"

# Why this exists: a create that half-succeeds must not leave a machine nobody knows about.
release() {
  log "releasing $resource_id"
  $DESTROY_VERB "$resource_id" >&2 ||
    log "WARNING: cleanup failed — $resource_id may still be running"
}

if [ -z "$resource_id" ] || [ -z "$host" ]; then
  log "could not read id/address from provisioner output: $created"
  if [ -n "$resource_id" ]; then
    release
  fi
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

printf '{"schemaVersion":1,"connection":{"type":"ssh","projectRoot":"%s","target":{"label":"%s","host":"%s","port":22,"username":"%s","relayGracePeriodSeconds":%s}},"userData":{"resourceId":"%s"}}\n' \
  "$project_root" "$name" "$host" "$SSH_USER" "$RELAY_GRACE_SECONDS" "$resource_id"
