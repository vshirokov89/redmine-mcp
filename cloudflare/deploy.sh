#!/bin/sh
# Deploy the Worker AND attach runtime secrets in the same step.
#
# Why: when a Worker is deployed through the GitHub integration (Workers Builds),
# `wrangler deploy` produces a version that does NOT include secrets set in the
# dashboard (see cloudflare/workers-sdk#8871). So we pass them explicitly with
# --secrets-file, reading the values from ENCRYPTED BUILD VARIABLES configured in
# the Workers Builds settings. The values never live in this repository.
#
# Required build variables (Workers Builds -> Settings -> Build -> Variables and
# secrets, all as "Secret"/encrypted):
#   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, COOKIE_ENCRYPTION_KEY
# Plus at least one Redmine key source:
#   REDMINE_USERS   - JSON map of GitHub login -> {name, key} for per-user keys
#                     (multi-user mode). Must be a single line (no newlines).
#   REDMINE_API_KEY - a single shared key (legacy single-user mode).
# You can set both during migration.
set -eu

: "${GITHUB_CLIENT_ID:?Set GITHUB_CLIENT_ID as an encrypted build variable}"
: "${GITHUB_CLIENT_SECRET:?Set GITHUB_CLIENT_SECRET as an encrypted build variable}"
: "${COOKIE_ENCRYPTION_KEY:?Set COOKIE_ENCRYPTION_KEY as an encrypted build variable}"

if [ -z "${REDMINE_API_KEY:-}" ] && [ -z "${REDMINE_USERS:-}" ]; then
	echo "Set REDMINE_USERS (per-user JSON) and/or REDMINE_API_KEY as an encrypted build variable" >&2
	exit 1
fi

SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT

# .env format: KEY=VALUE, one per line. Values must not contain newlines;
# REDMINE_USERS must therefore be single-line JSON.
{
	printf 'GITHUB_CLIENT_ID=%s\n' "$GITHUB_CLIENT_ID"
	printf 'GITHUB_CLIENT_SECRET=%s\n' "$GITHUB_CLIENT_SECRET"
	printf 'COOKIE_ENCRYPTION_KEY=%s\n' "$COOKIE_ENCRYPTION_KEY"
	if [ -n "${REDMINE_API_KEY:-}" ]; then printf 'REDMINE_API_KEY=%s\n' "$REDMINE_API_KEY"; fi
	if [ -n "${REDMINE_USERS:-}" ]; then printf 'REDMINE_USERS=%s\n' "$REDMINE_USERS"; fi
} > "$SECRETS_FILE"

npx wrangler deploy --secrets-file "$SECRETS_FILE"
