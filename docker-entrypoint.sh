#!/bin/sh
set -e

# Apply pending migrations before starting. Set SKIP_MIGRATIONS=true when
# migrations are run by a separate release step.
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  node node_modules/prisma/build/index.js migrate deploy
fi

exec "$@"
