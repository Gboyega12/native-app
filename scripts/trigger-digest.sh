#!/usr/bin/env bash
# Manually trigger the weekly digest for all opted-in users.
# Usage: CRON_SECRET=your_secret ./scripts/trigger-digest.sh

set -euo pipefail

APP_URL="${APP_URL:-https://app.bocy.io}"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "Error: CRON_SECRET is required."
  echo "Usage: CRON_SECRET=your_secret ./scripts/trigger-digest.sh"
  exit 1
fi

echo "Triggering weekly digest at ${APP_URL}/api/cron/weekly-digest ..."

response=$(curl -s -w "\n%{http_code}" -X POST "${APP_URL}/api/cron/weekly-digest" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -H "Content-Type: application/json")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

echo "Status: ${http_code}"
echo "Response: ${body}"

if [ "$http_code" -ne 200 ]; then
  echo "Failed to trigger digest."
  exit 1
fi

echo "Done."
