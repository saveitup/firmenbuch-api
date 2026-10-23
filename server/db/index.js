// Kontur — SQLite connection and migration runner.
// `better-sqlite3` is synchronous, deliberately: SQLite reads are microsecond-
// latency and the whole app runs in one process. Async-wrapping them would
// only add overhead with no benefit.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PATH = path.join(ROOT, 'data', 'kontur.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbPath = process.env.KONTUR_DB || DEFAULT_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  _db = db;
  return db;
}

export function migrate() {
  const db = getDb();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  // Additive column migrations for older DB files created before the column
  // existed in schema.sql. SQLite lacks IF NOT EXISTS on ALTER, so guard with
  // a table_info check.
  addColumnIfMissing(db, 'financials_yearly', 'balance_json', 'TEXT');
  addColumnIfMissing(db, 'financials_yearly', 'guv_json', 'TEXT');
  addColumnIfMissing(db, 'at_jab_ingest', 'role', "TEXT NOT NULL DEFAULT 'latest'");
  return { path: db.name };
}

function addColumnIfMissing(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
