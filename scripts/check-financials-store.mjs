#!/usr/bin/env node
// Storage check for GuV + prior-year rows (normalize.upsertFinancials).
// Works on a throw-away SQLite file — data/kontur.db is only read, to seed the
// test DB with the real rows of the firms behind the cached JAb XMLs.
//
// Checks:
//   1. Migration — a DB created with the committed (git HEAD) schema gets the
//      guv_json column.
//   2. GuV round-trip — every filing's `guv` comes back from readFinancials.
//   3. Prior years — inserted where the year was missing (source_ref "#VJ"),
//      original rows left untouched where it existed.
//   4. Idempotence — a second identical upsert changes nothing.
//   5. Original wins — upserting the firm's own filing for a "#VJ" year
//      replaces the prior-year row.
//
// Usage: node scripts/check-financials-store.mjs        (exit code 1 on failure)

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parseJAb } from '../server/jab-parser.js';

const STAGING_DIR = 'data/staging-at-jab';
const TEST_DB = path.join(os.tmpdir(), `kontur-store-check-${process.pid}.db`);
// Prior years removed from the seed, so the "#VJ" insert path gets exercised.
const DROP_PRIOR_FOR = ['107110s', '066209t', '110814m'];

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};
const cleanup = () => { for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true }); };

// ── Test DB with the committed schema, before importing the app's DB module ──
cleanup();
const legacy = new Database(TEST_DB);
legacy.exec(execFileSync('git', ['show', 'HEAD:server/db/schema.sql'], { encoding: 'utf8' }));
legacy.close();
process.env.KONTUR_DB = TEST_DB;
const { getDb, migrate, closeDb } = await import('../server/db/index.js');
const { upsertFinancials, readFinancials } = await import('../server/normalize.js');

try {
  migrate();
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(financials_yearly)').all().map((c) => c.name);
  check(cols.includes('guv_json'), 'Migration fügt guv_json zu einer bestehenden DB hinzu');

  // ── Parse cached filings the way at.js downloadAndParse does ──
  const real = new Database('data/kontur.db', { readonly: true, fileMustExist: true });
  const fnOf = real.prepare(`SELECT national_id_canon FROM financials_yearly WHERE country = 'AT' AND source_ref = ?`);
  const filings = [];
  for (const f of existsSync(STAGING_DIR) ? readdirSync(STAGING_DIR).filter((x) => x.endsWith('.xml')) : []) {
    const key = f.replace(/\.xml$/, '');
    const fn = fnOf.get(key)?.national_id_canon;
    const row = parseJAb(readFileSync(path.join(STAGING_DIR, f), 'utf8'));
    if (fn && row) filings.push({ fn, row: { ...row, source_ref: key } });
  }
  if (!filings.length) throw new Error(`no cached XMLs in ${STAGING_DIR} — run scripts/spike-at-jab.mjs first`);

  // ── Seed: real company + financials rows for these firms ──
  const fns = [...new Set(filings.map((x) => x.fn))];
  const ph = fns.map(() => '?').join(',');
  const companies = real.prepare(`SELECT * FROM companies WHERE country = 'AT' AND national_id_canon IN (${ph})`).all(...fns);
  const seedRows = real.prepare(`SELECT * FROM financials_yearly WHERE country = 'AT' AND national_id_canon IN (${ph})`).all(...fns);
  real.close();
  const insertAll = (table, rows) => {
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => r[k] !== undefined);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
    }
  };
  insertAll('companies', companies);
  const dropped = new Map(); // fn → original row removed from the seed
  insertAll('financials_yearly', seedRows.filter((r) => {
    const filing = filings.find((x) => x.fn === r.national_id_canon);
    const isDroppedPrior = DROP_PRIOR_FOR.includes(r.national_id_canon) && r.stichtag === filing?.row.priorYear?.stichtag;
    if (isDroppedPrior) dropped.set(r.national_id_canon, r);
    return !isDroppedPrior;
  }));
  const snapshot = () => db.prepare('SELECT * FROM financials_yearly ORDER BY national_id_canon, stichtag').all();
  const before = snapshot();

  // ── Upsert all filings ──
  for (const { fn, row } of filings) upsertFinancials('AT', fn, [row]);
  const after = snapshot();
  const rowAt = (rows, fn, stichtag) => rows.find((r) => r.national_id_canon === fn && r.stichtag === stichtag);

  // 2. GuV round-trip
  for (const { fn, row } of filings.filter((x) => x.row.guv)) {
    const read = readFinancials('AT', fn).find((r) => r.stichtag === row.stichtag);
    check(JSON.stringify(read?.guv) === JSON.stringify(row.guv), `GuV gespeichert und gelesen: ${fn} ${row.stichtag} (EBITDA ${(row.guv.ebitda / 1e6).toFixed(2)} Mio)`);
  }

  // 3. Prior years: inserted where missing, untouched where present
  for (const { fn, row } of filings) {
    const py = row.priorYear;
    if (!py) continue;
    const old = rowAt(before, fn, py.stichtag);
    const now = rowAt(after, fn, py.stichtag);
    if (old) {
      const untouched = ['source_ref', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'balance_json', 'computed_at']
        .every((k) => old[k] === now[k]);
      check(untouched, `Originalzeile unverändert: ${fn} ${py.stichtag}`);
    } else {
      check(now?.source_ref === `${row.source_ref}#VJ` && now.bilanzsumme === py.bilanzsumme
        && (py.guv ? now.guv_json === JSON.stringify(py.guv) : now.guv_json === null),
      `Vorjahr eingefügt (#VJ${py.guv ? ', mit GuV' : ''}): ${fn} ${py.stichtag}`);
    }
  }
  check(after.length === before.length + DROP_PRIOR_FOR.length,
    `Zeilenzahl ${before.length} → ${after.length} (genau ${DROP_PRIOR_FOR.length} Vorjahre neu)`);

  // 4. Idempotence (computed_at of re-upserted filings moves; ignore it)
  for (const { fn, row } of filings) upsertFinancials('AT', fn, [row]);
  const strip = (rows) => JSON.stringify(rows.map(({ computed_at, ...r }) => r));
  check(strip(snapshot()) === strip(after), 'Zweiter identischer Lauf ändert nichts');

  // 5. Original filing replaces a "#VJ" row
  const [fn, original] = dropped.entries().next().value;
  upsertFinancials('AT', fn, [{
    stichtag: original.stichtag, source_ref: original.source_ref, currency: original.currency,
    umsatzerloese: original.umsatzerloese, bilanzsumme: original.bilanzsumme, eigenkapital: original.eigenkapital,
    jahresergebnis: original.jahresergebnis, betriebsergebnis: original.betriebsergebnis,
    ek_quote: original.ek_quote, balanceSheet: original.balance_json ? JSON.parse(original.balance_json) : null,
  }]);
  const replaced = rowAt(snapshot(), fn, original.stichtag);
  check(replaced.source_ref === original.source_ref && replaced.bilanzsumme === original.bilanzsumme,
    `Originalabschluss ersetzt #VJ-Zeile: ${fn} ${original.stichtag}`);
} catch (err) {
  check(false, `Abbruch: ${err.message}`);
} finally {
  closeDb();
  cleanup();
}

console.log(failures ? `\n✗ ${failures} Problem(e)` : '\n✓ alle Speicher-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
