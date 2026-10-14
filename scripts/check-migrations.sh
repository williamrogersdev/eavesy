#!/usr/bin/env bash
# Fails if web/drizzle has duplicate migration numbers, other than the two
# legacy pairs below. Wrangler applies migrations in filename order and tracks
# them by name in d1_migrations, so a duplicate number makes the order depend on
# the random suffix. See web/drizzle/README.md.
set -euo pipefail
cd "$(dirname "$0")/../web/drizzle"

LEGACY="0010 0011"

dups=$(ls *.sql | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -d)
bad=0
for n in $dups; do
  case " $LEGACY " in
    *" $n "*) ;;
    *) echo "::error::Duplicate migration number $n in web/drizzle"; bad=1 ;;
  esac
done

# Every migration file must be listed in the drizzle journal, and vice versa.
for f in *.sql; do
  grep -q "\"tag\": \"${f%.sql}\"" meta/_journal.json || { echo "::error::$f is not in meta/_journal.json"; bad=1; }
done
for t in $(grep -o '"tag": "[^"]*"' meta/_journal.json | sed 's/.*: "//;s/"//'); do
  [ -f "$t.sql" ] || { echo "::error::Journal entry $t has no .sql file"; bad=1; }
done
exit $bad
