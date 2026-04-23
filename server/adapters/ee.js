// Estonia — Äriregister (Centre of Registers and Information Systems, RIK).
// Free Open Data, no auth, no key. national_id = registry_code (8 digits).
//
// Data sources:
//   • Stammdaten         https://ariregister.rik.ee/est/company/<code>   (HTML)
//   • Annual reports     https://ariregister.rik.ee/est/company/<code>/annual_reports (HTML listing)
//   • XBRL per report    https://ariregister.rik.ee/aruanded/xbrl/<report_id>
//
// The official Open Data bulk feed at avaandmed.ariregister.rik.ee
// (300 MB/day JSON ZIP) is cleaner for coverage, but needs a separate
// ingest script — we fall back to per-company HTML scrape so the adapter
// works on-demand without a prior sync.

import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';
import { parseEeXbrl } from '../ee-xbrl-parser.js';

const HOST = 'ariregister.rik.ee';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 15000;

const BILAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const bilanCache = new Map();

function httpGet(path, { host = HOST, accept = 'text/html', timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'GET',
      headers: { Accept: accept, 'User-Agent': UA, 'Accept-Language': 'en,et;q=0.8' },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 404) return resolve({ status: 404, buf, text: '' });
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow one redirect (typically /est → /eng language switch).
          return httpGet(res.headers.location.replace(/^https?:\/\/[^/]+/, ''), { host, accept, timeout }).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('EE', `HTTP ${res.statusCode} on ${path}`, { status: 502 }));
        }
        resolve({ status: res.statusCode, buf, text: buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new AdapterError('EE', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('EE', err.message, { cause: err })),
    );
    req.end();
  });
}

const RE_NAME   = /<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i;
const RE_STATUS = /(?:Staatus|Status)\s*[:：]?\s*<[^>]*>\s*([^<]+?)\s*</i;
const RE_FORM   = /(?:Õiguslik vorm|Legal form)\s*[:：]?\s*<[^>]*>\s*([^<]+?)\s*</i;
const RE_ADDR   = /(?:Aadress|Address)\s*[:：]?\s*<[^>]*>\s*([^<]+?)\s*</i;
const RE_INCORP = /(?:Esmakande|First entry|Registreeritud)\s*[^:]*[:：]?\s*<[^>]*>\s*(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/i;

function htmlCompanyToDTO(code, html) {
  if (!html) return null;
  const name = cleanText(html.match(RE_NAME)?.[1]);
  if (!name) return null;
  const statusRaw = cleanText(html.match(RE_STATUS)?.[1]) || '';
  const form = cleanText(html.match(RE_FORM)?.[1]);
  const address = cleanText(html.match(RE_ADDR)?.[1]);
  const incRaw = html.match(RE_INCORP)?.[1];
  const incorporationDate = incRaw ? toIsoDate(incRaw) : undefined;

  const status = /kustutatud|deleted|lõpetatud|terminated|likvideerimisel/i.test(statusRaw)
    ? 'dissolved' : 'active';

  return makeDTO('EE', {
    nationalId: code,
    legalName: name,
    legalFormText: form,
    status,
    address,
    incorporationDate,
    source: 'ee',
    raw: { status: statusRaw, form, scraped: true },
  });
}

function cleanText(s) {
  if (!s) return undefined;
  return s.replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
}

function toIsoDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

function extractReportIds(html) {
  // The annual-reports page links to /aruanded/xbrl/<id>. We harvest each
  // link together with any adjacent year label so callers can pick the
  // newest filings to parse.
  const out = [];
  const re = /\/aruanded\/xbrl\/(\d+)[^"']*["'][^>]*>[\s\S]{0,200}?(\d{4})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ reportId: m[1], year: m[2] });
  }
  if (!out.length) {
    // Fallback: just the IDs if year markers aren't colocated.
    const ids = new Set();
    for (const m2 of html.matchAll(/\/aruanded\/xbrl\/(\d+)/g)) ids.add(m2[1]);
    for (const id of ids) out.push({ reportId: id, year: null });
  }
  return out;
}

const CODE_RE = /^\d{8}$/;

export default {
  id: 'EE',
  label: 'Estland',
  license: 'Open data — e-Business Register (RIK)',
  sourceLabel: 'RIK · Äriregister',
  sourceUrl: 'https://ariregister.rik.ee/',
  attribution: 'Allikas: Registrite ja Infosüsteemide Keskus (RIK) · e-Äriregister.',
  hasFinancials: true,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (CODE_RE.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    // No public JSON search endpoint — AJAX-UI uses a paid gateway.
    // Name-search is served by the local companies cache upstream.
    return [];
  },

  async getCompany(id) {
    const key = canonId(id).padStart(8, '0');
    if (!CODE_RE.test(key)) return null;
    const { status, text } = await httpGet(`/est/company/${encodeURIComponent(key)}`);
    if (status === 404 || !text) return null;
    return htmlCompanyToDTO(key, text);
  },

  async getPeople() {
    // Board/shareholders sit behind the paid "detailed card" on RIK.
    // Leave empty for now — bulk feed `…kaardile_kantud_isikud.json.zip`
    // would be the right source once we add an ingest script.
    return [];
  },

  async getFinancials(id) {
    const key = canonId(id).padStart(8, '0');
    if (!CODE_RE.test(key)) return [];
    let listHtml;
    try {
      const { status, text } = await httpGet(`/est/company/${encodeURIComponent(key)}/annual_reports`);
      if (status === 404 || !text) return [];
      listHtml = text;
    } catch { return []; }

    const reports = extractReportIds(listHtml);
    if (!reports.length) return [];
    // Sort by year desc (null years go last), keep three most recent.
    reports.sort((a, b) => (b.year || '0').localeCompare(a.year || '0'));
    const chosen = reports.slice(0, 3);

    const out = [];
    for (const r of chosen) {
      try {
        const kpis = await parseReportCached(r.reportId);
        if (kpis) for (const k of kpis) out.push(k);
      } catch { /* skip */ }
    }
    // Dedup by stichtag — most recent filing wins.
    const byDate = new Map();
    for (const k of out) {
      if (!byDate.has(k.stichtag)) byDate.set(k.stichtag, k);
    }
    return [...byDate.values()].sort((a, b) => a.stichtag.localeCompare(b.stichtag));
  },
};

async function parseReportCached(reportId) {
  const cached = bilanCache.get(reportId);
  if (cached && cached.expires > Date.now()) return cached.kpis;
  const { status, buf } = await httpGet(`/aruanded/xbrl/${encodeURIComponent(reportId)}`, {
    accept: 'application/xml', timeout: 60000,
  });
  if (status !== 200 || !buf?.length) return null;
  const kpis = parseEeXbrl(buf, { filename: `report-${reportId}.xbrl` });
  bilanCache.set(reportId, { kpis, expires: Date.now() + BILAN_CACHE_TTL_MS });
  return kpis;
}
