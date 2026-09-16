#!/usr/bin/env sh
# Fork-only. Run ON a candidate guest image to prove it is ready before you snapshot it.
#
# Everything checked here is something Orca would otherwise install or compile on first connect,
# on the critical path. See LOCAL-PATCHES.md § local(vm).
#
#   scp local/orca-vm/verify-guest-image.sh dev@host:/tmp && ssh dev@host 'sh /tmp/verify-guest-image.sh'
#
# Env: ORCA_IMAGE_REPO_MIRROR — optional path to a baked mirror/clone to check.
set -u

platform="$(uname -s)"
misses=0
ok() { printf '  ok    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; misses=$((misses + 1)); }
note() { printf '  --    %s\n' "$1"; }

printf '\nGuest image readiness (%s %s)\n' "$platform" "$(uname -m)"

# ── node + npm: the relay bundle runs on the guest's node ────────────────────────────────
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 18 ]; then
    ok "node $(node -v)"
  else
    miss "node $(node -v) is too old — the relay needs 18+"
  fi
else
  miss "node not installed — the relay bundle needs 18+"
fi
if command -v npm >/dev/null 2>&1; then
  ok "npm present"
else
  miss "npm not installed"
fi

# ── git: Orca runs `git worktree add` on the guest ──────────────────────────────────────
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  miss "git not installed"
fi
if [ -n "${ORCA_IMAGE_REPO_MIRROR:-}" ]; then
  if [ -d "$ORCA_IMAGE_REPO_MIRROR" ]; then
    ok "repo mirror baked at $ORCA_IMAGE_REPO_MIRROR"
  else
    miss "repo mirror $ORCA_IMAGE_REPO_MIRROR missing"
  fi
fi

# ── C/C++ toolchain: required on Linux only. node-pty@1.1.0 ships no Linux prebuild, so the
#    remote install falls back to node-gyp; macOS and Windows get prebuilts.
if [ "$platform" = "Linux" ]; then
  toolchain_missing=''
  for tool in make gcc g++ python3; do
    command -v "$tool" >/dev/null 2>&1 || toolchain_missing="$toolchain_missing $tool"
  done
  if [ -z "$toolchain_missing" ]; then
    ok 'build toolchain complete'
  else
    miss "build toolchain missing:$toolchain_missing — node-gyp fails on first connect"
  fi
else
  note "build toolchain not required on $platform (node-pty ships a prebuild)"
fi

# ── the pre-built relay. This is the artifact worth baking: the shared native-deps cache is
#    keyed on platform + a hash of the pinned dep versions and patch bytes, NOT on the relay JS
#    bundle, so it survives Orca updates. The version-scoped relay-<hash> dir is not worth
#    baking — it moves on every commit to src/relay/ and is replaced on mismatch anyway.
if [ "$platform" = "Linux" ] || [ "$platform" = "Darwin" ]; then
  found=0
  for dir in "$HOME"/.orca-remote/native/*/; do
    [ -d "$dir" ] || continue
    found=1
    entry="$(basename "$dir")"
    if [ ! -f "${dir}.deps-complete" ]; then
      miss "$entry has no .deps-complete — an incomplete half-build, never linked"
      continue
    fi
    dep_missing=''
    for dep in 'node-pty' '@parcel/watcher'; do
      [ -e "${dir}node_modules/${dep}" ] || dep_missing="$dep_missing $dep"
    done
    if [ -z "$dep_missing" ]; then
      ok "native deps baked: $entry"
    else
      miss "$entry missing:$dep_missing"
    fi
  done
  if [ "$found" -eq 0 ]; then
    miss 'no baked native deps in ~/.orca-remote/native — first connect compiles node-pty from source'
  fi
else
  note "shared native-deps cache does not apply on $platform (win32 prebuilds, in-place patch)"
fi

# ── agent CLIs: presence is checkable, the logins are the part that cannot be automated ───
agents=''
for cli in codex claude gemini cursor-agent aider opencode; do
  command -v "$cli" >/dev/null 2>&1 && agents="$agents $cli"
done
if [ -n "$agents" ]; then
  ok "agent CLIs on PATH:$agents"
else
  miss 'no agent CLI on PATH'
fi
note 'verify agent logins by hand — Orca never pushes credentials to a guest'

printf '\n'
if [ "$misses" -eq 0 ]; then
  printf 'Ready to snapshot.\n\n'
  exit 0
fi
printf '%s check(s) failed — fix before snapshotting.\n\n' "$misses"
exit 1
