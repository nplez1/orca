#!/bin/bash
# Remove only the install-owned symlink we created (`orca-np`); /usr/bin/orca-ide belongs to an
# official Orca install and is none of this package's business.
set -e

# RPM passes an instance count; dpkg passes the package lifecycle action.
case "${1-}" in
  0 | remove | purge) ;;
  *) exit 0 ;;
esac

link="/usr/bin/orca-np"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    "/opt/Orca NP/"* | /opt/orca-np/* | /opt/Orca/* | /opt/orca-ide/* | /opt/orca/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
