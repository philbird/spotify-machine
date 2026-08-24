import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  _db = new Database(config.databasePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA_SQL);
  migrate(_db);

  return _db;
}

// CREATE TABLE IF NOT EXISTS never alters existing tables, so columns added to
// the schema after a database was created must be backfilled here.
function migrate(d: Database.Database): void {
  const cols = (d.pragma('table_info(sync_runs)') as { name: string }[]).map((c) => c.name);
  if (!cols.includes('progress')) d.exec('ALTER TABLE sync_runs ADD COLUMN progress TEXT');
  if (!cols.includes('owner_token')) d.exec('ALTER TABLE sync_runs ADD COLUMN owner_token TEXT');
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
