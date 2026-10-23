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
  fcf: 'fcf_operativ', cash_conversion: 'cash_conversion', net_debt_ebitda: 'net_debt_ebitda', cluster: 'cluster',
};

// A net group/shareholder balance above this share of the Bilanzsumme
// (cash pooling, group loans) marks a firm as part of a group even without
// a Konzernabschluss of its own.
const VERFLECHTUNG_QUOTE = 0.2;

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
      cf.fcf                                            AS fcf,
      -- Screen values: median over the usable years (up to three) where the
      -- summary exists, else the latest single year.
      COALESCE(s.fcf_operativ_median, cf.fcf_operativ)  AS fcf_operativ,
      cf.fcf_operativ                                   AS fcf_operativ_1j,
      COALESCE(s.years, 0)                              AS cf_years,
      s.fcf_positiv_jahre                               AS fcf_positiv_jahre,
      s.cash_conversion_kumuliert                       AS cash_conversion_kumuliert,
      s.jahre_json                                      AS cf_jahre_json,
      -- Result driven by dividends/interest rather than operations.
      CASE WHEN json_extract(f.guv_json, '$.finanzerfolg') > MAX(COALESCE(json_extract(f.guv_json, '$.betriebserfolg'), 0), 0)
           THEN 1 ELSE 0 END                            AS holding,
      cf.cfo                                            AS cfo,
      cf.capex                                          AS capex,
      COALESCE(s.cash_conversion_median, cf.cash_conversion) AS cash_conversion,
      cf.cash_conversion                                AS cash_conversion_1j,
      cf.net_debt                                       AS net_debt,
      cf.net_debt_ebitda                                AS net_debt_ebitda,
      cf.konzernsaldo                                   AS konzernsaldo,
      cf.quality                                        AS cf_quality,
      cf.warnings_json                                  AS cf_warnings_json,
      CASE WHEN f.bilanzsumme > 0 AND ABS(cf.konzernsaldo) > ${VERFLECHTUNG_QUOTE} * f.bilanzsumme THEN 1 ELSE 0 END AS verflechtung,
      COALESCE(k.cluster, 'U')                          AS cluster,
      k.segment                                         AS cluster_segment,
      k.confidence                                      AS cluster_confidence,
      k.basis_json                                      AS cluster_basis_json,
      w.status                                          AS website_status,
      w.domain                                          AS website_domain,
      w.url                                             AS website_url,
      w.impressum_url                                   AS impressum_url,
      w.evidence                                        AS website_evidence,
      w.other_fns_json                                  AS website_other_json,
      EXISTS (SELECT 1 FROM at_register_documents d WHERE d.national_id_canon = c.national_id_canon AND d.doc_code = '49')  AS konzern,
      EXISTS (SELECT 1 FROM at_register_documents d WHERE d.national_id_canon = c.national_id_canon AND d.doc_code = '136') AS liquidation
    FROM ranked f
    JOIN companies c ON c.country = 'AT' AND c.national_id_canon = f.national_id_canon
    LEFT JOIN ranked v ON v.national_id_canon = f.national_id_canon AND v.rn = 2
    LEFT JOIN at_company_profile p ON p.national_id_canon = f.national_id_canon
    LEFT JOIN cashflow_yearly cf ON cf.country = 'AT' AND cf.national_id_canon = f.national_id_canon AND cf.stichtag = f.stichtag
    LEFT JOIN cashflow_summary s ON s.country = 'AT' AND s.national_id_canon = f.national_id_canon
    LEFT JOIN at_cluster k ON k.national_id_canon = f.national_id_canon
    LEFT JOIN at_website w ON w.national_id_canon = f.national_id_canon
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
  // "unabhängig": no Konzernabschluss, no large group balance, not a holding.
  if (params.konzern === 'unabhaengig') where.push('konzern = 0 AND verflechtung = 0 AND holding = 0');
  if (params.konzern === 'nur') where.push('konzern = 1');
  // Cash filters only trust years whose financing-side cross-check closes
  // (cf_years counts exactly those).
  if (params.cash === 'fcf') where.push('cf_years >= 1 AND fcf_operativ > 0');
  if (params.cash === 'cc50') where.push('cf_years >= 1 AND cash_conversion >= 0.5');
  if (params.cash === 'stetig') where.push('cf_years >= 2 AND fcf_positiv_jahre = cf_years');
  // Cluster: one code, a group (A = A1–A3, B = B1–B3, AB = all mandate
  // clusters), or X / U.
  const CLUSTER_GROUPS = { A: ['A1', 'A2', 'A3'], B: ['B1', 'B2', 'B3'], AB: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'] };
  const clusterCodes = CLUSTER_GROUPS[params.cluster] || (/^(A[123]|B[123]|X|U)$/.test(params.cluster || '') ? [params.cluster] : null);
  if (clusterCodes) where.push(`cluster IN (${clusterCodes.map((c) => `'${c}'`).join(', ')})`);
  // Website (Phase 5): verified by FN, found (FN, group site, Name + PLZ),
  // checked without result, or not checked yet.
  if (params.website === 'fn') where.push(`website_status = 'fn'`);
  if (params.website === 'gefunden') where.push(`website_status IN ('fn', 'gruppe', 'name_plz')`);
  if (params.website === 'ohne') where.push(`website_status IN ('nicht_gefunden', 'andere_fn', 'blockiert', 'fehler')`);
  if (params.website === 'offen') where.push('website_status IS NULL');
  if (params.verschuldung === 'nettocash') where.push('net_debt <= 0');
  if (params.verschuldung === 'max1') where.push('net_debt_ebitda <= 1');
  if (params.verschuldung === 'max2') where.push('net_debt_ebitda <= 2');
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
  // Single-year conversion above 150 % comes from releasing working capital;
  // cap it for sorting so one-off effects do not lead the list.
  const sortExpr = sortCol === 'cash_conversion' ? 'MIN(cash_conversion, 1.5)' : sortCol;
  const sql = `${BASE_SQL} WHERE ${where.join(' AND ')}
    ORDER BY ${sortCol} IS NULL, ${sortExpr} ${dir}, ebitda DESC, name ASC LIMIT ${limit}`;
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
  let cfWarnings = [], cfJahre = [], clusterBasis = [], websiteOther = [];
  try { cfWarnings = r.cf_warnings_json ? JSON.parse(r.cf_warnings_json) : []; } catch {}
  try { cfJahre = r.cf_jahre_json ? JSON.parse(r.cf_jahre_json) : []; } catch {}
  try { clusterBasis = r.cluster_basis_json ? JSON.parse(r.cluster_basis_json) : []; } catch {}
  try { websiteOther = r.website_other_json ? JSON.parse(r.website_other_json) : []; } catch {}
  const { organe_json, cf_warnings_json, cf_jahre_json, cluster_basis_json, website_other_json, ...rest } = r;
  return {
    ...rest,
    konzern: !!r.konzern,
    verflechtung: !!r.verflechtung,
    holding: !!r.holding,
    cfWarnings,
    cfJahre,
    clusterBasis,
    websiteOther,
    // Another FN on the site that belongs to a related firm: the website is
    // the group's (often a family holding — context, not an exclusion).
    websiteGruppe: websiteOther.filter((o) => o.related).map((o) => `FN ${o.fn} ${o.name || ''}`.trim()).join(' · ') || null,
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
  ['cluster', 'Cluster'], ['cluster_segment', 'Segment'], ['cluster_confidence', 'Cluster-Konfidenz'],
  ['website_url', 'Website'], ['website_status', 'Website-Abgleich'], ['impressum_url', 'Impressum'],
  ['websiteGruppe', 'Website nennt (Gruppe)'],
  ['stichtag', 'Stichtag'], ['umsatz', 'Umsatz'], ['rohergebnis', 'Rohergebnis'], ['ebitda', 'EBITDA'],
  ['ebitda_vj', 'EBITDA Vorjahr'], ['ebit', 'Betriebserfolg'], ['jahresergebnis', 'Jahresergebnis'],
  ['bilanzsumme', 'Bilanzsumme'], ['eigenkapital', 'Eigenkapital'], ['ek_quote', 'EK-Quote'],
  ['cf_years', 'Cashflow-Jahre'], ['fcf_operativ', 'FCF operativ (Median)'], ['cash_conversion', 'Cash Conversion (Median)'],
  ['cash_conversion_kumuliert', 'Cash Conversion kumuliert'], ['fcf_positiv_jahre', 'Jahre FCF positiv'],
  ['cfo', 'Operativer Cashflow (letztes GJ)'], ['capex', 'CapEx (letztes GJ)'], ['fcf_operativ_1j', 'FCF operativ (letztes GJ)'],
  ['cash_conversion_1j', 'Cash Conversion (letztes GJ)'], ['fcf', 'FCF gesamt (letztes GJ)'],
  ['net_debt', 'Net Debt'], ['net_debt_ebitda', 'Net Debt / EBITDA'],
  ['konzernsaldo', 'Konzernsaldo'], ['cf_quality', 'Cashflow-Gegenprobe'],
  ['konzern', 'Konzernabschluss'], ['verflechtung', 'Konzernbezug'], ['holding', 'Holding?'],
  ['gfCount', 'GF'], ['prokuraCount', 'Prokura'],
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
