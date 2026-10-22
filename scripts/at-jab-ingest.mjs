#!/usr/bin/env node
// AT Jahresabschluss ingest — for each firm in `at_universe` (default: the
// mittelgroß/groß prefilter) loads
//   1. the AUSZUG Kurzinformation → companies (name, address, Rechtsform)
//      + at_company_profile (Bundesland, Geschäftszweig, organs)
//   2. the latest Jahresabschluss XML → financials_yearly (Bilanz, GuV with
//      EBITDA, prior year via the Vorjahr column)
// and keeps the XML (embedded attachments stripped) gzipped under
// data/at-jab-xml/ so later parser changes need no new IWG calls.
//
// Usage:
//   npm run ingest:at-jab                         # prefilter firms not yet ingested
//   npm run ingest:at-jab -- --limit=20
//   npm run ingest:at-jab -- --scope=all          # every firm in the universe
//   npm run ingest:at-jab -- --retry-errors
//   npm run ingest:at-jab -- --restrip            # re-strip stored XMLs, no IWG calls
//   npm run ingest:at-jab -- --reparse            # re-parse stored XMLs into the DB, no IWG calls
//
// Run scripts/at-universe.mjs first. Idempotent: processed documents are
// recorded in at_jab_ingest and skipped on re-runs.

import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { migrate, getDb } from '../server/db/index.js';
import { upsertCompany, upsertFinancials } from '../server/normalize.js';
import { parseJAb } from '../server/jab-parser.js';
import { makeDTO } from '../server/adapters/base.js';
import at from '../server/adapters/at.js';

const LOG_DIR  = 'logs';
const LOG_PATH = `${LOG_DIR}/at-jab-ingest.log`;
const RAW_DIR  = 'data/at-jab-xml';
// Text nodes above this size are embedded attachments (base64 Anhang PDFs,
// up to 7 MB) — dropped from the stored copy, they can be refetched.
const MAX_TEXT_NODE = 100_000;
for (const dir of [LOG_DIR, RAW_DIR]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const CONCURRENCY = Number(args.concurrency || 3);

function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.log(stamped);
  appendFileSync(LOG_PATH, `${stamped}\n`);
}

// Scan instead of a regex — a single 7 MB text node overflows the regex stack.
// Attachments come either as plain text nodes (v4) or as CDATA sections
// (BMF: Anhang and Lagebericht as base64 PDF under VERMERKE).
const removed = (n) => `[kontur: ${n} Zeichen entfernt]`;
function stripLargeText(xml) {
  const out = [];
  for (let i = 0; i < xml.length;) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    out.push(text.length > MAX_TEXT_NODE ? removed(text.length) : text);
    if (lt === -1) break;
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      const stop = end === -1 ? xml.length : end + 3;
      out.push(stop - lt > MAX_TEXT_NODE ? `<![CDATA[${removed(stop - lt)}]]>` : xml.slice(lt, stop));
      i = stop;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) { out.push(xml.slice(lt)); break; }
    out.push(xml.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out.join('');
}

// `--restrip`: re-apply stripLargeText to the stored copies (no IWG calls).
if (args.restrip) {
  let before = 0, after = 0, changed = 0;
  for (const f of readdirSync(RAW_DIR).filter((x) => x.endsWith('.xml.gz'))) {
    const file = path.join(RAW_DIR, f);
    const gz = readFileSync(file);
    const xml = zlib.gunzipSync(gz).toString('utf8');
    const stripped = stripLargeText(xml);
    before += gz.length;
    if (stripped.length === xml.length) { after += gz.length; continue; }
    const out = zlib.gzipSync(stripped);
    writeFileSync(file, out);
    after += out.length;
    changed++;
  }
  log(`restrip: ${changed} Dateien gekürzt, ${(before / 1048576).toFixed(0)} MB → ${(after / 1048576).toFixed(0)} MB`);
  process.exit(0);
}

// ─── Main ───────────────────────────────────────────────────────────────
migrate();
const db = getDb();

// `--reparse`: apply parser changes to everything already loaded. Prior-year
// rows derived from these filings ("#VJ") are rebuilt; a firm's own filing
// for that year is never touched.
if (args.reparse) {
  const docs = db.prepare(`SELECT national_id_canon AS canon, doc_key AS docKey FROM at_jab_ingest WHERE status = 'ok'`).all();
  const dropVj = db.prepare(`DELETE FROM financials_yearly WHERE country = 'AT' AND national_id_canon = ? AND source_ref = ?`);
  const reparse = db.transaction((items) => {
    let n = 0;
    for (const { canon, docKey, row } of items) {
      dropVj.run(canon, `${docKey}#VJ`);
      upsertFinancials('AT', canon, [{ ...row, source_ref: docKey }]);
      n++;
    }
    return n;
  });
  const items = [];
  for (const { canon, docKey } of docs) {
    const file = path.join(RAW_DIR, `${docKey}.xml.gz`);
    if (!existsSync(file)) continue;
    const row = parseJAb(zlib.gunzipSync(readFileSync(file)).toString('utf8'));
    if (row) items.push({ canon, docKey, row });
  }
  log(`reparse: ${reparse(items)} von ${docs.length} Abschlüssen neu eingelesen`);
  process.exit(0);
}

const todo = db.prepare(`
  SELECT u.national_id_canon AS canon, u.latest_jab_xml_key AS docKey
  FROM at_universe u
  WHERE u.latest_jab_xml_key IS NOT NULL
    ${args.scope === 'all' ? '' : 'AND u.prefilter_mittel_gross = 1'}
    AND NOT EXISTS (
      SELECT 1 FROM at_jab_ingest i
      WHERE i.doc_key = u.latest_jab_xml_key ${args['retry-errors'] ? "AND i.status <> 'error'" : ''}
    )
  ORDER BY u.last_jab_at DESC
  ${args.limit ? `LIMIT ${Number(args.limit)}` : ''}
`).all();

const recordStatus = db.prepare(`
  INSERT INTO at_jab_ingest (doc_key, national_id_canon, status, error) VALUES (?, ?, ?, ?)
  ON CONFLICT(doc_key) DO UPDATE SET status = excluded.status, error = excluded.error, ingested_at = datetime('now')
`);
const upsertProfile = db.prepare(`
  INSERT INTO at_company_profile (national_id_canon, plz, ort, bundesland, gemeindekennziffer,
    geschaeftszweig, homepage, rechtsform, ersterfassung, organe_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(national_id_canon) DO UPDATE SET
    plz = excluded.plz, ort = excluded.ort, bundesland = excluded.bundesland,
    gemeindekennziffer = excluded.gemeindekennziffer, geschaeftszweig = excluded.geschaeftszweig,
    homepage = excluded.homepage, rechtsform = excluded.rechtsform, ersterfassung = excluded.ersterfassung,
    organe_json = excluded.organe_json, updated_at = datetime('now')
`);

const persist = db.transaction((canon, docKey, dto, kurz, row) => {
  upsertCompany(dto); // first — financials_yearly references companies
  upsertFinancials('AT', canon, [{ ...row, source_ref: docKey }]);
  if (kurz) {
    upsertProfile.run(canon, kurz.address?.plz, kurz.address?.ort, kurz.bundesland, kurz.gemeindekennziffer,
      kurz.geschaeftszweig, kurz.homepage, kurz.legalFormCode, kurz.ersterfassung, JSON.stringify(kurz.organe));
  }
  recordStatus.run(docKey, canon, 'ok', kurz ? null : 'ohne Kurzinformation');
});

async function ingestOne({ canon, docKey }) {
  // One AUSZUG call: getCompany and getKurzinformation share the request.
  const [dto, kurz] = await Promise.all([
    at.getCompany(canon).catch(() => null),
    at.getKurzinformation(canon).catch(() => null),
  ]);
  const doc = await at.downloadDocument(docKey);
  if (!doc) {
    recordStatus.run(docKey, canon, 'no-data', 'leeres Dokument');
    return 'no-data';
  }
  const xml = doc.bytes.toString('utf8');
  const row = parseJAb(xml);
  if (!row) {
    recordStatus.run(docKey, canon, 'no-data', 'nicht parsebar');
    return 'no-data';
  }
  writeFileSync(path.join(RAW_DIR, `${docKey}.xml.gz`), zlib.gzipSync(stripLargeText(xml)));
  persist(canon, docKey, dto || makeDTO('AT', {
    nationalId: canon,
    legalName: row.filing?.firmenwortlaut,
    legalFormCode: row.filing?.rechtsform,
    status: 'active',
    source: 'at-jab',
  }), kurz, row);
  return 'ok';
}

log(`at-jab-ingest: ${todo.length} Firmen offen (scope=${args.scope || 'prefilter'}, concurrency=${CONCURRENCY})`);
const counts = { ok: 0, 'no-data': 0, error: 0 };
const t0 = Date.now();
let next = 0;
async function worker() {
  while (next < todo.length) {
    const item = todo[next++];
    try {
      counts[await ingestOne(item)]++;
    } catch (err) {
      counts.error++;
      recordStatus.run(item.docKey, item.canon, 'error', String(err.message).slice(0, 300));
    }
    const done = counts.ok + counts['no-data'] + counts.error;
    if (done % 25 === 0 || done === todo.length) {
      const perMin = done / ((Date.now() - t0) / 60_000);
      const eta = perMin ? Math.round((todo.length - done) / perMin) : '?';
      log(`[${done}/${todo.length}] ok=${counts.ok} no-data=${counts['no-data']} error=${counts.error}  ${perMin.toFixed(0)}/min  ETA ${eta} min`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
log(`Fertig: ok=${counts.ok} no-data=${counts['no-data']} error=${counts.error}`);
process.exit(counts.error ? 1 : 0);
