// OCR-Pipeline für gescannte österreichische Jahresabschlüsse.
//
// Architektur:
//   PDF bytes  ─► pdftoppm (poppler, 200 DPI PNG pro Seite)
//              ─► tesseract (deu Sprachmodell, stdin/stdout)
//              ─► rohen Text concat
//              ─► parseBilanzFromText (bestehender §224-Parser)
//
// Warum poppler+tesseract als System-Binaries: tesseract.js/WASM ist 2–3×
// langsamer bei gleicher Qualität, und die Nutzer werden den OCR-Pfad nur
// für gescannte Alt-JAbs brauchen — ein einmaliger brew-install rechnet sich.
//
// Tesseract-Quirk: Leptonica (die Image-Library darunter) scheitert an
// Dateipfaden, die aus Arbeitsverzeichnissen mit Leerzeichen aufgelöst
// werden. Wir umgehen das, indem wir PNG-Bytes via stdin füttern.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TESSERACT_PSM_DEFAULT = '6'; // Uniform block — fastest & accurate for text-heavy pages
const TESSERACT_PSM_FALLBACK = '3'; // Fully automatic page segmentation — better for table/multi-column layouts
const PDFTOPPM_DPI  = '300';   // 200 drops subtotal lines on some scans
const SCAN_DETECT_THRESHOLD = 2000; // < 2000 chars extractable = likely scanned
// Three-tier batch strategy trades latency against coverage. The Bilanz
// position varies wildly by filer:
//   BATCH_1: pp 1..N       — A1, OMV have it up front
//   BATCH_2: pp N..M       — Deloitte-style Prüfungsbericht prefix (Magna)
//   BATCH_3: pp M..K       — long Lagebericht before Bilanz (Wolford, EVN)
const BATCH_1 = 10;
const BATCH_2 = 20;
const BATCH_3 = 40;
// OCR concurrency — Tesseract is mostly single-threaded per-page, but we
// have cores idle while waiting. Running pages in parallel cuts total time
// nearly linearly with core count. Capped to avoid thrashing the CPU.
const OCR_PARALLELISM = Math.max(2, Math.min(6, (os.cpus()?.length || 4) - 1));
// Hard ceiling per page so a single very-dense page can't hold the whole
// request hostage.
const TESSERACT_TIMEOUT_MS = 45000;
const PDFTOPPM_TIMEOUT_MS  = 180000;
// Strong Bilanz-table markers — an ACTUAL tabular balance sheet (not just a
// mention of the words in the Anhang/commentary text). Must catch the table
// heading style used across §224 UGB filings.
const BILANZ_MARKERS = /Bilanz\s*Aktiva|Bilanz\s*Passiva|^\s*AKTIVA\s*$|^\s*PASSIVA\b|^\s*A\.\s+Anlagevermögen/im;

/**
 * Returns true if a PDF has a meaningful text layer (enough extractable
 * characters for our §224 parser). Used to gate the expensive OCR path.
 */
export function looksLikeScannedPdf(extractedText) {
  return !extractedText || extractedText.length < SCAN_DETECT_THRESHOLD;
}

// Bilanz-table detection markers per language. For FR, we look for tell-
// tale compte-annuels table headings ("BILAN ACTIF", "TOTAL ACTIF", "Capitaux
// propres"). OCR is slow — aborting once we've found the balance sheet saves
// significant time on long corporate filings.
// Bilan-table markers for FR. Used to decide "we've OCR'd enough pages".
// Must appear in tabular context, not prose — "capitaux propres" alone is
// too common in annexes and AGM extracts, so we require structural totals.
const FR_BILANZ_MARKERS = /BILAN\s+ACTIF|BILAN\s+PASSIF|TOTAL\s+DE\s+L['\u2019]ACTIF|TOTAL\s+DU\s+PASSIF|TOTAL\s+ACTIFS?\b|TOTAL\s+GÉNÉRAL|Compte\s+de\s+r[ée]sultat/i;

/**
 * Run OCR on a PDF, return concatenated text. Three-tier batch strategy with
 * concurrent per-page OCR: start with pages 1..BATCH_1, escalate to BATCH_2
 * if no Bilanz markers, then BATCH_3 as last resort. Pages within a batch
 * are OCR'd in parallel for near-linear speedup on multi-core hosts.
 *
 * `opts.lang` selects the Tesseract language model ('deu' by default, 'fra'
 * for French filings). `opts.markers` overrides the table-end detector —
 * defaults to the AT-German §224 markers for backward compat.
 */
export async function ocrPdf(pdfBytes, opts = {}) {
  const {
    lang = 'deu',
    markers = BILANZ_MARKERS,
    batch1 = BATCH_1,
    batch2 = BATCH_2,
    batch3 = BATCH_3,
    // Minimum marker matches required to call the batch "sufficient".
    // Glossy annual reports quote structural labels in the TOC and the
    // CEO letter before the actual Balance Sheet — 1 match is a false
    // positive. The true statement section repeats the label many times
    // (row totals, section headers, note references), so 3+ hits is a
    // reliable signal.
    markerThreshold = 1,
  } = opts;
  const meets = (txt) => (txt.match(markers) || []).length >= markerThreshold;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kontur-ocr-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    await (await import('node:fs/promises')).writeFile(pdfPath, pdfBytes);
    await runPdftoppm(pdfPath, path.join(dir, 'p'), 1, batch3);
    const pages = await listPages(dir);

    const out1 = await ocrPages(pages.slice(0, batch1), TESSERACT_PSM_DEFAULT, lang);
    if (meets(out1)) return out1;

    const out2 = await ocrPages(pages.slice(batch1, batch2), TESSERACT_PSM_DEFAULT, lang);
    const combined12 = out1 + '\n\n' + out2;
    if (meets(combined12)) return combined12;

    const out3 = await ocrPages(pages.slice(batch2, batch3), TESSERACT_PSM_DEFAULT, lang);
    const combined123 = combined12 + '\n\n' + out3;
    if (meets(combined123)) return combined123;

    const retry = await ocrPages(pages.slice(0, batch2), TESSERACT_PSM_FALLBACK, lang);
    if (meets(retry)) return retry;
    return combined123;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Convenience wrapper for French bilan filings. */
export async function ocrPdfFr(pdfBytes) {
  return ocrPdf(pdfBytes, { lang: 'fra', markers: FR_BILANZ_MARKERS });
}

// UK / Companies House table markers — used to stop the OCR escalation
// once we've hit an actual Balance Sheet / Profit & Loss section. Avoids
// running all 80 pages on a 200-page annual report when the statements
// fit on pages 40-60.
const UK_BILANZ_MARKERS = /Balance\s+Sheet|Statement\s+of\s+Financial\s+Position|Profit\s+and\s+Loss\s+Account|Income\s+Statement|Total\s+assets|Total\s+equity|Net\s+assets\b/i;

/** Convenience wrapper for UK Companies House filings. Larger batches
 *  than the default because listed-company glossy reports typically
 *  bury the Balance Sheet after page 100; markerThreshold=3 prevents an
 *  early exit on a single mention of "balance sheet" in the table of
 *  contents or CEO letter.
 */
export async function ocrPdfUk(pdfBytes) {
  return ocrPdf(pdfBytes, {
    lang: 'eng', markers: UK_BILANZ_MARKERS,
    batch1: 20, batch2: 60, batch3: 140,
    markerThreshold: 3,
  });
}

async function ocrPages(pagePaths, psm = TESSERACT_PSM_DEFAULT, lang = 'deu') {
  const out = new Array(pagePaths.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(OCR_PARALLELISM, pagePaths.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= pagePaths.length) return;
        const bytes = await readFile(pagePaths[i]);
        out[i] = await runTesseract(bytes, psm, lang);
      }
    }),
  );
  return out.join('\n\n');
}

function runPdftoppm(pdfPath, outPrefix, firstPage, lastPage) {
  return new Promise((resolve, reject) => {
    const p = spawn('pdftoppm', [
      '-r', PDFTOPPM_DPI,
      '-f', String(firstPage), '-l', String(lastPage),
      '-png', pdfPath, outPrefix,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), PDFTOPPM_TIMEOUT_MS);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`pdftoppm exit ${code}: ${err}`));
    });
  });
}

async function listPages(dir) {
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(dir);
  return files
    .filter((f) => /^p-\d+\.png$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function runTesseract(pngBytes, psm = TESSERACT_PSM_DEFAULT, lang = 'deu') {
  return new Promise((resolve) => {
    const p = spawn('tesseract', ['stdin', 'stdout', '-l', lang, '--psm', psm], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), TESSERACT_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    // Always resolve with whatever we got — a tesseract failure on one page
    // shouldn't abort the whole OCR run. Downstream parser can handle noise.
    p.on('error', () => { clearTimeout(timer); resolve(''); });
    p.on('close', () => { clearTimeout(timer); resolve(out); });
    p.stdin.end(pngBytes);
  });
}
