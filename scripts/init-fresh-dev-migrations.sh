#!/usr/bin/env bash
# Builds a migration folder for initializing a completely fresh/empty
# Supabase project (e.g. a rebuilt dev project, or `supabase db reset`
# against one) — the ONE-TIME step described in
# supabase/MIGRATION_README.md's "Directory structure" section.
#
# Not needed for ordinary day-to-day development: once a dev project has
# been initialized once, its own schema_migrations table already records
# the bootstrap as applied, and every later new file just goes straight
# into supabase/migrations/ and pushes normally, same as production.
#
# Usage:
#   scripts/init-fresh-dev-migrations.sh <output-dir>
#   supabase db push --dry-run --db-url "<dev-db-url>" --workdir <output-dir>
#   # review the printed migration list, then re-run without --dry-run

set -euo pipefail

OUT="${1:?Usage: $0 <output-dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$OUT/supabase/migrations"
cp "$REPO_ROOT"/supabase/dev-bootstrap/*.sql "$OUT/supabase/migrations/"
cp "$REPO_ROOT"/supabase/migrations/*.sql "$OUT/supabase/migrations/"

echo "Fresh-dev migration folder built at: $OUT/supabase/migrations"
echo "($(ls "$OUT/supabase/migrations" | wc -l) files — bootstrap + the shared migrations)"
echo ""
echo "Never point this command at production — it is for initializing an"
echo "empty project only. Verify --db-url targets the intended project"
echo "before running, and always --dry-run first."
