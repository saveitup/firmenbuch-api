// Investor screener over the AT universe (see plans/investor-screening.md).
// Reads what scripts/at-universe.mjs and scripts/at-jab-ingest.mjs stored:
// one row per ingested firm with its latest Jahresabschluss, the prior year
// for the EBITDA trend, the Kurzinformation profile and feed flags.
import { getDb } from './db/index.js';

// EBITDA bands of the MBI search mandate (V1.0, EBITDA ceiling raised to 5 Mio).
export const EBITDA_BANDS = {
  kern:      { label: 'Kern (EBITDA 1,5–5 Mio)',      min: 1_500_000, max: 5_000_000 },
  erweitert: { label: 'Erweitert (EBITDA 1–5 Mio)',   min: 1_000_000, max: 5_000_000 },
  alle:      { label: 'Alle geladenen Firmen',        min: null,      max: null },
};

const SORTS = {
  ebitda: 'ebitda', umsatz: 'umsatz_oder_roh', bilanzsumme: 'bilanzsumme',
  ek_quote: 'ek_quote', name: 'name', stichtag: 'stichtag', wachstum: 'ebitda_wachstum',
};

const BASE_SQL = `
  WITH ingested AS (
    SELECT DISTINCT national_id_canon FROM at_jab_ingest WHERE status = 'ok'
  ),
  ranked AS (
    SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.national_id_canon ORDER BY f.stichtag DESC) AS rn
    FROM financials_yearly f
    WHERE f.country = 'AT' AND f.national_id_canon IN (SELECT national_id_canon FROM ingested)
  ),
  rows AS (
    SELECT
      c.national_id_canon                               AS id,
      c.legal_name                                      AS name,
      c.address                                         AS address,
      c.legal_form_code                                 AS rechtsform,
      p.bundesland                                      AS bundesland,
      p.ort                                             AS ort,
      p.organe_json                                     AS organe_json,
      f.stichtag                                        AS stichtag,
      f.bilanzsumme                                     AS bilanzsumme,
      f.eigenkapital                                    AS eigenkapital,
      f.ek_quote                                        AS ek_quote,
      f.jahresergebnis                                  AS jahresergebnis,
      json_extract(f.guv_json, '$.umsatzerloese')       AS umsatz,
      json_extract(f.guv_json, '$.rohergebnis')         AS rohergebnis,
      COALESCE(json_extract(f.guv_json, '$.umsatzerloese'), json_extract(f.guv_json, '$.rohergebnis')) AS umsatz_oder_roh,
      json_extract(f.guv_json, '$.ebitda')              AS ebitda,
      json_extract(f.guv_json, '$.betriebserfolg')      AS ebit,
      json_extract(v.guv_json, '$.ebitda')              AS ebitda_vj,
      CASE WHEN json_extract(v.guv_json, '$.ebitda') > 0
           THEN json_extract(f.guv_json, '$.ebitda') * 1.0 / json_extract(v.guv_json, '$.ebitda') - 1 END AS ebitda_wachstum,
      c.legal_form_text                                 AS rechtsform_text,
      EXISTS (SELECT 1 FROM at_register_documents d WHERE d.national_id_canon = c.national_id_canon AND d.doc_code = '49')  AS konzern,
      EXISTS (SELECT 1 FROM at_register_documents d WHERE d.national_id_canon = c.national_id_canon AND d.doc_code = '136') AS liquidation
    FROM ranked f
    JOIN companies c ON c.country = 'AT' AND c.national_id_canon = f.national_id_canon
    LEFT JOIN ranked v ON v.national_id_canon = f.national_id_canon AND v.rn = 2
    LEFT JOIN at_company_profile p ON p.national_id_canon = f.national_id_canon
    WHERE f.rn = 1
  )
  SELECT * FROM rows
`;

/**
 * Filtered, sorted screener rows plus corpus counts.
 * params: { band, bundesland, konzern ('ohne'|'nur'), q, sort, dir, limit }
 */
export function screenAt(params = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  const band = EBITDA_BANDS[params.band] || EBITDA_BANDS.kern;
  if (band.min != null) { where.push('ebitda >= ?'); args.push(band.min); }
  if (band.max != null) { where.push('ebitda <= ?'); args.push(band.max); }
  if (params.bundesland) { where.push('bundesland = ?'); args.push(params.bundesland); }
  if (params.konzern === 'ohne') where.push('konzern = 0');
  if (params.konzern === 'nur') where.push('konzern = 1');
  if (params.q) { where.push('UPPER(name) LIKE ?'); args.push(`%${String(params.q).replace(/[%_]/g, '').toUpperCase()}%`); }
  // Default: only legal forms a majority takeover can target (no
  // Genossenschaft, Stiftung, Verein, Sparkasse, "sonstiger Rechtsträger").
  if (params.rechtsform !== 'alle') {
    where.push(`COALESCE(rechtsform, '') NOT IN ('GEN', 'SON')
      AND COALESCE(rechtsform_text, '') NOT LIKE '%genossenschaft%'
      AND COALESCE(rechtsform_text, '') NOT LIKE '%stiftung%'
      AND COALESCE(rechtsform_text, '') NOT LIKE '%verein%'
      AND COALESCE(rechtsform_text, '') NOT LIKE '%sparkasse%'`);
  }
  where.push('liquidation = 0');

  const sortCol = SORTS[params.sort] || 'ebitda';
  const dir = params.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(params.limit) || 500, 5000);
  const sql = `${BASE_SQL} WHERE ${where.join(' AND ')}
    ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, name ASC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...args).map(withOrgane);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${BASE_SQL} WHERE ${where.join(' AND ')})`).get(...args).n;
  return { band: params.band in EBITDA_BANDS ? params.band : 'kern', total, rows, meta: corpusMeta() };
}

// Organs as context only (the mandate: age is never a filter or exclusion).
function withOrgane(r) {
  let organe = [];
  try { organe = r.organe_json ? JSON.parse(r.organe_json) : []; } catch {}
  const gf = organe.filter((o) => o.roleCode === 'GF' || o.roleCode === 'VM' || o.roleCode === 'KP');
  const jahrgaenge = gf.map((o) => o.geburtsjahr).filter(Boolean);
  const { organe_json, ...rest } = r;
  return {
    ...rest,
    konzern: !!r.konzern,
    gfCount: gf.length,
    prokuraCount: organe.filter((o) => o.roleCode === 'PR').length,
    aeltesterGfJahrgang: jahrgaenge.length ? Math.min(...jahrgaenge) : null,
  };
}

// Corpus size changes only while an ingest runs; cache briefly.
let metaCache = { at: 0, value: null };
function corpusMeta() {
  if (Date.now() - metaCache.at < 60_000 && metaCache.value) return metaCache.value;
  const db = getDb();
  const one = (sql) => db.prepare(sql).get().n;
  const value = {
    universe:  one(`SELECT COUNT(DISTINCT national_id_canon) AS n FROM at_register_documents WHERE doc_code IN ('48', '137', '164')`),
    prefilter: one(`SELECT COUNT(DISTINCT national_id_canon) AS n FROM at_register_documents WHERE doc_code IN ('51', '27')`),
    ingested:  one(`SELECT COUNT(DISTINCT national_id_canon) AS n FROM at_jab_ingest WHERE status = 'ok'`),
    feedUntil: db.prepare(`SELECT MAX(bis) AS d FROM at_feed_windows`).get().d,
  };
  metaCache = { at: Date.now(), value };
  return value;
}

const CSV_COLUMNS = [
  ['id', 'FN'], ['name', 'Firma'], ['address', 'Adresse'], ['bundesland', 'Bundesland'], ['rechtsform', 'Rechtsform'],
  ['stichtag', 'Stichtag'], ['umsatz', 'Umsatz'], ['rohergebnis', 'Rohergebnis'], ['ebitda', 'EBITDA'],
  ['ebitda_vj', 'EBITDA Vorjahr'], ['ebit', 'Betriebserfolg'], ['jahresergebnis', 'Jahresergebnis'],
  ['bilanzsumme', 'Bilanzsumme'], ['eigenkapital', 'Eigenkapital'], ['ek_quote', 'EK-Quote'],
  ['konzern', 'Konzernabschluss'], ['gfCount', 'GF'], ['prokuraCount', 'Prokura'],
];

export function toCsv(rows) {
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([, h]) => h).join(';')];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([k]) => cell(r[k])).join(';'));
  return '﻿' + lines.join('\n'); // BOM + ";" so Excel (de-AT) opens it directly
}
