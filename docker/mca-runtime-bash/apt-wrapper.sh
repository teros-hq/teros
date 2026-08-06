#!/bin/bash
# apt / apt-get wrapper for the bash MCA runtime.
#
# Installed ahead of /usr/bin on PATH. It runs the real apt, and on success
# records the set of MANUALLY-installed packages that differ from the image
# baseline into /app-data/.state/apt-packages.txt. entrypoint.sh replays that
# list on the next boot (the container FS is ephemeral; /app-data persists).
#
# Diffing `apt-mark showmanual` rather than parsing argv makes the record
# correct regardless of how the user invoked apt (versions, meta-packages,
# remove/purge/autoremove) and naturally idempotent + deduped.
set -o pipefail

REAL="/usr/bin/$(basename "$0")"

# DPkg::Lock::Timeout lets a user apt wait instead of failing while the boot-time
# replay still holds the dpkg lock.
"$REAL" -o DPkg::Lock::Timeout=600 "$@"
rc=$?

if [ "$rc" -eq 0 ] && [ -d /app-data/.state ] && [ -f /etc/teros/apt-baseline.txt ]; then
  case " $* " in
    *" install "*|*" remove "*|*" purge "*|*" autoremove "*|*" full-upgrade "*)
      if comm -13 /etc/teros/apt-baseline.txt <(apt-mark showmanual 2>/dev/null | sort) \
           > /app-data/.state/apt-packages.txt.tmp 2>/dev/null; then
        mv -f /app-data/.state/apt-packages.txt.tmp /app-data/.state/apt-packages.txt
      else
        rm -f /app-data/.state/apt-packages.txt.tmp
      fi
      ;;
  esac
fi

exit "$rc"
