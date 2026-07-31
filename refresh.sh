#!/bin/bash
# Regenerate the dashboard from live data, re-encrypt, and redeploy to Netlify.
# Run manually (`./refresh.sh`) or on a schedule (see com.curiousbrand.status-refresh.plist).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DIR="/Users/seckinuysal/Desktop/Desktop Organized - 2026-07-06/Development/ClaudeCodes/Plugins/leadmagnet-factory 2/dashboard"
cd "$DIR" || exit 1
LOG="$DIR/refresh.log"

echo "=== $(date) ===" >> "$LOG"
node sync.mjs    >> "$LOG" 2>&1 || { echo "sync failed" >> "$LOG"; exit 1; }
node protect.mjs >> "$LOG" 2>&1 || { echo "protect failed" >> "$LOG"; exit 1; }

TOKEN=$(grep '^NETLIFY_TOKEN=' .env | cut -d= -f2)
SID=$(grep SID= .netlify-site | cut -d= -f2)
[ -z "$TOKEN" ] || [ -z "$SID" ] && { echo "missing token/site" >> "$LOG"; exit 1; }

( cd dist && zip -qr ../deploy.zip . )
STATE=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @deploy.zip "https://api.netlify.com/api/v1/sites/$SID/deploys" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).state)}catch{console.log("err")}})')
rm -f deploy.zip
echo "deploy: $STATE" >> "$LOG"
