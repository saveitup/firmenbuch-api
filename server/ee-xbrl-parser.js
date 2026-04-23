// Parser for Estonian annual-report XBRL filings. Every Estonian company
// files "Majandusaasta aruanne" through e-Business-Register, tagged with
// the ee-gaap taxonomy (RTJ — Raamatupidamise Toimkonna Juhend) or
// ifrs-full for IFRS preparers. Both coexist in the same document.
//
// Same architectural pattern as server/uk-ixbrl-parser.js — we parse
// contexts, then iterate <xbrli:nonFraction>-like numeric facts, and
// emit one KPI row per fiscal period.

const CONTEXT_RE = /<xbrli:context\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/xbrli:context>/g;
const PERIOD_START_RE = /<xbrli:startDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:startDate>/;
const PERIOD_END_RE   = /<xbrli:endDate>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:endDate>/;
const INSTANT_RE      = /<xbrli:instant>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<\/xbrli:instant>/;

// EE filings use plain XBRL (not inline/iXBRL wrapping HTML). Facts are
// direct XML elements with a qualified name (e.g. <ee-gaap:Müügitulu …>).
// We use a generic "any-namespaced-fact" matcher and then look up the
// local-name against our map.
const FACT_RE = /<(ee-gaap|ifrs-full|ifrs):([A-Za-z0-9_]+)\s+([^>]*?)>([^<]*)<\/\1:\2>/g;

// Tag → KPI field. ee-gaap local names take precedence over ifrs-full
// because small-company filers tag ee-gaap; large preparers may emit
// both side by side but the values agree.
const TAG_TO_KPI = {
  // Revenue
  'Müügitulu':                         'umsatzerloese',
  'Revenue':                           'umsatzerloese',
  // Operating profit
  'Ärikasum':                          'betriebsergebnis',
  'ÄrikasumKahjum':                    'betriebsergebnis',
  'ProfitLossFromOperatingActivities': 'betriebsergebnis',
  // Net profit
  'AruandeaastaKasum':                 'jahresergebnis',
  'AruandeaastaKasumKahjum':           'jahresergebnis',
  'PuhaskasumKahjum':                  'jahresergebnis',
  'ProfitLoss':                        'jahresergebnis',
  // Total assets
  'VaradKokku':                        'bilanzsumme',
  'Assets':                            'bilanzsumme',
  // Equity
  'OmakapitalKokku':                   'eigenkapital',
  'Omakapital':                        'eigenkapital',
  'Equity':                            'eigenkapital',
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
  const text = String(raw).trim();
  if (!text) return null;
  const neg = /^\(.*\)$/.test(text);
  const stripped = text.replace(/[()\s]/g, '').replace(',', '.');
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseContexts(xml) {
  const map = new Map();
  let m;
  CONTEXT_RE.lastIndex = 0;
  while ((m = CONTEXT_RE.exec(xml)) !== null) {
    const [, id, body] = m;
    const start = body.match(PERIOD_START_RE)?.[1] || null;
    const end   = body.match(PERIOD_END_RE)?.[1] || body.match(INSTANT_RE)?.[1] || null;
    if (end) map.set(id, { start, end });
  }
  return map;
}

/**
 * @param {Buffer|string} src  XBRL instance document
 * @param {{filename?: string, currency?: string}} meta
 * @returns {Array<object>} KPI rows, one per fiscal-period context.
 */
export function parseEeXbrl(src, meta = {}) {
  const xml = Buffer.isBuffer(src) ? src.toString('utf8') : String(src || '');
  if (!xml) return [];
  const contexts = parseContexts(xml);
  if (!contexts.size) return [];

  const facts = new Map();
  let m;
  FACT_RE.lastIndex = 0;
  while ((m = FACT_RE.exec(xml)) !== null) {
    const [, , localName, attrChunk, body] = m;
    const target = TAG_TO_KPI[localName];
    if (!target) continue;
    const a = parseAttrs(attrChunk);
    const ctx = a.contextRef;
    if (!ctx) continue;
    const base = parseNumericBody(body);
    if (base == null) continue;
    const decimals = Number(a.decimals ?? 0);
    // XBRL decimals="-3" means values rounded to thousands — treat as
    // already-absolute (no multiplication needed; the displayed value IS
    // the number).  We only scale if explicit `scale` attribute is present.
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

  const currency = meta.currency || 'EUR';
  const out = [];
  for (const [stichtag, r] of byEndDate.entries()) {
    const kpi = {
      stichtag,
      currency,
      umsatzerloese:    r.umsatzerloese    ?? null,
      bilanzsumme:      r.bilanzsumme      ?? null,
      eigenkapital:     r.eigenkapital     ?? null,
      jahresergebnis:   r.jahresergebnis   ?? null,
      betriebsergebnis: r.betriebsergebnis ?? null,
      arbeitnehmer: null,
      ek_quote: (r.bilanzsumme && r.eigenkapital != null) ? r.eigenkapital / r.bilanzsumme : null,
      source_ref: meta.filename || null,
      source: 'xbrl-ee',
    };
    const filled = [kpi.umsatzerloese, kpi.bilanzsumme, kpi.eigenkapital, kpi.jahresergebnis, kpi.betriebsergebnis].filter((x) => x != null).length;
    if (filled >= 1) out.push(kpi);
  }
  return out.sort((a, b) => a.stichtag.localeCompare(b.stichtag));
}
