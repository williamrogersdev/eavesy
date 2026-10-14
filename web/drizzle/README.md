# Migrations

Applied by `wrangler d1 migrations apply` in filename order. Wrangler records
each applied migration **by file name** in the `d1_migrations` table.

## Duplicate 0010 / 0011 numbers (legacy, do not rename)

Two pairs share a number:

- `0010_flowery_gateway.sql`, `0010_two_track_segments.sql`
- `0011_quiet_daredevil.sql`, `0011_summary_chapters.sql`

The drizzle journal orders the `two_track` and `summary_chapters` migrations
after `0013`, but filename order puts them next to their number twins.
Production has already applied all of them under these names, so renaming
(for example to `0014`/`0015`) would make wrangler treat them as new and re-run
non-idempotent `ALTER TABLE ... ADD COLUMN` / `DROP INDEX` statements, which
fail. They are therefore left as is. The files touch different tables, so the
filename order and the journal order give the same schema.

`scripts/check-migrations.sh` (run in CI) rejects any new duplicate number and
any mismatch between files and `meta/_journal.json`. Generate new migrations
with `drizzle-kit generate` from an up-to-date main so numbers stay unique.
