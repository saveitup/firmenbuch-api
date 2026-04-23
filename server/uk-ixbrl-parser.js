// Parser for UK iXBRL account filings as published in the Companies House
// free bulk accounts data product (Accounts_Bulk_Data-YYYY-MM-DD.zip). Each
// electronic filing in the ZIP is a standalone iXBRL HTML document that
// tags every numeric fact with a taxonomy `name` and a `contextRef`.
//
// Why this exists alongside uk-bilanz-parser: the PDF parser has to fight
// scanned annual-report layouts and OCR noise. This one reads the exact
// numbers the filer submitted, with correct sign and magnitude. For the
// ~65 % of UK accounts filed electronically this gives perfect KPI
// extraction without OCR.
//
// Input: the iXBRL HTML as a string or Buffer.
// Output: a list of KPI rows (one per distinct fiscal-year context),
// matching the contract of adapter.getFinancials().

const CONTEXT_RE = /<xbrli:context\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g;
const PERIOD_START_RE = /<xbrli:startDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:startDate>/;
const PERIOD_END_RE   = /<xbrli:endDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:endDate>/;
const INSTANT_RE      = /<xbrli:instant>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:instant>/;
// `ix:nonFraction` wraps a numeric value. Attributes we care about:
//   contextRef — period reference
//   name       — taxonomy-qualified fact name (e.g. core:Equity)
//   scale      — power-of-ten multiplier (scale="3" → × 1 000)
//   sign       — optional "-" for negatives
// Body is the display text in whatever format the filer chose; we strip
// thousands separators and read it as a number. Decimals handled via the
// `scale` attribute, not by parsing decimal digits — scale="-3" means
// value is in thousands, so 12 → 12 000.
const NON_FRACTION_RE = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g;

// Mapping of FRC Core 2024/2025 taxonomy tags to our KPI fields. Listed in
// order of preference — first match wins. FRC taxonomies change yearly but
// core-namespace tag names are stable across versions.
const TAG_TO_KPI = {
  // Revenue — filer picks one depending on profit-and-loss statement format
  'core:TurnoverRevenue':            'umsatzerloese',
  'core:Revenue':                    'umsatzerloese',
  'core:IncomeRevenue':              'umsatzerloese',

  // Profit for the year (IFRS + UK GAAP)
  'core:ProfitLoss':                 'jahresergebnis',
  'core:ProfitLossBeforeTax':        'betriebsergebnis',            // fallback
  'core:ProfitLossOnOrdinaryActivitiesBeforeTax': 'betriebsergebnis',

  // Equity / Net assets — both are valid "Eigenkapital" anchors;
  // we prefer Equity if present, else NetAssetsLiabilities.
  'core:Equity':                     'eigenkapital',
  'core:NetAssetsLiabilities':       'eigenkapital',

  // No direct "Total assets" tag in FRC core; we compute it below from
  // FixedAssets + CurrentAssets. These are tracked so the computation has
  // both operands available.
  'core:FixedAssets':                '_fixedAssets',
  'core:CurrentAssets':              '_currentAssets',
};

const ATTR_RE = /(\w+)(?::\w+)?="([^"]*)"/g;
function parseAttrs(chunk) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(chunk)) !== null) out[m[1]] = m[2];
  return out;
}

function parseNumericBody(raw) {
  if (raw == null) return null;
  // The display text may contain markup (e.g. <span>12</span>,<span>345</span>
  // for styled thousand separators) — strip tags first, then digits + sign.
  const text = String(raw).replace(/<[^>]+>/g, '').trim();
  if (!text) return null;
  const neg = /^\(.*\)$/.test(text);
  const stripped = text.replace(/[(),]/g, '').replace(/[^0-9.\-]/g, '');
  if (!stripped) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseContexts(html) {
  const map = new Map();  // id → { start, end }
  let m;
  CONTEXT_RE.lastIndex = 0;
  while ((m = CONTEXT_RE.exec(html)) !== null) {
    const [, id, body] = m;
    const start = body.match(PERIOD_START_RE)?.[1] || null;
    const end   = body.match(PERIOD_END_RE)?.[1] || body.match(INSTANT_RE)?.[1] || null;
    if (end) map.set(id, { start, end });
  }
  return map;
}

/**
 * Parse a single iXBRL accounts HTML document.
 *
 * @param {Buffer|string} src
 * @param {{companyNumber?: string, filename?: string}} meta
 * @returns {Array<object>} One KPI row per distinct fiscal period.
 */
export function parseUkIxbrl(src, meta = {}) {
  const html = Buffer.isBuffer(src) ? src.toString('utf8') : String(src || '');
  if (!html || !html.includes('<ix:nonFraction')) return [];
  const contexts = parseContexts(html);
  if (!contexts.size) return [];

  // facts[contextId] = { kpiField: value }
  const facts = new Map();
  let m;
  NON_FRACTION_RE.lastIndex = 0;
  while ((m = NON_FRACTION_RE.exec(html)) !== null) {
    const [, attrChunk, body] = m;
    const a = parseAttrs(attrChunk);
    const ctx = a.contextRef;
    const name = a.name;
    if (!ctx || !name) continue;
    const target = TAG_TO_KPI[name];
    if (!target) continue;
    const base = parseNumericBody(body);
    if (base == null) continue;
    const scale = Number(a.scale ?? 0) || 0;
    let v = base * Math.pow(10, scale);
    if (a.sign === '-') v = -Math.abs(v);
    const row = facts.get(ctx) || {};
    // Keep the highest-priority tag per field. TAG_TO_KPI iteration order
    // is preserved, so first-seen wins unless we'd overwrite with the
    // same target — simplest path is "do not overwrite" since the map
    // already lists the preferred variants first.
    if (!(target in row)) row[target] = v;
    facts.set(ctx, row);
  }

  // Emit one row per unique (end-date) context. Companies file comparative
  // figures — we keep both current and prior period.
  const byEndDate = new Map();
  for (const [ctxId, row] of facts.entries()) {
    const period = contexts.get(ctxId);
    if (!period?.end) continue;
    const stichtag = period.end;
    const existing = byEndDate.get(stichtag);
    const merged = existing || {};
    for (const [k, v] of Object.entries(row)) {
      if (merged[k] == null) merged[k] = v;
    }
    byEndDate.set(stichtag, merged);
  }

  const out = [];
  for (const [stichtag, r] of byEndDate.entries()) {
    const bilanzsumme = (r._fixedAssets != null && r._currentAssets != null)
      ? r._fixedAssets + r._currentAssets
      : null;
    const kpi = {
      stichtag,
      currency: 'GBP',
      umsatzerloese:    r.umsatzerloese    ?? null,
      bilanzsumme,
      eigenkapital:     r.eigenkapital     ?? null,
      jahresergebnis:   r.jahresergebnis   ?? null,
      betriebsergebnis: r.betriebsergebnis ?? null,
      arbeitnehmer: null,
      ek_quote: (bilanzsumme && r.eigenkapital != null) ? r.eigenkapital / bilanzsumme : null,
      source_ref: meta.filename || null,
      source: 'ixbrl-uk',
    };
    const filled = [kpi.umsatzerloese, kpi.bilanzsumme, kpi.eigenkapital, kpi.jahresergebnis, kpi.betriebsergebnis].filter((x) => x != null).length;
    if (filled >= 1) out.push(kpi);
  }
  return out.sort((a, b) => a.stichtag.localeCompare(b.stichtag));
}

/**
 * Extract the (companyNumber, periodEnd) pair encoded in the Companies
 * House bulk-data filename. Filenames are `Prod223_NNNN_CCCCCCCC_YYYYMMDD.ext`
 * where CCCCCCCC is the 8-char company number and YYYYMMDD is the period
 * end date. Returns null if the filename doesn't match.
 */
export function parseBulkFilename(name) {
  const m = String(name || '').match(/^Prod\d+_\d+_([A-Z0-9]{1,10})_(\d{4})(\d{2})(\d{2})\.\w+$/i);
  if (!m) return null;
  return {
    companyNumber: m[1].toUpperCase(),
    periodEnd: `${m[2]}-${m[3]}-${m[4]}`,
  };
}
