#!/usr/bin/env node
// Computes cash flows (analytics/cashflow.js) for every firm loaded by
// scripts/at-jab-ingest.mjs, straight from the stored XML: one year per
// filing (balance sheet + Vorjahr column of the same document), plus years
// bridged between two filings, plus a multi-year summary (cashflow_summary).
// No IWG calls; safe to re-run after any parser or formula change.
//
// Usage: npm run compute:at-cashflow

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { migrate, getDb } from '../server/db/index.js';
import { parseJAb } from '../server/jab-parser.js';
import { cashflowSeries, summarizeCashflows } from '../server/analytics/cashflow.js';

const RAW_DIR = 'data/at-jab-xml';

migrate();
const db = getDb();

const docs = db.prepare(`SELECT national_id_canon AS canon, doc_key AS docKey FROM at_jab_ingest WHERE status = 'ok'`).all();
const byFirm = new Map();
for (const d of docs) byFirm.set(d.canon, [...(byFirm.get(d.canon) || []), d.docKey]);

const upsertYear = db.prepare(`
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
const insertSummary = db.prepare(`
  INSERT INTO cashflow_summary (country, national_id_canon, years, von_stichtag, bis_stichtag,
    fcf_operativ_median, cash_conversion_median, cash_conversion_kumuliert, fcf_positiv_jahre,
    ebitda_median, jahre_json)
  VALUES ('AT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const store = db.transaction((firms) => {
  db.prepare(`DELETE FROM cashflow_summary WHERE country = 'AT'`).run();
  for (const { canon, series, summary } of firms) {
    for (const cf of series) {
      upsertYear.run(canon, cf.stichtag, cf.priorStichtag, cf.sourceRef, cf.tier, cf.jahresueberschuss,
        cf.abschreibungen, cf.ebitda, cf.deltaRueckstellungen, cf.deltaNwc, cf.cfo, cf.capex, cf.growthCapex,
        cf.fcf, cf.fcfOperativ, cf.cashConversion, cf.netDebt, cf.netDebtEbitda, cf.konzernsaldo,
        cf.ausschuettungNetto, cf.finanzinvestitionen, cf.residual, cf.quality, JSON.stringify(cf.warnings));
    }
    if (summary) {
      insertSummary.run(canon, summary.years, summary.vonStichtag, summary.bisStichtag, summary.fcfOperativMedian,
        summary.cashConversionMedian, summary.cashConversionKumuliert, summary.fcfPositivJahre,
        summary.ebitdaMedian, JSON.stringify(summary.jahre));
    }
  }
});

const firms = [];
const yearsHist = { 0: 0, 1: 0, 2: 0, 3: 0 };
let flows = 0, bridged = 0;
for (const [canon, keys] of byFirm) {
  const filings = keys
    .map((docKey) => ({ docKey, file: path.join(RAW_DIR, `${docKey}.xml.gz`) }))
    .filter((f) => existsSync(f.file))
    .map(({ docKey, file }) => ({ docKey, row: parseJAb(zlib.gunzipSync(readFileSync(file)).toString('utf8')) }));
  const series = cashflowSeries(filings);
  const summary = summarizeCashflows(series);
  flows += series.length;
  bridged += series.filter((cf) => cf.sourceRef.includes('+')).length;
  yearsHist[summary?.years ?? 0]++;
  firms.push({ canon, series, summary });
}
store(firms);
console.log(`at-cashflow: ${firms.length} Firmen, ${flows} Cashflow-Jahre (davon ${bridged} über zwei Abschlüsse) — `
  + `belastbare Jahre je Firma: 3J ${yearsHist[3]}, 2J ${yearsHist[2]}, 1J ${yearsHist[1]}, keins ${yearsHist[0]}`);
