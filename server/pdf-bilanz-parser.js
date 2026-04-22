// Heuristic §224 UGB Bilanz-Parser für PDF-Jahresabschlüsse.
// Zielgruppe: AT-Firmen, die nur PDF ohne XML einreichen (häufig bei Konzernen
// mit eigener Software-Pipeline wie OMV, Red Bull, Magna). BMD/RZL-PDFs von
// Kleinbetrieben haben in der Regel XML — wir brauchen dieses Fallback also
// vor allem für Großfirmen mit sauberem textbasiertem Layout.
//
// Strategie: wir extrahieren den Textlayer und suchen pro §224-Sektion die
// Zwischensumme, die direkt *vor* dem nächsten Abschnittsheader steht. Zwei-
// spaltige PDFs (Berichtsjahr / Vorjahr) werden adressiert, indem wir vom
// numerischen Paar am Zeilenende die *erste* Zahl (= Berichtsjahr) nehmen.
//
// Hinweis: das ist Best-Effort, keine Referenzimplementation. Scan-PDFs
// (kein Textlayer) liefern leeren String und werden übersprungen. Geringe
// Konfidenz — das Frontend sollte den `source: 'pdf-heuristic'` kennzeichnen.

import { PDFParse } from 'pdf-parse';

// Deutsche Zahl im Stil "1.234.567" oder "1.234.567,89" — Tausenderpunkte
// zwingend (einzelne 1-3-stellige Zahlen wären zu ambig). Negative über
// Minus (ASCII, en-dash, figure-dash, minus sign) oder Klammern.
const NEG_CHARS = '[-–−‒—]';
const GERMAN_NUMBER = new RegExp(`((?:${NEG_CHARS})?\\(?\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?\\)?)`, 'g');

function parseGermanNumber(s) {
  if (s == null) return null;
  const raw = String(s).trim();
  const neg = /^[(\-–−‒—]/.test(raw);
  const stripped = raw.replace(/[()\-–−‒—\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Extract "current year" number from a line. In two-column filings the
// reporting year is the first number; ignores the previous-year column
// which is typically given in thousands and won't match our regex anyway
// (too few digits once dots are stripped).
function firstNumberOnLine(line) {
  const matches = [...line.matchAll(GERMAN_NUMBER)];
  if (!matches.length) return null;
  return parseGermanNumber(matches[0][1]);
}

function lastNumberOnLine(line) {
  const matches = [...line.matchAll(GERMAN_NUMBER)];
  if (!matches.length) return null;
  return parseGermanNumber(matches[matches.length - 1][1]);
}

// Given a block of text, find the last line containing a valid German
// number and return that number. Used for section subtotals which are
// always the final numeric line of a §224 subtree.
function lastNumericInBlock(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = firstNumberOnLine(lines[i]);
    if (n != null) return n;
  }
  return null;
}

// Subsection subtotal. Three-tier detection (ordered by reliability):
//   1. Header-inline number — e.g. "V. Bilanzgewinn 1.784.084.803" puts the
//      total right on the heading, with "davon"-breakdowns below.
//   2. Sum of enumerated items — summing the first number on each "1. foo"/
//      "2. bar" line reproduces the subtotal regardless of whether the
//      explicit subtotal line survived OCR.
//   3. Last numeric line — fallback for sections with a single line that is
//      itself the amount (typical for RAP or Rückstellungen when aggregated).
function subsectionTotal(block) {
  if (!block) return null;
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  // Tier 1: header-inline number
  const headerNum = firstNumberOnLine(lines[0]);
  if (headerNum != null) return headerNum;
  // Tier 2: sum of enumerated items. A line "counts" as an item if an item
  // marker (`\d{1,2}[.)]` followed by whitespace) appears either at the line
  // start OR somewhere in the middle. The second case handles column-major
  // layouts where the current- and prior-year values precede the item number
  // and label (Hornbach-style: "1.637  1.394  2. Geleistete Anzahlungen").
  const itemStart    = /^[^\d\n]{0,3}\d{1,2}\s?[.)]\s/;
  const itemAnywhere = /\s\d{1,2}\s?[.)]\s/;
  const isItemLine = (line) => itemStart.test(line) || itemAnywhere.test(line);
  // A "subtotal line" is dominated by numbers (short prose, or none) — we
  // must NOT treat such a line as a continuation of the preceding item.
  const isSubtotalLine = (line) => {
    const n = firstNumberOnLine(line);
    if (n == null) return false;
    const prose = line.replace(GERMAN_NUMBER, '').replace(/[\s\-–—().,|\[\]_]/g, '').trim();
    return prose.length <= 4;
  };
  let itemSum = 0, itemCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isItemLine(lines[i])) continue;
    for (let j = i; j < Math.min(lines.length, i + 3); j++) {
      if (j > i && isItemLine(lines[j])) break;      // next item started
      if (j > i && isSubtotalLine(lines[j])) break;  // subtotal, not our value
      const n = firstNumberOnLine(lines[j]);
      if (n != null) { itemSum += n; itemCount += 1; break; }
    }
  }
  if (itemCount >= 1) return itemSum;
  // Tier 3: last numeric line (for single-line subsections)
  return lastNumericInBlock(block);
}

// Locate the indexes of each §224 section header in the Aktiva/Passiva block.
// Headers are of the form "A. ", "B. ", etc. at the start of a line. Returns
// { A: idx, B: idx, C: idx, D: idx, ... }. Unknown letters skipped.
function findTopLevelSections(text, scope) {
  const out = {};
  const re = new RegExp(`(^|\\n)\\s*(${scope})\\.\\s+([^\\n]+)`, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const letter = m[2];
    if (!out[letter]) out[letter] = m.index + (m[1] ? m[1].length : 0);
  }
  return out;
}

function findSubsections(block, scope) {
  const out = {};
  const re = new RegExp(`(^|\\n)\\s*(${scope})\\.\\s+([^\\n]+)`, 'g');
  let m;
  while ((m = re.exec(block)) !== null) {
    const rn = m[2];
    if (!out[rn]) out[rn] = m.index + (m[1] ? m[1].length : 0);
  }
  return out;
}

// OCR-friendly section detection. Instead of relying on the §224 letter
// prefix (which OCR often mangles — "A. Anlagevermögen" → "Jh. ..." etc.),
// search for the canonical German labels themselves. Returns the same shape
// as findTopLevelSections so downstream code is unchanged. Only used as a
// fallback when letter-based matching yields < 2 sections.
function findTopLevelSectionsByLabel(text, side) {
  const patterns = side === 'aktiva'
    ? { A: /Anlagevermögen/i, B: /Umlaufvermögen/i, C: /Rechnungsabgrenzungs?posten/i, D: /Aktive?\s+latente\s+Steuern/i }
    : { A: /Eigenkapital/i, B: /Unversteuerte\s+Rücklagen/i, C: /Rückstellungen/i, D: /Verbindlichkeiten/i, E: /Rechnungsabgrenzungs?posten/i };
  const out = {};
  for (const [letter, re] of Object.entries(patterns)) {
    const m = re.exec(text);
    if (m) out[letter] = m.index;
  }
  return out;
}

// Strip OCR line-noise (leading pipes, underscores, dots, repeated small
// letters that Tesseract emits at the start of scan lines). Keeps actual
// content intact.
function cleanOcrLineNoise(text) {
  return text
    .split('\n')
    .map((line) => line
      .replace(/^[\s_|\-.()\[\]\\]+/, '')        // leading punctuation/whitespace
      .replace(/^(?:n{1,3}|i{1,3}|l|h\s+nn|nn)\s+/, '') // leading Tesseract artifacts
      // Strip spurious numeric margin/column markers that Tesseract prepends:
      // - "2.2 " (page number that bled into the item line)
      // - "12... " (Anhang-Angabe column)
      .replace(/^\d+\.\d+\s+(?=\d{1,2}\s?[.)]\s)/, '')
      .replace(/^\d+\.{2,}\s+/, '')
      // Strip any residual non-word-char run (max 10 chars) that sits between
      // the start of the line and a real item marker. Catches "\ | . 2. ...".
      .replace(/^[^\w\n]{1,10}(?=\d{1,2}\s?[.)]\s)/, '')
      // OCR / font-mapping glyph repair: Tesseract and some PDF encoders emit
      // accented/combining characters where a leading "1" should be ("ì", "í").
      // Only fix when the glyph is adjacent to a German-format number with one
      // digit missing up front — keeps false positives low.
      .replace(/(^|\s)[ìíîï]\s?(\d{2}\.\d{3}(?:\.\d{3})*)/g, '$11$2')
      // OCR comma-dot swap within thousand-separated numbers: "5,386.761,55"
      // should be "5.386.761,55". Detect: a single digit + comma + 3-digit
      // group + dot + 3-digit group (German decimal comes LAST).
      .replace(/(\s|^)(\d{1,3}),(\d{3}\.\d{3}(?:\.\d{3})*(?:,\d+)?)/g, '$1$2.$3')
      // OCR space-separated thousands: some scans output "63 599 592,17"
      // where the source actually had "63.599.592,17". Only normalise when
      // we have ≥2 space-groups of exactly 3 digits AND the whole run is
      // bounded by a word boundary — prevents mangling "Seite 12 von 23".
      .replace(/\b(\d{1,3}(?:\s\d{3}){2,}(?:,\d+)?)\b/g, (m) => m.replace(/\s+/g, '.'))
      .replace(/\b(\d{1,3}(?:\s\d{3}){1,}),(\d+)\b/g, (_, i, d) => i.replace(/\s+/g, '.') + ',' + d)
      .replace(/\s+(\d{1,3}(?:\.\d{3})+(?:,\d+)?)\s*$/, ' $1'), // collapse trailing ws
    )
    .join('\n');
}

// Slice a [start, end) body from the text, using the next-section index as
// the end. When `end` is null, take everything to the block's end.
function sliceBody(text, start, end) {
  return text.slice(start, end == null ? text.length : end);
}

/** Parse the Aktiva section. Returns `{ total, anlagevermoegen, umlaufvermoegen, rechnungsabgrenzung }`. */
function parseAktiva(aktivaText) {
  let sections = findTopLevelSections(aktivaText, '[ABCDE]');
  // Use label-based detection whenever A (Anlagevermögen) isn't cleanly
  // detected — OCR commonly mangles "A." into "Jh." or similar, and some
  // PDF text extractions put "A." just before the slice start so only B/C/D
  // match via letter prefix.
  if (!sections.A) {
    sections = findTopLevelSectionsByLabel(aktivaText, 'aktiva');
  }
  const order = Object.keys(sections).sort((a, b) => sections[a] - sections[b]);
  const bodies = {};
  for (let i = 0; i < order.length; i++) {
    const letter = order[i];
    const startIdx = sections[letter];
    const nextIdx = i + 1 < order.length ? sections[order[i + 1]] : aktivaText.length;
    bodies[letter] = sliceBody(aktivaText, startIdx, nextIdx);
  }

  // A = Anlagevermögen (with sub I/II/III = immat/sach/finanz)
  const av = bodies.A ? parseAnlagevermoegen(bodies.A) : null;
  // B = Umlaufvermögen
  const uv = bodies.B ? parseUmlaufvermoegen(bodies.B) : null;
  // C = Rechnungsabgrenzungsposten (can be single-line)
  const rap = bodies.C ? lastNumericInBlock(bodies.C) : null;

  return {
    total: null, // caller fills from Bilanzsumme line
    anlagevermoegen: av,
    umlaufvermoegen: uv,
    rechnungsabgrenzung: rap,
  };
}

function parseAnlagevermoegen(block) {
  // Important: extract sub-positions from the ORIGINAL block first. Stripping
  // a "parent total" up-front is unreliable on OCR'd scans that often drop
  // the explicit subtotal line — we'd end up removing the last child's own
  // subtotal line instead.
  const slots = extractLabeledSubsections(block, [
    { key: 'immaterielle',  re: /Immaterielle\s+Vermögensgegenstände/i },
    { key: 'sachanlagen',   re: /Sachanlagen/i },
    { key: 'finanzanlagen', re: /Finanzanlagen/i },
  ]);
  return {
    total: sumChildrenOrDetected(block, [slots.immaterielle, slots.sachanlagen, slots.finanzanlagen]),
    immaterielle:  slots.immaterielle,
    sachanlagen:   slots.sachanlagen,
    finanzanlagen: slots.finanzanlagen,
  };
}

// Parent total = sum of detected children if we have ≥ 2 of them; otherwise
// fall back to the trailing numeric line. Drops dependence on the explicit
// subtotal-line heuristic (which OCR scans often lose).
function sumChildrenOrDetected(block, children) {
  const present = children.filter((x) => x != null);
  const detected = lastNumericInBlock(block);
  if (present.length >= 2) return present.reduce((a, b) => a + b, 0);
  return detected;
}

// Guard against OCR subtotal-line drop-outs. If the "detected" parent equals
// (or closely matches) a single sub-position, we assume parent extraction
// picked up the last sub-position's number by mistake — recompute as the
// sum of the sub-positions we do have. Returns null only if both paths
// yield nothing, so downstream confidence can still downgrade.
function sanitizeParentTotal(detected, children) {
  const present = children.filter((x) => x != null);
  if (!present.length) return detected;
  const sum = present.reduce((a, b) => a + b, 0);
  if (detected == null) return sum;
  // If detected matches one child within 0.5%, it's almost certainly the
  // child itself bleeding through — switch to sum.
  for (const child of present) {
    if (child === 0) continue;
    if (Math.abs(detected - child) / child < 0.005) return sum;
  }
  return detected;
}

function parseUmlaufvermoegen(block) {
  const [body, parentTotal] = splitOffParentTotal(block);
  const slots = extractLabeledSubsections(body, [
    { key: 'vorraete',      re: /Vorräte/i },
    { key: 'forderungen',   re: /Forderungen(?!\s*gegen)/i },
    { key: 'wertpapiere',   re: /Wertpapiere(?:\s+und\s+Anteile)?/i },
    { key: 'kassenbestand', re: /Kassenbestand|Guthaben\s+bei\s+Kreditinst/i },
  ]);
  const children = [slots.vorraete, slots.forderungen, slots.wertpapiere, slots.kassenbestand];
  const detected = parentTotal ?? lastNumericInBlock(block);
  return {
    total: sanitizeParentTotal(detected, children),
    vorraete:      slots.vorraete,
    forderungen:   slots.forderungen,
    wertpapiere:   slots.wertpapiere,
    kassenbestand: slots.kassenbestand,
  };
}

// Common engine for label-based subsection extraction. For each slot we
// locate the first match, then bound the slot's body by the next slot's
// start. The subsection total is read via `subsectionTotal` — which prefers
// an inline number on the header line, else the last numeric line in the body.
function extractLabeledSubsections(text, slots) {
  const withIdx = slots
    .map((s) => {
      const m = s.re.exec(text);
      return m ? { ...s, idx: m.index } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx);
  const out = {};
  for (let i = 0; i < withIdx.length; i++) {
    const cur = withIdx[i];
    const next = withIdx[i + 1];
    const sub = text.slice(cur.idx, next ? next.idx : text.length);
    out[cur.key] = subsectionTotal(sub);
  }
  return out;
}

// Trim the trailing "parent subtotal" numeric line from a top-level section
// block so that the last sub-section does not accidentally swallow it when
// its total is computed. Returns `[bodyWithoutParentTotal, parentTotal]`.
// A parent subtotal is detected as the final numeric-only line of the block.
// Page markers (`-- 4 of 59 --`), continuation headers ("Geschäftsbericht ..."),
// and blank lines are skipped; we only commit once we hit a line that is
// essentially just German numbers.
// Parse the Gewinn- und Verlustrechnung (GuV) from the raw text. Austrian
// §231 UGB GuVs are numbered (1./2./...) with standardised Zwischensummen.
// We match by label rather than number since some filers skip positions and
// renumber. Returns the values we surface through the public API: Umsatz,
// Betriebsergebnis, Jahresüberschuss, plus the two Bilanzgewinn children.
function parseGuv(text) {
  const guvStart = text.search(/Gewinn-\s*und\s*Verlustrechnung/);
  if (guvStart < 0) return null;
  // Cap the search at ~6k chars (the GuV table is always short) to avoid
  // matching unrelated text later in the Anhang.
  const guv = text.slice(guvStart, guvStart + 8000);

  const firstMatch = (re) => {
    const m = guv.match(re);
    if (!m) return null;
    return firstNumberOnLine(m[0]);
  };
  return {
    umsatzerloese:    firstMatch(/Umsatzerlöse[^\n]+/),
    betriebsergebnis: firstMatch(/(?:Betriebsergebnis|Betriebserfolg)[^\n]*[-–−]?\s*[\d.,]+/),
    jahresergebnis:   firstMatch(/(?:Jahresüberschuss|Jahresfehlbetrag|Jahresergebnis)[^\n]+/),
    gewinnvortrag:    firstMatch(/(?:Gewinnvortrag|Verlustvortrag)\s+(?:aus\s+dem\s+Vorjahr)?[^\n]+/),
    bilanzgewinn:     firstMatch(/(?:Bilanzgewinn|Bilanzverlust)(?![a-zäöü])[^\n]+/),
  };
}

// Pull the Bilanzstichtag from common cover-page phrasings:
//   "Jahresabschluss zum 31. Dezember 2024"
//   "Bilanz zum 30.06.2024"
// Returns an ISO date string (YYYY-MM-DD) or null.
const GERMAN_MONTHS = {
  januar: '01', februar: '02', maerz: '03', 'mÃ¤rz': '03', 'märz': '03',
  april: '04', mai: '05', juni: '06', juli: '07', august: '08',
  september: '09', oktober: '10', november: '11', dezember: '12',
};
function extractStichtag(text) {
  // Format 1: "31. Dezember 2024"
  const m1 = text.match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})/);
  if (m1) {
    const month = GERMAN_MONTHS[m1[2].toLowerCase()];
    if (month) return `${m1[3]}-${month}-${m1[1].padStart(2, '0')}`;
  }
  // Format 2: "31.12.2024" or "30.06.2024"
  const m2 = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return null;
}

function splitOffParentTotal(block) {
  const lines = block.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const firstN = firstNumberOnLine(line);
    if (firstN == null) continue; // no number — pagination/header, skip
    const nonNumeric = line.replace(GERMAN_NUMBER, '').replace(/[\s\-–—().,|\[\]_]/g, '').trim();
    // Accept pure-numeric lines as subtotals. Allow up to 4 residual letters
    // to tolerate OCR artifacts like "nn]" or "nm" that commonly appear as
    // gutter-bleed from scanned documents.
    if (nonNumeric.length > 4) continue;
    const bodyLines = lines.slice(0, i);
    return [bodyLines.join('\n'), firstN];
  }
  return [block, null];
}

function parsePassiva(passivaText) {
  let sections = findTopLevelSections(passivaText, '[ABCDEF]');
  // Same fallback rule as parseAktiva: require A (Eigenkapital) to be
  // cleanly detected, else use label-based section boundaries.
  if (!sections.A) {
    sections = findTopLevelSectionsByLabel(passivaText, 'passiva');
  }
  const order = Object.keys(sections).sort((a, b) => sections[a] - sections[b]);
  const bodies = {};
  for (let i = 0; i < order.length; i++) {
    const letter = order[i];
    const start = sections[letter];
    const next = i + 1 < order.length ? sections[order[i + 1]] : passivaText.length;
    bodies[letter] = sliceBody(passivaText, start, next);
  }
  // A = Eigenkapital, B = Rückstellungen (sometimes UVR before it), C/D = Verbindlichkeiten, last = RAP.
  // Some filings have B=unversteuerte Rücklagen, C=Rückstellungen, D=Verbindlichkeiten.
  // Dispatch by header text to be robust.
  const mapped = { eigenkapital: null, rueckstellungen: null, verbindlichkeiten: null, rechnungsabgrenzung: null, unversteuerteRuecklagen: null };
  let ekBlock = null;
  for (const letter of order) {
    const body = bodies[letter];
    const firstLine = body.split('\n')[0].toLowerCase();
    // Use item-sum subsectionTotal so sections with enumerated items and a
    // missing-on-OCR explicit subtotal line still produce correct parent totals.
    const amount = subsectionTotal(body);
    if (firstLine.includes('eigenkapital'))                      { mapped.eigenkapital = amount; ekBlock = body; }
    else if (firstLine.includes('unversteuert'))                 mapped.unversteuerteRuecklagen = amount;
    else if (firstLine.includes('rückstell') || firstLine.includes('rueckstell')) mapped.rueckstellungen = amount;
    else if (firstLine.includes('verbindlich'))                  mapped.verbindlichkeiten = amount;
    else if (firstLine.includes('rechnungsabgrenz'))             mapped.rechnungsabgrenzung = amount;
  }

  // Eigenkapital-Breakdown: I=Grundkapital, II=Kapitalrücklagen, III=Gewinnrücklagen, IV=Bilanzgewinn.
  // Some large corporates file additional intermediate positions (e.g. "Rücklage für anteilsbasierte Vergütungen")
  // between II and the rest — dispatch by text rather than position.
  let ekBreakdown = { stammkapital: null, kapitalruecklagen: null, gewinnruecklagen: null, bilanzgewinn: { total: null, gewinnvortrag: null, jahresueberschuss: null } };
  if (ekBlock) {
    // Strip the EK subtotal from the block before diving into sub-sections,
    // otherwise the last sub-section swallows it (same issue as top-level).
    const [ekBody, ekTotalFromTail] = splitOffParentTotal(ekBlock);
    if (ekTotalFromTail != null) mapped.eigenkapital = ekTotalFromTail;
    const ekSubs = findSubsections(ekBody, '(?:I|II|III|IV|V|VI)');
    const ekOrder = Object.keys(ekSubs).sort((a, b) => ekSubs[a] - ekSubs[b]);
    for (let i = 0; i < ekOrder.length; i++) {
      const rn = ekOrder[i];
      const start = ekSubs[rn];
      const next = i + 1 < ekOrder.length ? ekSubs[ekOrder[i + 1]] : ekBody.length;
      const body = sliceBody(ekBody, start, next);
      const firstLine = body.split('\n')[0].toLowerCase();
      const amount = subsectionTotal(body);
      if (firstLine.includes('grundkapital') || firstLine.includes('stammkapital') || firstLine.includes('nennkapital')) ekBreakdown.stammkapital = amount;
      else if (firstLine.includes('kapitalrück') || firstLine.includes('kapitalruec')) ekBreakdown.kapitalruecklagen = amount;
      else if (firstLine.includes('gewinnrück') || firstLine.includes('gewinnruec')) ekBreakdown.gewinnruecklagen = amount;
      else if (firstLine.includes('bilanzgewinn') || firstLine.includes('bilanzverlust')) {
        ekBreakdown.bilanzgewinn.total = amount;
        // Try to split into Gewinnvortrag / Jahresüberschuss by header text in body.
        const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const ln of lines) {
          const lc = ln.toLowerCase();
          const n = firstNumberOnLine(ln);
          if (n == null) continue;
          if (lc.startsWith('1.') && (lc.includes('gewinnvortrag') || lc.includes('verlustvortrag'))) ekBreakdown.bilanzgewinn.gewinnvortrag = n;
          else if (lc.startsWith('2.') && (lc.includes('jahresüberschuss') || lc.includes('jahresueberschuss') || lc.includes('jahresfehlbetrag'))) ekBreakdown.bilanzgewinn.jahresueberschuss = n;
        }
      }
    }
  }

  return {
    total: null,
    eigenkapital: { total: mapped.eigenkapital, ...ekBreakdown },
    unversteuerteRuecklagen: mapped.unversteuerteRuecklagen,
    rueckstellungen: mapped.rueckstellungen,
    verbindlichkeiten: { total: mapped.verbindlichkeiten, langfristig: null },
    rechnungsabgrenzung: mapped.rechnungsabgrenzung,
  };
}

/**
 * Parse an Austrian §224-UGB PDF-Jahresabschluss. Returns a balance-sheet
 * row with `source: 'pdf-heuristic'` and a `confidence` score (0..1) based
 * on how many sections we successfully extracted. Callers should surface
 * the heuristic nature of the data to users.
 */
export async function parsePdfBilanz(pdfBytes, stichtag) {
  let text = '';
  try {
    const r = await new PDFParse({ data: pdfBytes }).getText();
    text = r?.text || '';
  } catch {
    return null;
  }
  if (!text || text.length < 500) return null;

  return parseBilanzFromText(text, stichtag);
}

/**
 * Parse already-extracted text (either from the PDF text layer or from OCR).
 * Exposed so the OCR pipeline can re-use all the §224/§231 logic without
 * duplicating it.
 */
export function parseBilanzFromText(rawText, stichtag) {
  // Normalise OCR line-noise up-front so later regexes see clean headers.
  let text = cleanOcrLineNoise(rawText);

  // Prefer the Bilanzstichtag extracted from the PDF itself over the metadata
  // date passed by the caller (which is the Einreichungsdatum for PDFs — the
  // day the filing was submitted, not the period end).
  stichtag = extractStichtag(text) || stichtag;

  // Locate the Aktiva / Passiva blocks. OMV uses explicit headers "Bilanz Aktiva"
  // and "Bilanz Passiva"; other filers sometimes label them "Aktiva" / "Passiva"
  // on a single line or embed the table into the report body. OCR may mangle
  // the header itself (A1's scanned PDF produces "Bktiva" instead of "Aktiva")
  // — in that case fall back to the first "Anlagevermögen"/"Eigenkapital" hit.
  // Strongest markers first (unambiguous table headings):
  //   1. "Bilanz Aktiva" heading
  //   2. "AKTIVA" alone on a line
  //   3. "A. Anlagevermögen" at a line start (formal §224 heading)
  //   4. loose "Anlagevermögen" fallback — must be avoided when there's a
  //      table of contents in front of the Bilanz (Verbund has dozens of
  //      TOC mentions of "Anlagevermögen" before the real section).
  let aktivaStart = text.search(/\bBilanz\s*Aktiva\b|^AKTIVA\b/m);
  if (aktivaStart < 0) aktivaStart = text.search(/^\s*A\.\s+Anlagevermögen/m);
  if (aktivaStart < 0) aktivaStart = text.search(/Anlagevermögen/i);
  // "PASSIVA" may start a line followed immediately by the Bilanzsumme on
  // the same line (Infineon style). Match the token at a line start regardless
  // of what trails it.
  let passivaStart = text.search(/\bBilanz\s*Passiva\b|^PASSIVA\b/m);
  if (passivaStart < 0) {
    const searchFrom = aktivaStart >= 0 ? aktivaStart + 50 : 0;
    // Prefer formal "A. Eigenkapital" heading over loose word match to avoid
    // catching in-prose mentions (Anhang, Notes).
    const m1 = /^\s*A\.\s+Eigenkapital/m.exec(text.slice(searchFrom));
    const m2 = /Eigenkapital/i.exec(text.slice(searchFrom));
    if (m1) passivaStart = searchFrom + m1.index;
    else if (m2) passivaStart = searchFrom + m2.index;
  }
  if (aktivaStart < 0 || passivaStart < 0 || passivaStart <= aktivaStart) return null;

  const aktivaText = text.slice(aktivaStart, passivaStart);
  // Passiva ends at the G&V section or a genuine "Anhang" heading (not the
  // column header "Anhangangabe"). On OCR'd scans the explicit "Gewinn- und
  // Verlustrechnung" heading is sometimes lost, so we also detect the start
  // of the GuV by the canonical §231 UGB opening items ("Umsatzerlöse",
  // "Betriebsergebnis" Zwischensumme, etc.).
  const passivaBody = text.slice(passivaStart);
  const passivaEnd = passivaBody.search(/Gewinn-\s*und\s*Verlustrechnung|^Anhang\b|Umsatzerlöse|Betriebserfolg|Zwischensumme\s+aus\s+Z\s*\d+\s+bis/m);
  const passivaText = passivaEnd > 0
    ? passivaBody.slice(0, passivaEnd)
    : passivaBody;

  // Strip the trailing Bilanzsumme line from Aktiva (clean two-number-line
  // style). For Passiva we pass the full text — splitOffParentTotal can't
  // reliably distinguish the Rückst subtotal from the Bilanzsumme on OCR'd
  // pages where mid-block punctuation varies. Passiva sub-parsers are now
  // fully label-based, so including more content is safe.
  const [aktivaInner, aktivaTotal] = splitOffParentTotal(aktivaText);
  const passivaInner = passivaText;

  const aktiva = parseAktiva(aktivaInner);
  const passiva = parsePassiva(passivaInner);
  const guv = parseGuv(text);

  // Fill Bilanzgewinn breakdown from the GuV when the balance-sheet section
  // didn't surface it (most filers show only the total BG in the Passiva and
  // put the split at the very end of the GuV: "17. Jahresüberschuss",
  // "18. Gewinnvortrag", "19. Bilanzgewinn").
  if (guv && passiva.eigenkapital) {
    const bg = passiva.eigenkapital.bilanzgewinn || (passiva.eigenkapital.bilanzgewinn = { total: null, gewinnvortrag: null, jahresueberschuss: null });
    if (bg.total == null)             bg.total = guv.bilanzgewinn;
    if (bg.gewinnvortrag == null)     bg.gewinnvortrag = guv.gewinnvortrag;
    if (bg.jahresueberschuss == null) bg.jahresueberschuss = guv.jahresergebnis;
  }

  // Bilanzsumme: prefer the explicitly extracted Aktiva total. If OCR dropped
  // that line (common for scanned JAbs with faded print), synthesize it as
  // the sum of the top Aktiva sections. Reject the detected value if it's
  // smaller than any individual section — that's almost certainly a
  // sub-section bleed-through.
  const sectionSum = [aktiva.anlagevermoegen?.total, aktiva.umlaufvermoegen?.total, aktiva.rechnungsabgrenzung]
    .filter((x) => x != null)
    .reduce((a, b) => a + b, 0);
  let bilanzsumme = aktivaTotal;
  const maxSection = Math.max(aktiva.anlagevermoegen?.total ?? 0, aktiva.umlaufvermoegen?.total ?? 0);
  if (bilanzsumme == null || bilanzsumme < maxSection) bilanzsumme = sectionSum || bilanzsumme;
  aktiva.total = bilanzsumme;
  passiva.total = bilanzsumme;

  // Unit scaling. Many non-BMF filings present numbers in thousands of euros
  // (header "in T€", "TEUR", or "in Tausend"). Our §224 parser reads raw
  // integers as EUR, so a €1 Mrd filing surfaces as "1.000.526". Detect the
  // unit around the RESOLVED aktiva start (not a TOC false-match) so we
  // actually see the column header.
  const scale = detectUnitScale(text, aktivaStart);
  if (scale !== 1) {
    scaleBalanceSheet({ aktiva, passiva }, scale);
    bilanzsumme = bilanzsumme * scale;
  }

  // Confidence: fraction of the canonical top-level slots that were populated.
  const slots = [
    aktiva.anlagevermoegen?.total,
    aktiva.umlaufvermoegen?.total,
    passiva.eigenkapital?.total,
    passiva.rueckstellungen,
    passiva.verbindlichkeiten?.total,
    bilanzsumme,
  ];
  const filled = slots.filter((x) => x != null).length;
  const confidence = filled / slots.length;
  if (confidence < 0.5) return null; // too patchy to be useful

  // Sanity check: the balance sheet equation must hold at least approximately.
  // If the detected Bilanzsumme is smaller than Eigenkapital, or than any
  // major asset/liability, we've clearly mis-identified something — reject
  // rather than surface nonsense to the UI. Common on OCR runs that find
  // "Anlagevermögen"/"Eigenkapital" as prose in the Anhang but no table.
  const ekTotal = passiva.eigenkapital?.total ?? 0;
  const maxPosition = Math.max(
    aktiva.anlagevermoegen?.total ?? 0,
    aktiva.umlaufvermoegen?.total ?? 0,
    ekTotal,
    passiva.verbindlichkeiten?.total ?? 0,
  );
  if (bilanzsumme != null && maxPosition > 0 && bilanzsumme < maxPosition * 0.9) {
    return null;
  }

  // After `scaleBalanceSheet`, `aktiva.total`/`passiva.*.total` already carry
  // the correct magnitude. Re-read `bilanzsumme` and the top-level numeric
  // fields from the scaled tree plus apply the same factor to GuV numbers
  // (Umsatz/Betriebsergebnis/Jahresergebnis come from a parallel parse).
  const bsFinal = aktiva.total ?? bilanzsumme;
  const ekFinal = passiva.eigenkapital?.total ?? null;
  const jeFinal = (guv?.jahresergebnis != null ? guv.jahresergebnis * scale : null)
    ?? passiva.eigenkapital?.bilanzgewinn?.jahresueberschuss ?? null;
  const umsatzFinal = guv?.umsatzerloese != null ? guv.umsatzerloese * scale : null;
  const betriebsFinal = guv?.betriebsergebnis != null ? guv.betriebsergebnis * scale : null;

  return {
    stichtag,
    currency: 'EUR',
    umsatzerloese: umsatzFinal,
    bilanzsumme: bsFinal,
    eigenkapital: ekFinal,
    jahresergebnis: jeFinal,
    betriebsergebnis: betriebsFinal,
    arbeitnehmer: null,
    ek_quote: (bsFinal && ekFinal != null) ? ekFinal / bsFinal : null,
    balanceSheet: { aktiva, passiva },
    source: 'pdf-heuristic',
    confidence,
  };
}

// Detect the reporting unit of the CURRENT-YEAR column in the Aktiva/Passiva
// table. Returns 1 for EUR, 1000 for T€/TEUR, 1_000_000 for Mio€. The
// subtlety: two-column filings often mix units (current year in EUR, prior
// year in T€) — since we extract the first number on each line (the current
// year), we must only apply the unit that governs THAT column.
function detectUnitScale(text, aktivaStart) {
  if (aktivaStart == null || aktivaStart < 0) return 1;
  // Column-header tokens ("T€", "EUR") often appear BEFORE the first real
  // section heading — between "Bilanz zum ..." and "A. Anlagevermögen".
  // Widen the window to include up to 400 chars BEFORE and 500 AFTER.
  const from = Math.max(0, aktivaStart - 400);
  const header = text.slice(from, aktivaStart + 500);
  // Find the first standalone EUR token and first T€/TEUR token positions.
  // The token that appears FIRST (closest to the section header) governs
  // the current-year column — filings put column headers left-to-right with
  // current year first. Match "EUR" only with word boundaries so "TEUR"
  // doesn't trigger the EUR branch by accident.
  const eurMatch  = /\bEUR\b/.exec(header);
  const teurMatch = /\bT€|\bTEUR\b|in\s+Tausend(?:\s+Euro)?|\bTsd\.?\s*€?|in\s+Tsd/i.exec(header);
  const mioMatch  = /\bMio\.?\s*€|\bMio\.?\s+EUR\b/i.exec(header);
  if (mioMatch && (!eurMatch || mioMatch.index < eurMatch.index)) return 1_000_000;
  if (teurMatch && (!eurMatch || teurMatch.index < eurMatch.index)) return 1_000;
  return 1;
}

// Multiply every numeric field in the balance sheet tree by a constant.
function scaleBalanceSheet(bs, factor) {
  const scale = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') obj[k] = v * factor;
      else if (v && typeof v === 'object') scale(v);
    }
  };
  scale(bs);
}
