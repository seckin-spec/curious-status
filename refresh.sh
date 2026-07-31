#!/bin/bash
# Regenerate the dashboard from live data, re-encrypt, and push to GitHub Pages.
# Run manually (`./refresh.sh`) or on a schedule (com.curiousbrand.status-refresh.plist).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DIR="/Users/seckinuysal/Desktop/Desktop Organized - 2026-07-06/Development/ClaudeCodes/Plugins/leadmagnet-factory 2/dashboard"
cd "$DIR" || exit 1
LOG="$DIR/refresh.log"

echo "=== $(date) ===" >> "$LOG"
node sync.mjs    >> "$LOG" 2>&1 || { echo "sync failed" >> "$LOG"; exit 1; }
node protect.mjs >> "$LOG" 2>&1 || { echo "protect failed" >> "$LOG"; exit 1; }

# publish to GitHub Pages (docs/ is the Pages source). New salt/iv each run => always a diff.
git add docs/index.html >> "$LOG" 2>&1
if git -c user.name="Seckin Uysal" -c user.email="seckin@curiousbrand.co.uk" \
     commit -qm "auto-refresh $(date +%F' '%H:%M)" >> "$LOG" 2>&1; then
  git push -q origin main >> "$LOG" 2>&1 && echo "pushed to GitHub Pages" >> "$LOG" || echo "push failed" >> "$LOG"
else
  echo "no changes to publish" >> "$LOG"
fi
