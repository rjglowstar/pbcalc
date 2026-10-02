#!/usr/bin/env bash
# Runs the real-OS-click check (moves the mouse!). See scripts/manual-os-click.js.
set -u
cd "$(dirname "$0")/.."
CH="$(mktemp -d)"
export PBCALC_CHANNEL="$(cygpath -w "$CH" 2>/dev/null || echo "$CH")"
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/manual-os-click.js > "$CH/out.txt" 2>&1 &
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w scripts/manual-os-click.ps1)" -Channel "$PBCALC_CHANNEL" >/dev/null 2>&1
wait
grep -h "DBG" "$CH/out.txt" 2>/dev/null; cat "$CH/result.txt" 2>/dev/null || echo "no result (app did not finish)"
rm -rf "$CH"
