// Austria — Firmenbuch via JustizOnline IWG SOAP.
// Endpoint: POST https://justizonline.gv.at/jop/api/at.gv.justiz.fbw/ws
// Auth:     X-API-KEY header with IWG token (process.env.FIRMENBUCH_TOKEN)
// License:  IWG Nutzungsbedingungen — https://justizonline.gv.at/jop/web/iwg/terms
//           (commercial use allowed; explicit "kein amtlicher Auszug"-hint required)
//
// Current scope (phase B/1): SUCHEFIRMA (search) only. getCompany() returns null
// so the server falls back to the DB-cached record from a prior search. Full
// AUSZUG_V2 (with correct UMFANG enum — not documented publicly) is a TODO.
import https from 'node:https';
import { XMLParser } from 'fast-xml-parser';
import { makeDTO, AdapterError } from './base.js';
import { parseJAb } from '../jab-parser.js';
import { parsePdfBilanz, parseBilanzFromText } from '../pdf-bilanz-parser.js';
import { ocrPdf, looksLikeScannedPdf } from '../pdf-ocr.js';
import { PDFParse } from 'pdf-parse';
import { readOcrText, writeOcrText } from '../normalize.js';

const HOST = 'justizonline.gv.at';
const PATH = '/jop/api/at.gv.justiz.fbw/ws';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 15000;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

function soapRequest(xml) {
  return new Promise((resolve, reject) => {
    const token = process.env.FIRMENBUCH_TOKEN;
    if (!token) return reject(new AdapterError('AT', 'FIRMENBUCH_TOKEN missing in .env', { status: 503 }));
    const body = Buffer.from(xml, 'utf8');
    const req = https.request(
      {
        host: HOST, path: PATH, method: 'POST',
        headers: {
          'X-API-KEY': token,
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': body.length,
          'User-Agent': UA,
          Accept: 'application/soap+xml',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('AT', `HTTP ${res.statusCode}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          const parsed = parser.parse(raw);
          const fault = parsed?.Envelope?.Body?.Fault;
          if (fault) {
            const msg = fault.Reason?.Text || fault.faultstring || JSON.stringify(fault);
            return reject(new AdapterError('AT', `SOAP fault: ${msg}`, { status: 502 }));
          }
          resolve(parsed?.Envelope?.Body);
        });
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('AT', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('AT', err.message, { cause: err })),
    );
    req.write(body);
    req.end();
  });
}

function xmlEscape(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function buildSearchEnvelope(term) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
  xmlns:suc="ns://firmenbuch.justiz.gv.at/Abfrage/SucheFirmaRequest">
  <soap:Header/>
  <soap:Body>
    <suc:SUCHEFIRMAREQUEST>
      <suc:FIRMENWORTLAUT>${xmlEscape(term)}</suc:FIRMENWORTLAUT>
      <suc:EXAKTESUCHE>false</suc:EXAKTESUCHE>
      <suc:SUCHBEREICH>1</suc:SUCHBEREICH>
      <suc:GERICHT></suc:GERICHT>
      <suc:RECHTSFORM></suc:RECHTSFORM>
      <suc:RECHTSEIGENSCHAFT></suc:RECHTSEIGENSCHAFT>
      <suc:ORTNR></suc:ORTNR>
    </suc:SUCHEFIRMAREQUEST>
  </soap:Body>
</soap:Envelope>`;
}

function hitToDTO(e) {
  if (!e?.FNR) return null;
  // NAME can be a single string or an array (multi-line company name).
  const nameParts = Array.isArray(e.NAME) ? e.NAME : e.NAME ? [e.NAME] : [];
  const legalName = nameParts.join(' ').trim();
  const statusText = typeof e.STATUS === 'string' && e.STATUS ? e.STATUS.toLowerCase() : '';
  // "iL"/"i.L." suffix in the legal name means "in Liquidation" — the firm
  // is winding down and is NOT operationally active, though also not yet
  // deleted from the register. The IWG STATUS field doesn't flag this, so
  // we detect from the name.
  const nameHasInLiq = /\b(?:iL|i\.L\.?|in\s+Liqu(?:idation)?|in\s+Liq\b)/i.test(legalName);
  const deleted = statusText.includes('gelöscht') || statusText.includes('geloscht');
  const status = deleted ? 'dissolved' : 'active';
  const flags = (deleted || nameHasInLiq)
    ? { bankrupt: false, inLiquidation: nameHasInLiq }
    : undefined;
  return makeDTO('AT', {
    nationalId: e.FNR,
    legalName,
    legalFormCode: e.RECHTSFORM?.CODE,
    legalFormText: e.RECHTSFORM?.TEXT,
    status,
    address: [e.SITZ, e.GERICHT?.TEXT].filter(Boolean).join(' · '),
    flags,
    source: 'at',
    raw: e,
  });
}

const FNR_LIKE = /^\d{1,6}[a-z]?$/i;

export default {
  id: 'AT',
  label: 'Österreich',
  license: 'IWG – JustizOnline (kommerziell erlaubt; kein amtlicher Auszug)',
  sourceLabel: 'JustizOnline · Firmenbuch',
  sourceUrl: 'https://justizonline.gv.at/jop/web/iwg',
  attribution: 'Quelle: JustizOnline (IWG). Kein amtlicher Firmenbuchauszug.',
  hasFinancials: true,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const body = await soapRequest(buildSearchEnvelope(term));
    const resp = body?.SUCHEFIRMARESPONSE;
    if (!resp) return [];
    const results = resp.ERGEBNIS;
    const list = Array.isArray(results) ? results : results ? [results] : [];
    return list.map(hitToDTO).filter(Boolean);
  },

  // For now: no live detail fetch. If a company has been seen via search,
  // the server serves it from the DB cache. If not, we do a narrow exact-name
  // search with the given id as the search term, which also works for FN-like
  // inputs because the IWG SUCHEFIRMA endpoint handles them.
  async getCompany(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    // If the id looks like an FNR, attempt a targeted search — the response
    // has no FNR filter so we filter client-side.
    if (FNR_LIKE.test(key.replace(/\s+/g, ''))) {
      const hits = await this.search(key);
      const match = hits.find((h) => h.nationalIdCanon === key.toLowerCase().replace(/\s+/g, ''));
      return match || null;
    }
    return null;
  },

  // Fetch recent JAb filings via SUCHEURKUNDE, then URKUNDE-download each XML
  // variant and parse. We cap at MAX_JAB_YEARS to keep the first-click latency
  // bounded; subsequent calls are served from the DB cache.
  async getFinancials(id) {
    const key = String(id || '').trim().replace(/\s+/g, '');
    if (!FNR_LIKE.test(key)) return [];
    try {
      const xmlKeys = await fetchJabKeys(key);
      if (xmlKeys.length) {
        // XML path — parse the machine-readable Justiz v4 / BMF legacy format.
        const results = await Promise.all(xmlKeys.map(downloadAndParse));
        const rows = results.filter(Boolean);
        if (rows.length) return rows;
      }
      // Fallback: the firm files PDF-only. Try the text-layer PDF parser on
      // the most recent PDF. If the PDF turns out to be a scan (no text
      // layer), run OCR, cache the extracted text, and feed it through the
      // same §224 parser.
      // JustizOnline occasionally mis-tags other document types (Corporate
      // Governance Berichte etc.) under DOKUMENTART.CODE=48. The first PDF
      // in the sorted list might not actually be a Jahresabschluss. We try
      // up to MAX_PDF_ATTEMPTS candidates and return the first parse that
      // yields a valid row.
      const docs = await fetchJabDocs(key);
      const candidates = docs.filter((d) => d.pdfKey).slice(0, 5);
      for (const pdfCandidate of candidates) {
        const row = await parseOnePdfCandidate(pdfCandidate);
        if (row) return [row];
      }
      return [];
    } catch {
      return [];
    }
  },

  // List all Jahresabschluss filings (both XML and PDF), newest first.
  // Used by the UI fallback to offer original-document downloads when no
  // machine-readable XML is available.
  async getDocuments(id) {
    const key = String(id || '').trim().replace(/\s+/g, '');
    if (!FNR_LIKE.test(key)) return [];
    try { return await fetchJabDocs(key); }
    catch { return []; }
  },

  // On-demand fetch of a single Urkunde by its document KEY. Returns the raw
  // decoded bytes plus the original content-type. Used by the /document proxy.
  async downloadDocument(key) { return downloadDocumentRaw(key); },
};

// Attempt to parse a single PDF candidate. Returns a balance-sheet row or
// null. Handles all three code paths: OCR cache shortcut, text-layer PDF,
// and full OCR. Callers iterate over candidates to handle mis-tagged
// documents (JustizOnline sometimes labels Corporate Governance reports as
// DOKUMENTART.CODE=48 Jahresabschluss).
async function parseOnePdfCandidate(candidate) {
  // Cache shortcut
  const cachedOcr = readOcrText('AT', candidate.pdfKey);
  if (cachedOcr) {
    const row = parseBilanzFromText(cachedOcr, candidate.stichtag);
    return row ? { ...row, source_ref: candidate.pdfKey } : null;
  }
  const doc = await downloadDocumentRaw(candidate.pdfKey);
  if (!doc) return null;

  let textLayer = '';
  try { textLayer = (await new PDFParse({ data: doc.bytes }).getText())?.text || ''; }
  catch { textLayer = ''; }

  if (!looksLikeScannedPdf(textLayer)) {
    const row = await parsePdfBilanz(doc.bytes, candidate.stichtag);
    return row ? { ...row, source_ref: candidate.pdfKey } : null;
  }
  // Scanned PDF → OCR with 360s cap against pathological inputs.
  const ocrTimeout = 360_000;
  const ocrText = await Promise.race([
    ocrPdf(doc.bytes),
    new Promise((resolve) => setTimeout(() => resolve(''), ocrTimeout)),
  ]);
  if (!ocrText) return null;
  writeOcrText('AT', candidate.pdfKey, ocrText);
  const row = parseBilanzFromText(ocrText, candidate.stichtag);
  return row ? { ...row, source_ref: candidate.pdfKey } : null;
}

async function downloadDocumentRaw(key) {
  if (!key) return null;
  const body = await soapRequest(buildUrkundeEnvelope(String(key)));
  const dok = body?.URKUNDERESPONSE?.DOKUMENT;
  const b64 = dok?.CONTENT;
  if (!b64) return null;
  const bytes = Buffer.from(String(b64), 'base64');
  // Construct a readable filename. JustizOnline's dok.NAME is usually missing
  // or a filing-internal ID; derive something human-friendly from the KEY's
  // FN prefix and final ID suffix.
  const keyStr = String(key);
  const fn = keyStr.slice(0, 6).replace(/^0+/, '') || 'AT';
  const ext = keyStr.endsWith('_XML') ? 'xml' : keyStr.endsWith('_PDF') ? 'pdf' : 'bin';
  const idSuffix = keyStr.match(/_(\d+)_(?:PDF|XML)$/)?.[1] || 'doc';
  const filename = `Firmenbuch-FN${fn}-${idSuffix}.${ext}`;
  return {
    bytes,
    contentType: dok.CONTENTTYPE || 'application/octet-stream',
    filename,
  };
}

// Parse Austrian dd.mm.yyyy or dd.m.yyyy out of a free-text BEMERKUNG field.
// JustizOnline registrars type the Bilanzstichtag here (often with prose
// prefixes like "zum 31.03.2010") — these strings are more consistent than
// the DOKUMENTENDATUM column. Returns an ISO YYYY-MM-DD or null.
function parseBemerkungStichtag(bemerkung) {
  if (!bemerkung) return null;
  const m = String(bemerkung).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const [_, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// ─── SUCHEURKUNDE + URKUNDE helpers ──────────────────────────────────────

const MAX_JAB_YEARS = 5;
const JAB_DOC_CODE = '48';

function buildSearchUrkundeEnvelope(fnr) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
  xmlns:su="ns://firmenbuch.justiz.gv.at/Abfrage/SucheUrkundeRequest">
  <soap:Header/>
  <soap:Body>
    <su:SUCHEURKUNDEREQUEST>
      <su:FNR>${fnr}</su:FNR>
    </su:SUCHEURKUNDEREQUEST>
  </soap:Body>
</soap:Envelope>`;
}

function buildUrkundeEnvelope(key) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
  xmlns:u="ns://firmenbuch.justiz.gv.at/Abfrage/UrkundeRequest">
  <soap:Header/>
  <soap:Body>
    <u:URKUNDEREQUEST>
      <u:KEY>${key}</u:KEY>
    </u:URKUNDEREQUEST>
  </soap:Body>
</soap:Envelope>`;
}

async function fetchJabKeys(fnr) {
  const body = await soapRequest(buildSearchUrkundeEnvelope(fnr));
  const ergList = body?.SUCHEURKUNDERESPONSE?.ERGEBNIS;
  const entries = Array.isArray(ergList) ? ergList : ergList ? [ergList] : [];
  // Keep only XML JAb filings; filter out mis-tagged Corporate Governance
  // entries so we don't waste the 5-slot MAX_JAB_YEARS budget on them.
  const jabs = entries
    .filter((e) => String(e?.DOKUMENTART?.CODE) === JAB_DOC_CODE)
    .filter((e) => String(e?.CONTENTTYPE || '').toLowerCase().includes('xml'))
    .filter((e) => e?.KEY)
    .filter((e) => !/Corporate\s*Governance/i.test(String(e?.BEMERKUNG || '')));
  // Attach a best-effort stichtag (DOKUMENTENDATUM → BEMERKUNG → null) so
  // sorting picks the newest filings even when the registrar left the
  // explicit date column empty — common for pre-2015 submissions.
  const enriched = jabs.map((e) => ({
    key: e.KEY,
    stichtag: e.DOKUMENTENDATUM || parseBemerkungStichtag(e.BEMERKUNG) || null,
  }));
  enriched.sort((a, b) => {
    if (a.stichtag && b.stichtag) return String(b.stichtag).localeCompare(String(a.stichtag));
    if (a.stichtag) return -1;
    if (b.stichtag) return 1;
    return String(b.key).localeCompare(String(a.key));
  });
  return enriched.slice(0, MAX_JAB_YEARS);
}

// List *all* JAb filings (XML + PDF), newest first. Deduplicates across both
// formats by Stichtag: if a year is available in both, the XML entry wins
// (machine-readable) but the PDF KEY is kept as `pdfKey` so the UI can still
// link to the human-readable original.
async function fetchJabDocs(fnr) {
  const body = await soapRequest(buildSearchUrkundeEnvelope(fnr));
  const ergList = body?.SUCHEURKUNDERESPONSE?.ERGEBNIS;
  const entries = Array.isArray(ergList) ? ergList : ergList ? [ergList] : [];
  // Keep all JAb entries with a KEY. DOKUMENTENDATUM is often missing on
  // older filings — in that case we parse the Bilanzstichtag out of the
  // free-text BEMERKUNG (e.g. "31.3.2019", "zum 31.03.2010"), which the
  // registrar fills in manually and is reliably present.
  const jabs = entries
    .filter((e) => String(e?.DOKUMENTART?.CODE) === JAB_DOC_CODE)
    .filter((e) => e?.KEY)
    // Filter out JustizOnline's known mis-tags: the most common is a
    // "Corporate Governance Bericht" labeled as DOKUMENTART.CODE=48.
    .filter((e) => !/Corporate\s*Governance/i.test(String(e?.BEMERKUNG || '')));
  const byGroup = new Map();
  for (const e of jabs) {
    const stichtag = e.DOKUMENTENDATUM || parseBemerkungStichtag(e.BEMERKUNG) || null;
    // Group key: explicit stichtag if present, else the filing ID prefix
    // from the KEY (the part before `_PDF`/`_XML`), which uniquely names
    // the filing but is shared between PDF + XML twins.
    const groupKey = stichtag || String(e.KEY).replace(/_(PDF|XML|HATDOK).*$/i, '');
    const ct = String(e.CONTENTTYPE || '').toLowerCase();
    const isXml = ct.includes('xml');
    const isPdf = ct.includes('pdf');
    const row = byGroup.get(groupKey) || { stichtag, xmlKey: null, pdfKey: null };
    if (isXml && !row.xmlKey) row.xmlKey = e.KEY;
    if (isPdf && !row.pdfKey) row.pdfKey = e.KEY;
    if (stichtag && !row.stichtag) row.stichtag = stichtag;
    byGroup.set(groupKey, row);
  }
  // Sort newest-first. Filing KEYs are monotonically increasing IDs (larger
  // = more recent), so sorting by the numeric ID suffix gives a reliable
  // chronological order even for dateless filings. We extract the final
  // numeric run from the KEY and compare as a BigInt.
  const keyId = (row) => {
    const key = row.pdfKey || row.xmlKey || '';
    const m = key.match(/_(\d+)_(?:PDF|XML|HATDOK)?$/);
    return m ? BigInt(m[1]) : 0n;
  };
  return [...byGroup.values()].sort((a, b) => {
    const ka = keyId(a), kb = keyId(b);
    if (ka !== kb) return kb > ka ? 1 : -1;
    return 0;
  });
}

async function downloadAndParse({ key, stichtag }) {
  const body = await soapRequest(buildUrkundeEnvelope(key));
  const dok = body?.URKUNDERESPONSE?.DOKUMENT;
  const b64 = dok?.CONTENT;
  if (!b64) return null;
  let xmlText;
  try { xmlText = Buffer.from(String(b64), 'base64').toString('utf8'); }
  catch { return null; }
  const row = parseJAb(xmlText);
  if (!row) return null;
  return { ...row, source_ref: key, stichtag: row.stichtag || stichtag };
}
