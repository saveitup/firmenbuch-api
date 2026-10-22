#!/usr/bin/env node
// Computes cash flows (analytics/cashflow.js) for every firm loaded by
// scripts/at-jab-ingest.mjs, straight from the stored XML so that year t and
// t−1 come from the same filing. No IWG calls; safe to re-run after any
// parser or formula change.
//
// Usage: npm run compute:at-cashflow

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { migrate, getDb } from '../server/db/index.js';
import { parseJAb } from '../server/jab-parser.js';
import { computeCashflow } from '../server/analytics/cashflow.js';

const RAW_DIR = 'data/at-jab-xml';

migrate();
const db = getDb();

const docs = db.prepare(`SELECT national_id_canon AS canon, doc_key AS docKey FROM at_jab_ingest WHERE status = 'ok'`).all();
const upsert = db.prepare(`
  INSERT INTO cashflow_yearly (country, national_id_canon, stichtag, prior_stichtag, source_ref, tier,
    jahresueberschuss, abschreibungen, ebitda, delta_rueckstellungen, delta_nwc, cfo, capex, growth_capex,
    fcf, fcf_operativ, cash_conversion, net_debt, net_debt_ebitda, konzernsaldo, ausschuettung_netto,
    finanzinvestitionen, residual, quality, warnings_json)
  VALUES ('AT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(country, national_id_canon, stichtag) DO UPDATE SET
    prior_stichtag = excluded.prior_stichtag, source_ref = excluded.source_ref, tier = excluded.tier,
    jahresueberschuss = excluded.jahresueberschuss, abschreibungen = excluded.abschreibungen,
    ebitda = excluded.ebitda, delta_rueckstellungen = excluded.delta_rueckstellungen,
    delta_nwc = excluded.delta_nwc, cfo = excluded.cfo, capex = excluded.capex,
    growth_capex = excluded.growth_capex, fcf = excluded.fcf, fcf_operativ = excluded.fcf_operativ,
    cash_conversion = excluded.cash_conversion, net_debt = excluded.net_debt,
    net_debt_ebitda = excluded.net_debt_ebitda, konzernsaldo = excluded.konzernsaldo,
    ausschuettung_netto = excluded.ausschuettung_netto, finanzinvestitionen = excluded.finanzinvestitionen,
    residual = excluded.residual, quality = excluded.quality, warnings_json = excluded.warnings_json,
    computed_at = datetime('now')
`);

const counts = { ok: 0, pruefen: 0, ohne: 0, fehlt: 0 };
const store = db.transaction((rows) => {
  for (const [canon, docKey, cf] of rows) {
    upsert.run(canon, cf.stichtag, cf.priorStichtag, docKey, cf.tier, cf.jahresueberschuss, cf.abschreibungen,
      cf.ebitda, cf.deltaRueckstellungen, cf.deltaNwc, cf.cfo, cf.capex, cf.growthCapex, cf.fcf, cf.fcfOperativ,
      cf.cashConversion, cf.netDebt, cf.netDebtEbitda, cf.konzernsaldo, cf.ausschuettungNetto,
      cf.finanzinvestitionen, cf.residual, cf.quality, JSON.stringify(cf.warnings));
  }
});

const batch = [];
for (const { canon, docKey } of docs) {
  const file = path.join(RAW_DIR, `${docKey}.xml.gz`);
  if (!existsSync(file)) { counts.fehlt++; continue; }
  const row = parseJAb(zlib.gunzipSync(readFileSync(file)).toString('utf8'));
  const cf = row && computeCashflow(row, row.priorYear);
  if (!cf) { counts.ohne++; continue; }
  counts[cf.quality === 'ok' ? 'ok' : 'pruefen']++;
  batch.push([canon, docKey, cf]);
}
store(batch);
console.log(`at-cashflow: ${batch.length} Firmen berechnet (Gegenprobe ok: ${counts.ok}, prüfen: ${counts.pruefen}), `
  + `ohne Vorjahr/Daten: ${counts.ohne}, XML fehlt: ${counts.fehlt}`);
