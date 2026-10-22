#!/usr/bin/env node
// AT universe backfill — walks JustizOnline's Urkunden change feed
// (VERAENDERUNGENURKUNDE) week by week and records every announced document
// in `at_register_documents`. The view `at_universe` turns that into one row
// per firm with a Jahresabschluss, incl. the prefilter flags (Lagebericht /
// Bestätigungsvermerk ⇒ mittelgroß/groß, Konzernabschluss, …).
// Metadata only — no document downloads.
//
// Usage:
//   npm run ingest:at-universe                              # last 24 months
//   npm run ingest:at-universe -- --months=3
//   npm run ingest:at-universe -- --from=2026-01-01 --to=2026-03-31
//
// Windows are ISO weeks (Mon–Sun), newest first. Completed weeks are recorded
// in `at_feed_windows` and skipped on re-runs; the running week is refetched
// every time. Safe to interrupt and re-run.

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { migrate, getDb } from '../server/db/index.js';
import at from '../server/adapters/at.js';

const LOG_DIR  = 'logs';
const LOG_PATH = `${LOG_DIR}/at-universe.log`;
const RETRIES  = 2;
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, `${stamped}\n`);
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);
const mondayOf = (d) => addDays(d, -((d.getUTCDay() + 6) % 7));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ISO weeks covering [from, to], newest first. `bis` is capped at `to`.
function weeklyWindows(from, to) {
  const windows = [];
  for (let mon = mondayOf(to); mon >= mondayOf(from); mon = addDays(mon, -7)) {
    const sun = addDays(mon, 6);
    windows.push({ von: iso(mon < from ? from : mon), bis: iso(sun > to ? to : sun), complete: sun <= to });
  }
  return windows;
}

async function fetchWithRetry(von, bis) {
  for (let attempt = 0; ; attempt++) {
    try { return await at.getDocumentChanges(von, bis); }
    catch (err) {
      if (attempt >= RETRIES) throw err;
      log(`  retry ${attempt + 1}/${RETRIES} ${von}..${bis}: ${err.message}`);
      await sleep(10_000 * (attempt + 1));
    }
  }
}

// A week that keeps failing is retried day by day — the feed is known to
// return 5xx for some large windows.
async function fetchWindow(von, bis) {
  try { return await fetchWithRetry(von, bis); }
  catch (err) {
    if (von === bis) throw err;
    log(`  splitting ${von}..${bis} into days after: ${err.message}`);
    const docs = [];
    for (let d = new Date(von); iso(d) <= bis; d = addDays(d, 1)) {
      docs.push(...await fetchWithRetry(iso(d), iso(d)));
    }
    return docs;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
migrate();
const db = getDb();

const today = new Date(`${iso(new Date())}T00:00:00Z`);
const to   = args.to   ? new Date(`${args.to}T00:00:00Z`)   : addDays(today, -1);
// Start on a Monday so the windows are whole ISO weeks and stay identical
// between runs (otherwise the rolling "24 months back" shifts them daily).
const from = mondayOf(args.from ? new Date(`${args.from}T00:00:00Z`)
  : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - Number(args.months || 24), to.getUTCDate())));

const insertDoc = db.prepare(`
  INSERT OR IGNORE INTO at_register_documents
    (doc_key, national_id_canon, doc_code, doc_text, vollzugsdatum, content_type)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const saveWindow = db.prepare(`
  INSERT INTO at_feed_windows (feed, von, bis, entries, complete) VALUES ('urkunde', ?, ?, ?, ?)
  ON CONFLICT(feed, von, bis) DO UPDATE SET
    entries = excluded.entries, complete = excluded.complete, fetched_at = datetime('now')
`);
const isDone = db.prepare(`SELECT 1 FROM at_feed_windows WHERE feed = 'urkunde' AND von = ? AND bis = ? AND complete = 1`);
const storeDocs = db.transaction((docs) => {
  let added = 0;
  for (const d of docs) {
    if (!d.nationalIdCanon || !d.vollzugsdatum) continue;
    added += insertDoc.run(d.key, d.nationalIdCanon, d.docCode, d.docText, d.vollzugsdatum, d.contentType).changes;
  }
  return added;
});

const windows = weeklyWindows(from, to);
const todo = windows.filter((w) => !isDone.get(w.von, w.bis));
log(`at-universe ${iso(from)}..${iso(to)}: ${windows.length} Wochen, ${todo.length} offen`);

let failed = 0;
for (const [i, w] of todo.entries()) {
  const t0 = Date.now();
  try {
    const docs = await fetchWindow(w.von, w.bis);
    const added = storeDocs(docs);
    saveWindow.run(w.von, w.bis, docs.length, w.complete ? 1 : 0);
    log(`[${i + 1}/${todo.length}] ${w.von}..${w.bis}  ${String(docs.length).padStart(6)} Dokumente  +${added} neu  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    failed++;
    log(`[${i + 1}/${todo.length}] ${w.von}..${w.bis}  FEHLER: ${err.message} — beim nächsten Lauf erneut`);
  }
}

const s = db.prepare(`
  SELECT COUNT(*) AS firms,
         SUM(prefilter_mittel_gross) AS prefilter,
         SUM(has_konzernabschluss) AS konzern,
         SUM(has_liquidationsschlussbilanz) AS liquidation,
         SUM(latest_jab_xml_key IS NOT NULL) AS with_xml
  FROM at_universe
`).get();
const docs = db.prepare('SELECT COUNT(*) AS n FROM at_register_documents').get().n;
log(`Fertig: ${docs} Dokumente, ${s.firms} Firmen mit Jahresabschluss — Vorfilter mittelgroß/groß: ${s.prefilter}, Konzernabschluss: ${s.konzern}, Liquidationsschlussbilanz: ${s.liquidation}, mit XML-Abschluss: ${s.with_xml}${failed ? ` — ${failed} Fenster fehlgeschlagen` : ''}`);
process.exit(failed ? 1 : 0);
