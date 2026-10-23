#!/usr/bin/env node
// Assigns the mandate's business-model clusters (analytics/cluster.js) to
// every firm loaded by scripts/at-jab-ingest.mjs — from Geschäftszweig,
// Firmenwortlaut and the latest Jahresabschluss. No IWG calls. Manual
// overrides (at_cluster.method = 'manuell') are left untouched.
//
// Usage: npm run classify:at

import { migrate, getDb } from '../server/db/index.js';
import { classifyCluster, CLUSTERS } from '../server/analytics/cluster.js';

migrate();
const db = getDb();

const firms = db.prepare(`
  WITH latest AS (
    SELECT f.national_id_canon, f.balance_json, f.guv_json,
           ROW_NUMBER() OVER (PARTITION BY f.national_id_canon ORDER BY f.stichtag DESC) AS rn
    FROM financials_yearly f
    WHERE f.country = 'AT'
      AND f.source_ref IN (SELECT doc_key FROM at_jab_ingest WHERE status = 'ok' AND role = 'latest')
  )
  SELECT l.national_id_canon AS canon, c.legal_name AS name, p.geschaeftszweig, l.balance_json, l.guv_json
  FROM latest l
  JOIN companies c ON c.country = 'AT' AND c.national_id_canon = l.national_id_canon
  LEFT JOIN at_company_profile p ON p.national_id_canon = l.national_id_canon
  WHERE l.rn = 1
`).all();

const upsert = db.prepare(`
  INSERT INTO at_cluster (national_id_canon, cluster, segment, confidence, basis_json, method)
  VALUES (?, ?, ?, ?, ?, 'regeln')
  ON CONFLICT(national_id_canon) DO UPDATE SET
    cluster = excluded.cluster, segment = excluded.segment, confidence = excluded.confidence,
    basis_json = excluded.basis_json, method = excluded.method, updated_at = datetime('now')
  WHERE at_cluster.method <> 'manuell'
`);

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const counts = {};
db.transaction(() => {
  for (const f of firms) {
    const r = classifyCluster({
      name: f.name,
      geschaeftszweig: f.geschaeftszweig,
      row: { balanceSheet: parse(f.balance_json), guv: parse(f.guv_json) },
    });
    upsert.run(f.canon, r.cluster, r.segment, r.confidence, JSON.stringify(r.basis));
    const k = `${r.cluster}|${r.confidence}`;
    counts[k] = (counts[k] || 0) + 1;
  }
})();

console.log(`classify:at — ${firms.length} Firmen`);
for (const code of Object.keys(CLUSTERS)) {
  const by = ['hoch', 'mittel', 'niedrig'].map((c) => counts[`${code}|${c}`] || 0);
  const total = by.reduce((s, n) => s + n, 0);
  if (total) console.log(`  ${code.padEnd(2)} ${CLUSTERS[code].padEnd(34)} ${String(total).padStart(5)}  (hoch ${by[0]}, mittel ${by[1]}, niedrig ${by[2]})`);
}
