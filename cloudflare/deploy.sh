#!/bin/sh
# Deploy the Worker AND attach runtime secrets in the same step.
#
# Why: when a Worker is deployed through the GitHub integration (Workers Builds),
# `wrangler deploy` produces a version that does NOT include secrets set in the
# dashboard (see cloudflare/workers-sdk#8871). So we pass them explicitly with
# --secrets-file, reading the values from ENCRYPTED BUILD VARIABLES configured in
# the Workers Builds settings. The values never live in this repository.
#
# Required build variables (Workers Builds → Settings → Build → Variables and
# secrets, all as "Secret"/encrypted):
#   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY, REDMINE_API_KEY
set -eu

: "${GITHUB_CLIENT_ID:?Set GITHUB_CLIENT_ID as an encrypted build variable}"
: "${GITHUB_CLIENT_SECRET:?Set GITHUB_CLIENT_SECRET as an encrypted build variable}"
: "${COOKIE_ENCRYPTION_KEY:?Set COOKIE_ENCRYPTION_KEY as an encrypted build variable}"
: "${REDMINE_API_KEY:?Set REDMINE_API_KEY as an encrypted build variable}"

SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT

cat > "$SECRETS_FILE" <<EOF
GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
COOKIE_ENCRYPTION_KEY=$COOKIE_ENCRYPTION_KEY
REDMINE_API_KEY=$REDMINE_API_KEY
EOF

npx wrangler deploy --secrets-file "$SECRETS_FILE"
