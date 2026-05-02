import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from '../src/db/schema.js';

const dbPath = path.resolve(process.env.DATABASE_PATH ?? './data/spotify.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const d = new Database(dbPath);
d.pragma('journal_mode = WAL');
d.pragma('foreign_keys = ON');
d.exec(SCHEMA_SQL);

const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log(`DB at ${dbPath}`);
console.log(`Tables: ${tables.map(t => t.name).join(', ')}`);
d.close();
