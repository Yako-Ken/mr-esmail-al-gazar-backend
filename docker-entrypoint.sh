#!/bin/sh
# Container entrypoint.
#
# Runs pending migrations against the injected DATABASE_URL before starting the
# server. Previously the container ran `npm start` directly, which relied on the
# app auto-syncing the schema on boot — acceptable for a throwaway SQLite file,
# wrong for a managed PostgreSQL where the schema must be migrated explicitly
# and where several replicas may boot at once.
#
# Safe to run repeatedly: `migrate deploy` only applies pending migrations.
set -e

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: DATABASE_URL is not set. The product requires PostgreSQL." >&2
  exit 1
fi

case "$DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *)
    echo "FATAL: DATABASE_URL must be a postgresql:// URL." >&2
    exit 1
    ;;
esac

echo "==> Running database migrations"
# The local binary directly, never `npx`: in the runtime image `npx` crashes
# with "Class extends value undefined" (its own internals, not our code), which
# took down every boot in a restart loop. The prisma CLI ships in dependencies
# (not devDependencies) precisely so this binary exists here.
./node_modules/.bin/prisma migrate deploy

echo "==> Starting server"
exec "$@"
