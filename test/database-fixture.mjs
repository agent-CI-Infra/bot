import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/storage/database.js';

let schemaSql, schemaFile;

function template() {
  const directory = mkdtempSync(join(tmpdir(), 'test-schema-'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'schema.sqlite'), database = new DatabaseSync(file);
  try { database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN;' + schemaSql + ';COMMIT;'); }
  finally { database.close(); }
  return file;
}

// Reuse only the completed schema. Every Store still seeds its own defaults with its own key and current time;
// copying a populated database would reuse timestamps and other generated state between fixtures.
export function fixtureStore(path, key) {
  if (schemaSql && !existsSync(path)) {
    // Do not build a template at all when a test set needs only one fresh database.
    schemaFile ??= template();
    copyFileSync(schemaFile, path);
  }
  const store = new Store(path, key);
  try {
    if (!schemaSql) {
      // Virtual tables create their shadow tables themselves.
      const shadows = new Set(store.all('PRAGMA table_list').filter(row => row.type === 'shadow').map(row => row.name));
      schemaSql = store.all("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
        .filter(row => !shadows.has(row.name)).map(row => row.sql).join(';\n');
    }
  } catch (error) { store.close(); throw error; }
  return store;
}
