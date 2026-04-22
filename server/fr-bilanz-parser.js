// Heuristic parser for French comptes annuels deposited at INPI RNE.
// Unlike the German/Austrian pipeline (XBRL-style structured data), INPI
// only exposes bilan filings as PDF. Narrative format ("Danone-style") is
// by far the most common for big filers; this parser targets that shape
// and is tolerant of extra columns (bilan actif has 4: N-1 net, N brut,
// amort, N net — we always take the rightmost number on the matched line).
//
// French accounting quirks the parser must handle:
//   • Numbers use space as thousands separator: "33 054" = 33054
//   • Negatives are wrapped in parentheses: "(119)" = -119
//   • Units appear in table header: "(en millions d'euros)" → ×1e6
//
// Returns null when fewer than two top-level fields can be extracted — the
// caller should then skip this filing rather than emit a near-empty row.

import { PDFParse } from 'pdf-parse';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ocrPdfFr, looksLikeScannedPdf } from './pdf-ocr.js';
import { readOcrText, writeOcrText } from './normalize.js';

// Unit detection. French bilans declare the unit in the table header or
// in a preamble note. The most common styles:
//   • "(en millions d'euros)"   → ×1e6
//   • "(en milliers d'euros)"   → ×1e3
//   • "(en K€)" / "K€"          → ×1e3   (Michelin 2024 S)
//   • "(en M€)" / "M€"          → ×1e6
//   • "en milliers d'euros"     (inline prose, no parens)
// When multiple hints disagree, the `(en …)` form inside parens takes
// precedence over prose hints because headers are table-scoped.
const UNIT_RE_PAREN = /\(en\s+(millions?|milliers|K€|M€)(?:\s+d['\u2019]euros?)?\)/i;
const UNIT_RE_PROSE = /exprim[ée]s\s+en\s+(millions?|milliers)\s+d['\u2019]euros?/i;

function parseFrenchNumber(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw) return null;
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const stripped = raw.replace(/[\s\u00a0\u202f()]/g, '').replace(/,/g, '.').replace(/^-/, '');
  if (!/^\d/.test(stripped)) return null;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Extract numeric tokens. Each token: optional paren-wrap, then 1-3 digits
// followed by space-separated exact-3-digit groups. This strictness is what
// prevents "12 16 413 15 720" (note-ref + two values) from collapsing into
// one giant number — the regex stops at "12" because "16" is only 2 digits
// and can't be a thousands-group continuation.
function numbersOnLine(line) {
  const out = [];
  const re = /\(-?\d{1,3}(?:[\s\u00a0\u202f]\d{3})*(?:[,.]\d+)?\)|-?\d{1,3}(?:[\s\u00a0\u202f]\d{3})+(?:[,.]\d+)?|-?\d+(?:[,.]\d+)?/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = parseFrenchNumber(m[0]);
    if (v != null) out.push(v);
  }
  return out;
}

function lastNumberOnLine(line) {
  const nums = numbersOnLine(line);
  return nums.length ? nums[nums.length - 1] : null;
}

// Plausible magnitude for any non-trivial corporate KPI in EUR. A typical
// SME's balance sum is ≥€100k; the biggest French groups cap around €3T.
const MAGNITUDE_MIN = 1e5;
const MAGNITUDE_MAX = 5e12;

function isPlausibleMagnitude(v) {
  const a = Math.abs(v);
  return a >= MAGNITUDE_MIN && a <= MAGNITUDE_MAX;
}

// Given a raw parsed number and two candidate unit multipliers, pick the
// product that lands in a plausible corporate magnitude. When both are
// plausible we prefer the page-local unit (first arg) — it reflects the
// unit header nearest the actual row.
function chooseBestUnit(raw, pageUnit, docUnit) {
  const a = raw * pageUnit;
  if (pageUnit === docUnit) return a;
  const b = raw * docUnit;
  const aOk = isPlausibleMagnitude(a);
  const bOk = isPlausibleMagnitude(b);
  if (aOk && !bOk) return a;
  if (!aOk && bOk) return b;
  return a;  // prefer page-local when ambiguous
}

function detectUnit(text) {
  // Prefer the parenthetical form (table header) — it's the authoritative
  // unit for the bilan/compte-de-résultat tables themselves.
  const mp = text.match(UNIT_RE_PAREN);
  if (mp) {
    const tok = mp[1].toLowerCase();
    if (tok === 'm€' || tok.startsWith('million')) return 1_000_000;
    return 1_000;   // milliers / K€
  }
  const mProse = text.match(UNIT_RE_PROSE);
  if (mProse) return /million/i.test(mProse[1]) ? 1_000_000 : 1_000;
  return 1;  // plain euros
}

// Walk forward from `fromIdx` looking for the next line matching `labelRe`.
// Returns the line string and its end offset so the caller can continue.
function findLine(text, labelRe, fromIdx = 0) {
  const sub = text.slice(fromIdx);
  const lines = sub.split('\n');
  let offset = 0;
  for (const l of lines) {
    if (labelRe.test(l)) return { line: l, endIdx: fromIdx + offset + l.length };
    offset += l.length + 1;
  }
  return null;
}

// KPI label patterns. Each regex is tested against the FIRST cell of a row
// (the label column). We run them in order — the first match wins — and
// for each row, take the value from the column that matches the filing's
// dateCloture year (see pickColumnValue below).
//
// IFRS-consolidated filings use different wording than plain CERFA: e.g.
// "Revenus" / "Produits des activités ordinaires" instead of "Chiffre
// d'affaires"; "Résultat opérationnel courant" instead of "Résultat
// d'exploitation". We match both worlds.
// KPI label patterns. Matched against the FIRST cell of each row. We do
// NOT anchor `$`: label cells sometimes carry a suffix like "(note 7)" or
// "hors taxes" that varies by filer, and strict anchoring caused regressions
// on Renault/Michelin. Instead we require the row to have ≥2 numeric cells
// (see rowIsDataLike), which reliably distinguishes table rows from prose.
// Patterns are listed in priority order. `getKpi` iterates pattern-first:
// each pattern scans the whole document before moving to the next one, so
// tier-1 (strict) labels always beat tier-2 (broad) fallbacks even if the
// broader one appears earlier in the PDF. This fixes Orange-style bugs
// where a segment-level "Résultat net" sub-row pre-empts the actual
// consolidated "Résultat net de l'ensemble consolidé" total.
const PATTERNS = {
  umsatzerloese: [
    /^[^a-z]*chiffre\s+d['\u2019]affaires\s*(?:nets?|hors\s+taxes?)?\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*produits\s+des\s+activit[ée]s\s+(?:ordinaires|courantes)\b/i,
    /^[^a-z]*revenus\s*(?:\(.*\))?\s*$/i,
    // LVMH-style: holding companies report "Prestations de services et
    // autres revenus" as their operating top line (dividends from subs
    // show up separately under "Produits financiers").
    /^[^a-z]*prestations\s+de\s+services(?:\s+et\s+autres\s+revenus)?\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*chiffre\s+d['\u2019]affaires\b/i,          // broader fallback
    // "Total (des) produits d'exploitation" — Carrefour's parent filing
    // does not break out chiffre d'affaires, so this aggregate is the best
    // available top-line proxy. Accept with or without the "des" article.
    /^[^a-z]*total\s+(?:des\s+)?produits\s+d['\u2019]exploitation\b/i,
  ],
  bilanzsumme: [
    /^[^a-z]*total\s+(?:de\s+l['\u2019])?actifs?\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*total\s+g[ée]n[ée]ral\b/i,
  ],
  bilanzsumme_passif: [
    // Tier 1: bare "Total du passif" / "TOTAL PASSIF" (with $ anchor so
    // we reject sub-totals). Social filings (Danone, etc.) always expose
    // the simpler form on the parent-company balance, while later appendix
    // pages may carry the consolidated full-balance phrase with a different
    // figure — we want the parent's first.
    /^[^a-z]*total\s+(?:du\s+)?passifs?\s*(?:\(.*\))?\s*$/i,
    // Tier 2: combined phrase (both orderings). Matches Renault / Orange
    // and any filing whose balance sheet uses "TOTAL DU PASSIF ET DES
    // CAPITAUX PROPRES" (or "TOTAL CAPITAUX PROPRES ET PASSIFS") as its
    // only total line.
    /^[^a-z]*total\s+(?:des\s+)?capitaux\s+propres\s+et\s+(?:du\s+|des\s+)?passifs?\b/i,
    /^[^a-z]*total\s+(?:du\s+|des\s+)?passifs?\s+et\s+(?:des\s+)?capitaux\s+propres\b/i,
    /^total\s?capitaux\s?propres\s?et\s?passifs?\b/i,
  ],
  eigenkapital: [
    /^[^a-z]*(?:total\s+)?capitaux\s+propres\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*total\s+des\s+capitaux\s+propres\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*capitaux\s+propres\s+totaux\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*capitaux\s+propres\s+(?:—\s*)?part\s+du\s+groupe\s*$/i,
  ],
  jahresergebnis: [
    // Tier 1: strict labels for the full-company net result.
    /^[^a-z]*r[ée]sultat\s+net\s+de\s+l['\u2019]exercice\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+de\s+l['\u2019]exercice\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+net\s+comptable\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+net\s+de\s+l['\u2019]ensemble\s+consolid[ée]\s*$/i,
    /^[^a-z]*r[ée]sultat\s+net\s+consolid[ée]\s*$/i,
    /^[^a-z]*b[ée]n[ée]fice\s+(?:net\s+)?de\s+l['\u2019]exercice\b/i,
    // AGM-extract prose, which dominates scanned cover-sheet filings:
    // "Bénéfice de l'exercice 2022   4 911 523 379,89 €".
    /^[^a-z]*b[ée]n[ée]fice\s+de\s+l['\u2019]exercice\s+\d{4}\b/i,
    // Tier 2: bare "Résultat net" — accepted only when nothing above matched.
    /^[^a-z]*r[ée]sultat\s+net\s*(?:\(.*\))?\s*$/i,
  ],
  betriebsergebnis: [
    /^[^a-z]*r[ée]sultat\s+d['\u2019]exploitation\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+op[ée]rationnel\s+courant\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+op[ée]rationnel\s*(?:\(.*\))?\s*$/i,
    /^[^a-z]*r[ée]sultat\s+d['\u2019]exploitation\b/i,  // broader fallback
  ],
};

// A row counts as "data-like" — i.e., a real table row rather than prose
// that happens to start with a KPI label — if it has ≥2 numeric cells
// after the label. Single-value rows (rare but legitimate, e.g. a final
// summary) get accepted via the ≥1 cell fallback inside getKpi.
function countNumericCells(cells) {
  let n = 0;
  for (let i = 1; i < cells.length; i++) if (parseFrenchNumber(cells[i].str) != null) n++;
  return n;
}

// Looser line-anchored variants of PATTERNS for the plain-text / OCR path.
// Original PATTERNS are written for *cells* — label only, anchored with `^`
// at start and `$` at end. A line can have: (a) prose before the label
// ("faisant ressortir un bénéfice net de 4 105 828 765,28 euros"), and
// (b) the actual numeric values trailing the label. We therefore relax
// BOTH anchors: drop the `^[^a-z]*` prefix and the cell-end suffix, and
// switch to word boundaries.
const LINE_PATTERNS = Object.fromEntries(
  Object.entries(PATTERNS).map(([kind, pats]) => [
    kind,
    pats.map((re) => {
      let src = re.source;
      src = src.replace(/^\^\[\^a-z\]\*/, '\\b');
      src = src.replace(/\\s\*\(\?:\\\(\.\*\\\)\)\?\\s\*\$/g, '\\b');
      return new RegExp(src, re.flags);
    }),
  ]),
);

// Plain-text / OCR KPI extraction. Column ambiguity is fundamental here
// because OCR drops positions. Take the FIRST numeric token whose value
// × unit lands in a plausible magnitude band — this filters out note-ref
// prefixes (like "Capitaux propres 7.3 21 441 22 252": "7.3" is the note
// reference, real value starts at "21 441").
// Per-KPI minimum absolute raw value (pre-unit). Filters out enumeration
// markers ("4 + Activité…"), page numbers, section indexes, etc. that
// would otherwise be matched as the first number on a prose line.
//  - bilanzsumme & umsatzerloese: always large, minimum ≥10 raw
//  - eigenkapital: can be small for young SARLs but rarely single-digit
//  - jahresergebnis / betriebsergebnis: can legitimately be tiny or
//    negative; no minimum, the note-ref filter still protects
const TEXT_MIN_RAW = {
  bilanzsumme: 10,
  bilanzsumme_passif: 10,
  umsatzerloese: 10,
  eigenkapital: 10,
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
      // Strip leading year tokens (2015..2035). Prose patterns such as
      // "bénéfice de l'exercice 2019 s'élevant à 4 105 828 765,28 euros"
      // match the label then emit the fiscal year before the real value;
      // 2019 is not a KPI amount.
      while (nums.length >= 2) {
        const a = Math.abs(nums[0]);
        if (a >= 2015 && a <= 2035 && Number.isInteger(nums[0])) {
          nums = nums.slice(1);
        } else break;
      }
      // Strip leading note-reference anchors. French bilans routinely
      // prefix each row with its footnote number ("Capitaux propres 7.3
      // 21 441 22 252" → 7.3 is the note) and that number looks just like
      // a value in plain text / OCR output.
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

// Year-header detection. Extract year→x mappings from any row that carries
// ≥2 distinct 4-digit year tokens as cells. Prose cells (table headings
// like "Exercice clos le ... (en millions d'euros) Notes 2024 2023") are
// tolerated — we just skip them and record the year cells we find.
function asYearHeader(cells) {
  const yearToX = {};
  for (const c of cells) {
    const s = (c.str || '').trim();
    const m = s.match(/^(20[1-3]\d)$/);
    if (m) yearToX[m[1]] = c.x + (c.width || 0) / 2;
  }
  const nYears = Object.keys(yearToX).length;
  return nYears >= 2 ? yearToX : null;
}

// Pick the cell value for a specific year by x-proximity. `minValue`
// skips candidates whose value is below the threshold — needed for the
// bilan-actif 4-column layout (Montants bruts / Amortissements / Montants
// nets): the amort column carries a negative total that can sit nearer
// to the "2024" year-header x than the actual net column does.
function pickColumnValue(cells, targetX, { minValue = null } = {}) {
  const candidates = [];
  for (let i = 1; i < cells.length; i++) {
    const n = parseFrenchNumber(cells[i].str);
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

// Layout-aware extraction: use pdf.js positioned text items, group items
// into visual rows by y-coordinate, and within each row keep cell-level
// separation based on x-coordinate gaps. This is the critical distinction
// vs. plain text extraction — in a French balance sheet, the columns are
// only space-separated in the text layer, which collides with the French
// thousands separator. Without column boundaries, "Résultat 2 280 592"
// parses as 2,280,592 instead of [2280, 592].
async function extractLayoutRows(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const allRows = [];
  const pageUnits = new Map();  // page → multiplier derived from that page's text
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Scope unit detection to each page — filings like Michelin's 2024 S
    // mix a CERFA liasse (raw euros, pages 1–7) with separate bilan detail
    // tables declaring "(en K€)" on later pages. A document-wide unit
    // detection then over-scales CERFA rows by 1000×.
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
  allRows._pageUnits = pageUnits;   // attach for downstream per-page unit lookup
  return allRows;
}

// Text view for unit detection and the plain-text fallback path. Cells
// joined by tabs so thousand-separator spaces stay scoped to one cell.
function rowsToText(rows) {
  return rows.map((r) => (r.cells || r).map((c) => c.str || c).join('\t')).join('\n');
}

// Collect ALL year-header rows (not just the first per page). Pages often
// carry multiple tables with independent column layouts — e.g. Danone's
// page 9 has the Actif table header (y=658) AND the Passif table header
// (y=363). A Passif data row at y=243 must consult the y=363 header, not
// the y=658 one. Headers are returned sorted top-to-bottom per page so the
// caller can pick the nearest preceding header for each data row.
function collectYearHeaders(rows) {
  const byPage = new Map(); // page → [{ y, yearToX }, ...]
  for (const row of rows) {
    const m = asYearHeader(row.cells);
    if (!m) continue;
    if (!byPage.has(row.page)) byPage.set(row.page, []);
    byPage.get(row.page).push({ y: row.y, yearToX: m });
  }
  for (const arr of byPage.values()) arr.sort((a, b) => b.y - a.y);  // top→bottom
  return byPage;
}

// Find the header directly above a data row — same page, closest y that
// is still ≥ the row's y (i.e., above-and-nearest). Returns yearToX or
// null. If no header sits above, fall back to ANY header on the page
// (better than nothing) — happens on pages where the header is actually
// below the row due to minor y-cluster jitter.
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

/**
 * Parse one INPI bilan PDF into a KPI row.
 *
 * @param {Buffer} buf — PDF bytes
 * @param {{dateCloture?: string, typeBilan?: string, sourceRef?: string}} meta
 * @returns {Promise<object|null>} KPI row or null if parse confidence too low
 */
export async function parseFrBilanPdf(buf, meta = {}) {
  // 1) Layout-aware path via pdf.js positions — best quality when the PDF
  //    has a proper text layer.
  let rows = null;
  try { rows = await extractLayoutRows(buf); } catch { rows = null; }
  if (rows && rows.length) {
    const kpi = parseFrBilanRows(rows, meta);
    if (kpi) return kpi;
  }

  // 2) pdf-parse plain-text fallback (some exotic PDFs choke pdf.js but
  //    parse fine via pdf-parse). We still have to watch thousand-separator
  //    ambiguity, but it catches cases like single-column TOTAL rows.
  let plainText = '';
  try {
    const p = new PDFParse({ data: buf });
    const t = await p.getText();
    plainText = t.text || '';
  } catch { /* fall through to OCR */ }

  if (plainText && !looksLikeScannedPdf(plainText)) {
    const kpi = parseFrBilanText(plainText, meta);
    if (kpi) return kpi;
  }

  // 3) Tesseract OCR fallback. Fires whenever the two text-layer paths
  //    failed to produce a KPI row — includes scanned PDFs and PDFs whose
  //    extracted text is present-but-garbage. We persist OCR text to
  //    SQLite (keyed on INPI bilan id) so a repeat lookup skips the 30–90 s
  //    pdftoppm + tesseract pipeline entirely.
  try {
    const cacheKey = meta.sourceRef;
    let ocrText = cacheKey ? readOcrText('FR', cacheKey) : null;
    if (!ocrText) {
      ocrText = await ocrPdfFr(buf);
      if (cacheKey && ocrText) writeOcrText('FR', cacheKey, ocrText);
    }
    if (ocrText && ocrText.length > 500) {
      return parseFrBilanText(ocrText, meta);
    }
  } catch { /* OCR failure falls through to null */ }
  return null;
}

export function parseFrBilanRows(rows, meta = {}) {
  const joinedText = rowsToText(rows);
  const docUnit = detectUnit(joinedText);
  const pageUnits = rows._pageUnits;
  // `unit` defaults to the doc-wide value; `mult` is kept for convenience but
  // the per-KPI getKpi path now multiplies with the matched row's page-unit.
  const unit = docUnit;

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
            // Unit selection: a silent page (no explicit header) is
            // ambiguous. We compute both candidates and prefer whichever
            // lands in a plausible corporate magnitude band (€100k..€5T).
            // This handles both the Michelin case (raw € on CERFA p1,
            // pageUnit=1, docUnit=1e3 — pageUnit is right) and the Orange
            // case (millions on bilan page, pageUnit=1, docUnit=1e6 —
            // docUnit is right).
            const pageUnit = pageUnits?.get(row.page) ?? docUnit;
            return chooseBestUnit(v, pageUnit, docUnit);
          }
        }
      }
    }
    return null;
  };

  // KPI extraction now applies the per-page unit internally, so no extra
  // mult() wrapping at this layer.
  const umsatzerloese    = getKpi('umsatzerloese');
  const bilanzsumme      = getKpi('bilanzsumme_passif') ?? getKpi('bilanzsumme');
  const eigenkapital     = getKpi('eigenkapital');
  const jahresergebnis   = getKpi('jahresergebnis');
  const betriebsergebnis = getKpi('betriebsergebnis');

  const filled = [umsatzerloese, bilanzsumme, eigenkapital, jahresergebnis, betriebsergebnis].filter((v) => v != null).length;
  if (filled < 1) return null;

  const stichtag = meta.dateCloture ? String(meta.dateCloture).slice(0, 10) : null;
  return {
    stichtag,
    currency: 'EUR',
    umsatzerloese,
    bilanzsumme,
    eigenkapital,
    jahresergebnis,
    betriebsergebnis,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    source_ref: meta.sourceRef || null,
    source: 'pdf-heuristic-fr',
    typeBilan: meta.typeBilan || null,
  };
}


export function parseFrBilanText(text, meta = {}) {
  if (!text || text.length < 500) return null;
  const unit = detectUnit(text);
  // `mult` with magnitude-based fallback: if unit-scaling overshoots the
  // plausible corporate band (e.g. doc unit = millions but the AGM prose
  // line reports a raw-euro figure like "4 105 828 765,28 euros"), fall
  // back to unit = 1. Protects against mixed-unit PDFs (Michelin-style)
  // and AGM extracts where the raw euro amount is already "big".
  const mult = (n) => {
    if (n == null) return null;
    const scaled = n * unit;
    if (isPlausibleMagnitude(scaled)) return scaled;
    if (unit > 1 && isPlausibleMagnitude(n)) return n;
    return scaled;
  };

  const umsatzerloese = mult(extractKpi(text, 'umsatzerloese',     unit));
  const bilanzsumme   = mult(extractKpi(text, 'bilanzsumme',       unit) || extractKpi(text, 'bilanzsumme_passif', unit));
  const eigenkapital  = mult(extractKpi(text, 'eigenkapital',      unit));
  const jahresergebnis   = mult(extractKpi(text, 'jahresergebnis',      unit));
  const betriebsergebnis = mult(extractKpi(text, 'betriebsergebnis',    unit));

  const filled = [umsatzerloese, bilanzsumme, eigenkapital, jahresergebnis, betriebsergebnis].filter((v) => v != null).length;
  if (filled < 1) return null;  // too low confidence — skip

  const stichtag = meta.dateCloture ? String(meta.dateCloture).slice(0, 10) : null;
  return {
    stichtag,
    currency: 'EUR',
    umsatzerloese,
    bilanzsumme,
    eigenkapital,
    jahresergebnis,
    betriebsergebnis,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    source_ref: meta.sourceRef || null,
    source: 'pdf-heuristic-fr',
    typeBilan: meta.typeBilan || null,
  };
}
