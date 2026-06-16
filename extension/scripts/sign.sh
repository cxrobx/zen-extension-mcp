#!/usr/bin/env bash
# Wrapper for `web-ext sign` that loads AMO creds from ~/.config/zen-extension-mcp/.env
# unless they are already exported in the environment.
set -euo pipefail

ENV_FILE="${ZEN_EXT_ENV_FILE:-$HOME/.config/zen-extension-mcp/.env}"

if [ -z "${AMO_KEY:-}" ] || [ -z "${AMO_SECRET:-}" ]; then
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
fi

if [ -z "${AMO_KEY:-}" ] || [ -z "${AMO_SECRET:-}" ]; then
  echo "error: AMO_KEY and AMO_SECRET are not set." >&2
  echo "  edit $ENV_FILE and fill in the values from" >&2
  echo "  https://addons.mozilla.org/developers/addon/api/key/" >&2
  exit 1
fi

exec npx web-ext sign \
  --source-dir=dist \
  --channel=unlisted \
  --api-key="$AMO_KEY" \
  --api-secret="$AMO_SECRET"
