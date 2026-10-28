#!/bin/bash
# deb/rpm must register `orca-np` on PATH for headless hosts where the in-app installer cannot
# run; the install dir is discovered because electron-builder names it after the product. Fork:
# the command is `orca-np` — an official install owns `orca-ide`. LOCAL-PATCHES.md § local(identity).
set -e

link="/usr/bin/orca-np"

# Kept as upstream's file name on purpose; see linux.executableName in
# config/electron-builder.config.cjs.
launcher_rel="resources/bin/orca-ide"

install_dirs=(
  "/opt/Orca NP"
  "/opt/orca-np"
  "/opt/Orca"
  "/opt/orca-ide"
  "/opt/orca"
)

is_owned_link() {
  [ -L "$link" ] || return 1
  local link_target dir candidate
  link_target="$(readlink -f -- "$link" 2>/dev/null || true)"
  for dir in "${install_dirs[@]}"; do
    candidate="$(readlink -f -- "$dir/$launcher_rel" 2>/dev/null || true)"
    if [ -n "$candidate" ] && [ "$link_target" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

for dir in "${install_dirs[@]}"; do
  sandbox="$dir/chrome-sandbox"
  if [ -f "$sandbox" ]; then
    # Why: packaged Linux installs must leave Chromium's sandbox helper usable
    # on hosts where unprivileged user namespaces are unavailable.
    chmod 4755 "$sandbox" || true
  fi

  shim="$dir/$launcher_rel"
  if [ -x "$shim" ]; then
    # Only manage our own symlink; never clobber an unrelated /usr/bin/orca-np.
    if { [ ! -e "$link" ] && [ ! -L "$link" ]; } || is_owned_link; then
      ln -sfn -- "$shim" "$link"
    fi
    break
  fi
done

exit 0
