// Parser for Danish iXBRL account filings as published through the CVR
// Regnskaber (Offentliggørelser) data product. Every Danish limited
// company files Årsrapport electronically in iXBRL using the FSA
// (Finanstilsynet / Erhvervsstyrelsen) taxonomy, which is stable across
// the yearly revisions we care about.
//
// Same shape as server/uk-ixbrl-parser.js but with Danish taxonomy tags
// and DKK as default currency. We keep the two parsers separate rather
// than sharing a generic one because the tag preference order and the
// Bilanzsumme derivation differ (DK exposes fsa:Assets directly, UK has
// to sum FixedAssets + CurrentAssets).

const CONTEXT_RE = /<xbrli:context\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g;
const PERIOD_START_RE = /<xbrli:startDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:startDate>/;
const PERIOD_END_RE   = /<xbrli:endDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:endDate>/;
const INSTANT_RE      = /<xbrli:instant>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:instant>/;
const NON_FRACTION_RE = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g;

// FSA Årsrapport taxonomy. Listed in preference order — first match wins.
const TAG_TO_KPI = {
  // Revenue
  'fsa:Revenue':                                   'umsatzerloese',
  'fsa:GrossProfitLoss':                           '_grossProfit',

  // Profit for the year
  'fsa:ProfitLoss':                                'jahresergebnis',
  'fsa:ProfitLossForTheYear':                      'jahresergebnis',

  // Operating profit / result
  'fsa:ProfitLossFromOrdinaryOperatingActivities': 'betriebsergebnis',
  'fsa:ProfitLossFromOperatingActivities':         'betriebsergebnis',

  // Equity — fsa:Equity is the primary anchor
  'fsa:Equity':                                    'eigenkapital',

  // Balance sheet total (direct)
  'fsa:Assets':                                    'bilanzsumme',
  'fsa:LiabilitiesAndEquity':                      '_liabEq',
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
  const text = String(raw).replace(/<[^>]+>/g, '').trim();
  if (!text) return null;
  const neg = /^\(.*\)$/.test(text);
  // DK filings use either "." or "," as thousand separator — strip both.
  const stripped = text.replace(/[()\s.,]/g, '').replace(/[^0-9\-]/g, '');
  if (!stripped) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseContexts(html) {
  const map = new Map();
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
 * @param {Buffer|string} src  iXBRL HTML
 * @param {{filename?: string, currency?: string}} meta
 * @returns {Array<object>} KPI rows, one per fiscal period.
 */
export function parseDkIxbrl(src, meta = {}) {
  const html = Buffer.isBuffer(src) ? src.toString('utf8') : String(src || '');
  if (!html || !html.includes('<ix:nonFraction')) return [];
  const contexts = parseContexts(html);
  if (!contexts.size) return [];

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
    if (!(target in row)) row[target] = v;
    facts.set(ctx, row);
  }

  const byEndDate = new Map();
  for (const [ctxId, row] of facts.entries()) {
    const period = contexts.get(ctxId);
    if (!period?.end) continue;
    const merged = byEndDate.get(period.end) || {};
    for (const [k, v] of Object.entries(row)) {
      if (merged[k] == null) merged[k] = v;
    }
    byEndDate.set(period.end, merged);
  }

  const currency = meta.currency || 'DKK';
  const out = [];
  for (const [stichtag, r] of byEndDate.entries()) {
    const bilanzsumme = r.bilanzsumme ?? r._liabEq ?? null;
    const kpi = {
      stichtag,
      currency,
      umsatzerloese:    r.umsatzerloese    ?? null,
      bilanzsumme,
      eigenkapital:     r.eigenkapital     ?? null,
      jahresergebnis:   r.jahresergebnis   ?? null,
      betriebsergebnis: r.betriebsergebnis ?? null,
      arbeitnehmer: null,
      ek_quote: (bilanzsumme && r.eigenkapital != null) ? r.eigenkapital / bilanzsumme : null,
      source_ref: meta.filename || null,
      source: 'ixbrl-dk',
    };
    const filled = [kpi.umsatzerloese, kpi.bilanzsumme, kpi.eigenkapital, kpi.jahresergebnis, kpi.betriebsergebnis].filter((x) => x != null).length;
    if (filled >= 1) out.push(kpi);
  }
  return out.sort((a, b) => a.stichtag.localeCompare(b.stichtag));
}
