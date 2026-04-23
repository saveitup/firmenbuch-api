// Heuristic parser for UK Companies House account filings (Report & Accounts).
//
// UK Companies House converts every filed iXBRL submission into a PDF for
// public viewing and does not expose the underlying structured XBRL via
// the public API. Large companies additionally file glossy designer PDFs
// (Tesco, Greggs, BP) which are image-only TIFF→PDF conversions — those
// need OCR just like French scanned bilanzen.
//
// Parser architecture mirrors the French one (layout-aware via pdf.js,
// OCR fallback via Tesseract `eng`), but with UK-specific quirks:
//   • Numbers use comma as thousand separator: "33,054" = 33054
//   • Negatives in brackets: "(119)" = -119
//   • Unit declaration: "£m", "£'000", "£000", "in £ millions"
//   • Labels: Revenue / Turnover, Operating profit, Profit for the year,
//     Total assets, Total equity / Net assets, Total liabilities
//   • Currency fixed to GBP

import { PDFParse } from 'pdf-parse';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ocrPdfUk, looksLikeScannedPdf } from './pdf-ocr.js';
import { readOcrText, writeOcrText } from './normalize.js';

// ─── Number + unit parsing ──────────────────────────────────────────────
// Matches integers/decimals with optional comma thousand separators and
// optional paren wrapping for negatives.
function parseUkNumber(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw) return null;
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const stripped = raw.replace(/[()\s,]/g, '').replace(/^-/, '');
  if (!/^\d/.test(stripped)) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Strict numeric tokenizer. Requires either comma-grouped digits
// ("1,234,567.89") or plain integer/decimal. Rejects date-like sequences
// by bounding the first digit group to 1-3.
function numbersOnLine(line) {
  const out = [];
  const re = /\(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)|-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\(-?\d+(?:\.\d+)?\)|-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = parseUkNumber(m[0]);
    if (v != null) out.push(v);
  }
  return out;
}

const UNIT_RE_PAREN = /[(\[](?:in\s+)?£\s*(m|millions?|'?000|thousands?)[)\]]/i;
const UNIT_RE_BARE  = /£\s?('?000\b|m\b|bn\b)/i;
const UNIT_RE_PROSE = /(?:figures|amounts)\s+(?:are\s+)?(?:stated\s+|shown\s+)?in\s+(?:£\s*)?(millions?|thousands?)/i;

function detectUnit(text) {
  const mp = text.match(UNIT_RE_PAREN);
  if (mp) {
    const tok = mp[1].toLowerCase();
    if (tok === 'm' || tok.startsWith('million')) return 1_000_000;
    return 1_000;
  }
  const mb = text.match(UNIT_RE_BARE);
  if (mb) {
    const tok = mb[1].toLowerCase();
    if (tok === 'bn') return 1_000_000_000;
    if (tok === 'm')  return 1_000_000;
    return 1_000;                              // '000
  }
  const mx = text.match(UNIT_RE_PROSE);
  if (mx) return /million/i.test(mx[1]) ? 1_000_000 : 1_000;
  return 1;
}

// ─── Plausibility ───────────────────────────────────────────────────────
const MAGNITUDE_MIN = 1e4;   // £10k — even the smallest reporting filer
const MAGNITUDE_MAX = 5e12;  // £5T — captures HSBC / Barclays scale

function isPlausibleMagnitude(v) {
  const a = Math.abs(v);
  return a >= MAGNITUDE_MIN && a <= MAGNITUDE_MAX;
}

function chooseBestUnit(raw, pageUnit, docUnit) {
  const a = raw * pageUnit;
  if (pageUnit === docUnit) return a;
  const b = raw * docUnit;
  const aOk = isPlausibleMagnitude(a);
  const bOk = isPlausibleMagnitude(b);
  if (aOk && !bOk) return a;
  if (!aOk && bOk) return b;
  return a;
}

// ─── KPI label patterns ─────────────────────────────────────────────────
// Ordered tier 1 → tier 2. UK reports use two overlapping vocabularies:
// • UK GAAP FRS-102: Turnover, Operating profit, Profit for the year,
//   Fixed assets, Current assets, Creditors, Net assets
// • IFRS: Revenue, Profit from operations, Profit after tax, Total assets,
//   Total liabilities, Total equity
const PATTERNS = {
  umsatzerloese: [
    /^\s*(?:total\s+)?revenue\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*turnover\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*group\s+revenue\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*continuing\s+operations\s+revenue\b/i,
  ],
  bilanzsumme: [
    /^\s*total\s+assets\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*total\s+group\s+assets\b/i,
  ],
  bilanzsumme_passif: [
    // UK balance sheets don't always carry "Total liabilities + equity"
    // on one line — Net assets is often the mirror (assets - liabilities).
    /^\s*net\s+assets\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*total\s+equity\s+and\s+liabilities\b/i,
  ],
  eigenkapital: [
    /^\s*total\s+equity\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*total\s+shareholders['\u2019]?\s+(?:equity|funds)\b/i,
    /^\s*shareholders['\u2019]?\s+(?:equity|funds)\b/i,
    /^\s*equity\s+attributable\s+to\s+(?:owners|shareholders|equity\s+holders)\b/i,
    /^\s*capital\s+and\s+reserves\s*(?:attributable\s+to\s+.*)?$/i,
  ],
  jahresergebnis: [
    /^\s*profit\s+(?:or\s+loss\s+)?for\s+the\s+(?:financial\s+)?(?:year|period)\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*profit\s+after\s+taxation\b/i,
    /^\s*profit\s+after\s+tax\b/i,
    /^\s*(?:net\s+)?profit\s+attributable\s+to\s+(?:owners|shareholders|equity\s+holders)\b/i,
    /^\s*(?:loss|profit)\s+for\s+the\s+(?:financial\s+)?(?:year|period)\b/i,
  ],
  betriebsergebnis: [
    /^\s*operating\s+profit\s*(?:\(note[^)]*\))?\s*$/i,
    /^\s*profit\s+from\s+operations\b/i,
    /^\s*operating\s+(?:profit|loss)\s*\(?(?:loss|profit)?\)?\s*$/i,
    /\boperating\s+profit\b/i,
  ],
};

// Line-based (plain-text / OCR) variants — relaxed anchors because label
// can sit mid-line in prose.
const LINE_PATTERNS = Object.fromEntries(
  Object.entries(PATTERNS).map(([kind, pats]) => [
    kind,
    pats.map((re) => {
      let src = re.source;
      src = src.replace(/^\^\\s\*/, '\\b');
      src = src.replace(/\\s\*(?:\(\?:\\\(note\[\^\)\]\*\\\)\))?\\s\*\$$/g, '\\b');
      src = src.replace(/\\s\*\$$/, '\\b');
      return new RegExp(src, re.flags);
    }),
  ]),
);

function countNumericCells(cells) {
  let n = 0;
  for (let i = 1; i < cells.length; i++) if (parseUkNumber(cells[i].str) != null) n++;
  return n;
}

function asYearHeader(cells) {
  const yearToX = {};
  for (const c of cells) {
    const s = (c.str || '').trim();
    const m = s.match(/^(20[1-3]\d)$/);
    if (m) yearToX[m[1]] = c.x + (c.width || 0) / 2;
  }
  return Object.keys(yearToX).length >= 2 ? yearToX : null;
}

function pickColumnValue(cells, targetX, { minValue = null } = {}) {
  const candidates = [];
  for (let i = 1; i < cells.length; i++) {
    const n = parseUkNumber(cells[i].str);
    if (n == null) continue;
    if (minValue != null && n < minValue) continue;
    candidates.push({ n, x: cells[i].x + (cells[i].width || 0) / 2 });
  }
  if (!candidates.length) return null;
  if (targetX == null) return candidates[candidates.length - 1].n;
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c.x - targetX);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return bestDist <= 50 ? best.n : null;
}

// ─── Layout extraction ──────────────────────────────────────────────────
async function extractLayoutRows(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const allRows = [];
  const pageUnits = new Map();
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str).join(' ');
    pageUnits.set(p, detectUnit(pageText));

    const items0 = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str, w: it.width || it.str.length * 5 }))
      .sort((a, b) => b.y - a.y);
    const rowsThisPage = [];
    for (const it of items0) {
      const row = rowsThisPage.find((r) => Math.abs(r.y - it.y) <= 1.5);
      if (row) row.items.push(it);
      else rowsThisPage.push({ y: it.y, items: [it] });
    }
    for (const { y, items } of rowsThisPage) {
      items.sort((a, b) => a.x - b.x);
      const cells = [];
      let last = null;
      for (const it of items) {
        const gap = last ? it.x - (last.x + last.width) : Infinity;
        if (last && gap < 5) {
          last.str += it.str;
          last.width = (it.x + it.w) - last.x;
        } else {
          last = { x: it.x, str: it.str, width: it.w };
          cells.push(last);
        }
      }
      const trimmed = cells
        .map((c) => ({ x: c.x, width: c.width, str: c.str.trim() }))
        .filter((c) => c.str.length);
      if (trimmed.length) allRows.push({ page: p, y, cells: trimmed });
    }
    page.cleanup?.();
  }
  await doc.destroy?.();
  allRows._pageUnits = pageUnits;
  return allRows;
}

function rowsToText(rows) {
  return rows.map((r) => (r.cells || r).map((c) => c.str || c).join('\t')).join('\n');
}

function collectYearHeaders(rows) {
  const byPage = new Map();
  for (const row of rows) {
    const m = asYearHeader(row.cells);
    if (!m) continue;
    if (!byPage.has(row.page)) byPage.set(row.page, []);
    byPage.get(row.page).push({ y: row.y, yearToX: m });
  }
  for (const arr of byPage.values()) arr.sort((a, b) => b.y - a.y);
  return byPage;
}

function headerFor(row, headersByPage) {
  const list = headersByPage.get(row.page);
  if (!list) return null;
  let best = null, bestDy = Infinity;
  for (const h of list) {
    const dy = h.y - row.y;
    if (dy >= 0 && dy < bestDy) { best = h; bestDy = dy; }
  }
  if (best) return best.yearToX;
  return list[0].yearToX;
}

// ─── Row-aware parse ────────────────────────────────────────────────────
export function parseUkBilanRows(rows, meta = {}) {
  const joinedText = rowsToText(rows);
  const docUnit = detectUnit(joinedText);
  const pageUnits = rows._pageUnits;
  const targetYear = meta.dateCloture ? String(meta.dateCloture).slice(0, 4) : null;
  const headersByPage = collectYearHeaders(rows);

  const POSITIVE_KPIS = new Set(['bilanzsumme', 'bilanzsumme_passif', 'umsatzerloese']);
  const getKpi = (kind) => {
    const patterns = PATTERNS[kind] || [];
    const opts = POSITIVE_KPIS.has(kind) ? { minValue: 1 } : {};
    for (const phase of ['strict', 'lax']) {
      for (const pattern of patterns) {
        for (const minNums of [2, 1]) {
          for (const row of rows) {
            const label = row.cells[0]?.str || '';
            if (!pattern.test(label)) continue;
            const nc = countNumericCells(row.cells);
            if (nc < minNums) continue;
            const yearMap = targetYear ? headerFor(row, headersByPage) : null;
            const hasYearTarget = yearMap && yearMap[targetYear] != null;
            if (phase === 'strict' && !hasYearTarget) continue;
            if (phase === 'lax' && nc > 4) continue;
            const targetX = yearMap?.[targetYear] ?? null;
            const v = pickColumnValue(row.cells, targetX, opts);
            if (v == null) continue;
            const pageUnit = pageUnits?.get(row.page) ?? docUnit;
            return chooseBestUnit(v, pageUnit, docUnit);
          }
        }
      }
    }
    return null;
  };

  const umsatzerloese    = getKpi('umsatzerloese');
  const bilanzsumme      = getKpi('bilanzsumme') ?? getKpi('bilanzsumme_passif');
  const eigenkapital     = getKpi('eigenkapital');
  const jahresergebnis   = getKpi('jahresergebnis');
  const betriebsergebnis = getKpi('betriebsergebnis');

  const filled = [umsatzerloese, bilanzsumme, eigenkapital, jahresergebnis, betriebsergebnis].filter((v) => v != null).length;
  if (filled < 1) return null;

  const stichtag = meta.dateCloture ? String(meta.dateCloture).slice(0, 10) : null;
  return {
    stichtag,
    currency: 'GBP',
    umsatzerloese,
    bilanzsumme,
    eigenkapital,
    jahresergebnis,
    betriebsergebnis,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    source_ref: meta.sourceRef || null,
    source: 'pdf-heuristic-uk',
    typeBilan: meta.typeBilan || null,
  };
}

// ─── Text / OCR parse ───────────────────────────────────────────────────
const TEXT_MIN_RAW = {
  bilanzsumme: 10, bilanzsumme_passif: 10, umsatzerloese: 10, eigenkapital: 10,
};

function extractKpi(text, kind, unit = 1) {
  const patterns = LINE_PATTERNS[kind] || [];
  const lines = text.split('\n');
  const isPlausible = (n) => isPlausibleMagnitude(n * unit);
  const minRaw = TEXT_MIN_RAW[kind] ?? 0;
  for (const pattern of patterns) {
    for (const l of lines) {
      if (!pattern.test(l)) continue;
      let nums = numbersOnLine(l).filter((n) => Math.abs(n) >= minRaw);
      if (!nums.length) continue;
      while (nums.length >= 2) {
        const a = Math.abs(nums[0]);
        if (a >= 2015 && a <= 2035 && Number.isInteger(nums[0])) nums = nums.slice(1);
        else break;
      }
      const filtered = (nums.length >= 2
          && Math.abs(nums[0]) < 100
          && Math.abs(nums[1]) > Math.abs(nums[0]) * 2)
        ? nums.slice(1)
        : nums;
      for (const n of filtered) {
        if (isPlausible(n)) return n;
      }
      if (filtered.length) return filtered[0];
    }
  }
  return null;
}

export function parseUkBilanText(text, meta = {}) {
  if (!text || text.length < 500) return null;
  const unit = detectUnit(text);
  const mult = (n) => {
    if (n == null) return null;
    const scaled = n * unit;
    if (isPlausibleMagnitude(scaled)) return scaled;
    if (unit > 1 && isPlausibleMagnitude(n)) return n;
    return scaled;
  };

  const umsatzerloese    = mult(extractKpi(text, 'umsatzerloese',     unit));
  const bilanzsumme      = mult(extractKpi(text, 'bilanzsumme',       unit) || extractKpi(text, 'bilanzsumme_passif', unit));
  const eigenkapital     = mult(extractKpi(text, 'eigenkapital',      unit));
  const jahresergebnis   = mult(extractKpi(text, 'jahresergebnis',    unit));
  const betriebsergebnis = mult(extractKpi(text, 'betriebsergebnis',  unit));

  const filled = [umsatzerloese, bilanzsumme, eigenkapital, jahresergebnis, betriebsergebnis].filter((v) => v != null).length;
  if (filled < 1) return null;

  const stichtag = meta.dateCloture ? String(meta.dateCloture).slice(0, 10) : null;
  return {
    stichtag,
    currency: 'GBP',
    umsatzerloese,
    bilanzsumme,
    eigenkapital,
    jahresergebnis,
    betriebsergebnis,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    source_ref: meta.sourceRef || null,
    source: 'pdf-heuristic-uk',
    typeBilan: meta.typeBilan || null,
  };
}

/**
 * Full UK bilan parsing pipeline (layout → plain text → OCR).
 * @param {Buffer} buf PDF bytes
 * @param {{dateCloture?: string, typeBilan?: string, sourceRef?: string}} meta
 * @returns {Promise<object|null>} KPI row or null if no usable KPIs found
 */
export async function parseUkBilanPdf(buf, meta = {}) {
  // 1) Layout-aware path (pdf.js positions). Works for digital iXBRL-
  //    rendered PDFs produced by FreeAgent/Xero/etc.
  let rows = null;
  try { rows = await extractLayoutRows(buf); } catch { rows = null; }
  if (rows && rows.length) {
    const kpi = parseUkBilanRows(rows, meta);
    if (kpi) return kpi;
  }

  // 2) pdf-parse plain text (handles odd PDFs that pdf.js dislikes).
  let plainText = '';
  try {
    const p = new PDFParse({ data: buf });
    const t = await p.getText();
    plainText = t.text || '';
  } catch { /* fall through */ }

  if (plainText && !looksLikeScannedPdf(plainText)) {
    const kpi = parseUkBilanText(plainText, meta);
    if (kpi) return kpi;
  }

  // 3) Tesseract OCR `eng`. Required for TIFF→PDF scans which dominate
  //    listed-company annual reports at Companies House (Tesco, Greggs).
  //    Cached in SQLite on the bilan id.
  try {
    const cacheKey = meta.sourceRef;
    let ocrText = cacheKey ? readOcrText('UK', cacheKey) : null;
    if (!ocrText) {
      ocrText = await ocrPdfUk(buf);
      if (cacheKey && ocrText) writeOcrText('UK', cacheKey, ocrText);
    }
    if (ocrText && ocrText.length > 500) {
      return parseUkBilanText(ocrText, meta);
    }
  } catch { /* OCR failure → null */ }
  return null;
}
