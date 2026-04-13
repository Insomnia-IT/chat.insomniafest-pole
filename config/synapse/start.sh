#!/bin/sh
set -eu

# Verify required env vars exist
: "${SYNAPSE_REGISTRATION_SHARED_SECRET:?missing}"
: "${MACAROON_SECRET_KEY:?missing}"
: "${FORM_SECRET:?missing}"
: "${POSTGRES_PASSWORD:?missing}"

# Render homeserver.yaml from template
sed \
  -e "s|\${SYNAPSE_REGISTRATION_SHARED_SECRET}|${SYNAPSE_REGISTRATION_SHARED_SECRET}|g" \
  -e "s|\${MACAROON_SECRET_KEY}|${MACAROON_SECRET_KEY}|g" \
  -e "s|\${FORM_SECRET}|${FORM_SECRET}|g" \
  -e "s|\${POSTGRES_PASSWORD}|${POSTGRES_PASSWORD}|g" \
  /data/homeserver.yaml.tmpl > /data/homeserver.yaml

exec /start.py
