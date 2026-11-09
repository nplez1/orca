#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installed_app="/Applications/Orca NP.app"
staged_app="/Applications/Orca NP.app.new"
built_app="$repo_root/dist/mac-arm64/Orca NP.app"
bundle_id="com.nplez1.orca"
installed_cli="/usr/local/bin/orca-np"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script only supports macOS on Apple silicon." >&2
  exit 1
fi

if [[ -e "$staged_app" ]]; then
  echo "$staged_app already exists; refusing to overwrite a staged bundle." >&2
  exit 1
fi

cd "$repo_root"
pnpm run install:release
pnpm run build:mac

/usr/libexec/PlistBuddy -c 'Print:CFBundleShortVersionString' "$built_app/Contents/Info.plist"
file "$built_app/Contents/MacOS/Orca NP" | grep -q 'arm64'
codesign --verify --deep --strict "$built_app"

osascript -e "tell application id \"$bundle_id\" to quit"
for _ in $(seq 1 60); do
  if ! ps -axo command= | awk '$0 ~ /^\/Applications\/Orca NP\.app\/Contents\/MacOS\/Orca NP( |$)/ { found=1 } END { exit found ? 0 : 1 }'; then
    break
  fi
  sleep 0.5
done
if ps -axo command= | awk '$0 ~ /^\/Applications\/Orca NP\.app\/Contents\/MacOS\/Orca NP( |$)/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "Installed Orca NP GUI did not exit within 30 seconds; bundle was not replaced." >&2
  exit 1
fi

ditto --rsrc --extattr --acl "$built_app" "$staged_app"
codesign --verify --deep --strict "$staged_app"
backup_path="/private/tmp/orca-np-installed-backup-$(date +%Y%m%d-%H%M%S)"
mv "$installed_app" "$backup_path"
mv "$staged_app" "$installed_app"

env -i \
  HOME="$HOME" \
  USER="${USER:-}" \
  LOGNAME="${LOGNAME:-}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  LANG="${LANG:-en_US.UTF-8}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  /usr/bin/open -na "$installed_app"

for _ in $(seq 1 60); do
  if ps -axo command= | awk '$0 ~ /^\/Applications\/Orca NP\.app\/Contents\/MacOS\/Orca NP( |$)/ { found=1 } END { exit found ? 0 : 1 }'; then
    break
  fi
  sleep 0.5
done
if ! ps -axo command= | awk '$0 ~ /^\/Applications\/Orca NP\.app\/Contents\/MacOS\/Orca NP( |$)/ { found=1 } END { exit found ? 0 : 1 }'; then
  echo "Installed Orca NP GUI did not start within 30 seconds; restore from $backup_path if needed." >&2
  exit 1
fi

/usr/bin/osascript -e "tell application id \"$bundle_id\" to activate"
window_state="$(
  /usr/bin/osascript <<'APPLESCRIPT' 2>/dev/null || true
tell application "System Events"
  if exists process "Orca NP" then
    tell process "Orca NP"
      return (visible as text) & ":" & (count of windows as text)
    end tell
  end if
  return "false:0"
end tell
APPLESCRIPT
)"
if ! grep -q '^true:[1-9]' <<<"$window_state"; then
  echo "Installed Orca NP GUI started without a visible window; restore from $backup_path if needed." >&2
  exit 1
fi

/usr/libexec/PlistBuddy -c 'Print:CFBundleShortVersionString' "$installed_app/Contents/Info.plist"
file "$installed_app/Contents/MacOS/Orca NP"
"$installed_cli" status --json
"$installed_cli" terminal list --json
printf 'Installed bundle updated. Backup retained at %s\n' "$backup_path"
