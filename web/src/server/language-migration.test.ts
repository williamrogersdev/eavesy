import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(import.meta.dir, '../../drizzle');
const TARGET = '0028_auto_detect_language.sql';

function apply(sqlite: Database, file: string) {
  for (const chunk of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) {
    if (chunk.trim()) sqlite.exec(chunk);
  }
}

describe('0028_auto_detect_language', () => {
  test('moves English users to automatic detection and leaves other choices alone', () => {
    const sqlite = new Database(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter((f) => f < TARGET)) apply(sqlite, file);
    for (const [id, language] of [['u_en', 'en'], ['u_fr', 'fr'], ['u_auto', 'auto']]) {
      sqlite.run(
        `INSERT INTO users (id, default_language, created_at, updated_at) VALUES (?, ?, 0, 0)`,
        [id, language],
      );
    }
    apply(sqlite, TARGET);
    expect(sqlite.query('SELECT id, default_language FROM users ORDER BY id').all()).toEqual([
      { id: 'u_auto', default_language: 'auto' },
      { id: 'u_en', default_language: 'auto' },
      { id: 'u_fr', default_language: 'fr' },
    ]);
  });
});
