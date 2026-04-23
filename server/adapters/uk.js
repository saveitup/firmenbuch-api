// United Kingdom — Companies House Public Data API.
// Endpoint: https://api.company-information.service.gov.uk
// Auth:     HTTP Basic with api-key as username, empty password
// License:  Open Government Licence v3.0 — commercial use allowed with attribution
// Register for a free key: https://developer.company-information.service.gov.uk
//
// national_id = company number (8 chars, alphanumeric, e.g. "01777777").
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';
import { parseUkBilanPdf } from '../uk-bilanz-parser.js';

const HOST = 'api.company-information.service.gov.uk';
const DOC_HOST = 'document-api.company-information.service.gov.uk';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

// Cached parsed KPI rows keyed on the Companies House document id. The
// corresponding OCR text (for scanned filings) lives in SQLite via the
// ocr_text_cache table — see uk-bilanz-parser.js.
const BILAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const bilanCache = new Map();

function httpJson(p, { host = HOST, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const key = process.env.UK_CH_API_KEY;
    if (!key) return reject(new AdapterError('UK', 'UK_CH_API_KEY missing in .env', { status: 503 }));
    const auth = Buffer.from(`${key}:`).toString('base64');
    const req = https.request(
      { host, path: p, method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${auth}`, 'User-Agent': UA },
        timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: 404, data: null });
          if (res.statusCode === 401) return reject(new AdapterError('UK', 'Invalid UK_CH_API_KEY', { status: 503 }));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('UK', `HTTP ${res.statusCode}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (e) { reject(new AdapterError('UK', `JSON parse: ${e.message}`, { cause: e })); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('UK', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('UK', err.message, { cause: err })),
    );
    req.end();
  });
}

// Binary download with Companies House Basic-auth. The document host
// issues a 302 redirect to S3 — the Authorization header must NOT be
// forwarded, so we follow the redirect manually.
function httpBinary(url, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = process.env.UK_CH_API_KEY;
    if (!key) return reject(new AdapterError('UK', 'UK_CH_API_KEY missing', { status: 503 }));
    const auth = Buffer.from(`${key}:`).toString('base64');
    const u = new URL(url);
    const go = (target, hops) => {
      if (hops > 3) return reject(new AdapterError('UK', 'too many redirects'));
      const headers = { Accept: 'application/pdf', 'User-Agent': UA };
      // Only send auth to Companies House hosts — never to S3.
      if (target.host.endsWith('.company-information.service.gov.uk')) {
        headers.Authorization = `Basic ${auth}`;
      }
      const req = https.request({ host: target.host, path: target.pathname + target.search, method: 'GET', headers, timeout }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, target), hops + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
      });
      req.on('timeout', () => req.destroy(new AdapterError('UK', 'download timeout')));
      req.on('error', (err) => reject(err instanceof AdapterError ? err : new AdapterError('UK', err.message, { cause: err })));
      req.end();
    };
    go(u, 0);
  });
}

function formatAddress(a) {
  if (!a) return undefined;
  return [a.address_line_1, a.address_line_2, [a.postal_code, a.locality].filter(Boolean).join(' '), a.country]
    .filter(Boolean).join(', ') || undefined;
}

function searchHitToDTO(h) {
  if (!h?.company_number) return null;
  return makeDTO('UK', {
    nationalId: h.company_number,
    legalName: h.title,
    legalFormCode: h.company_type,
    status: h.company_status === 'active' ? 'active' : 'dissolved',
    address: h.address_snippet,
    incorporationDate: h.date_of_creation,
    source: 'uk',
    raw: h,
  });
}

function profileToDTO(p) {
  if (!p?.company_number) return null;
  const sic = Array.isArray(p.sic_codes) && p.sic_codes.length ? p.sic_codes[0] : undefined;
  return makeDTO('UK', {
    nationalId: p.company_number,
    legalName: p.company_name,
    legalFormCode: p.type,
    status: p.company_status === 'active' ? 'active' : 'dissolved',
    address: formatAddress(p.registered_office_address),
    incorporationDate: p.date_of_creation,
    lastUpdated: p.last_full_members_list_date,
    nace: sic ? { code: sic } : undefined,
    flags: (p.has_insolvency_history || p.has_charges)
      ? { bankrupt: !!p.has_insolvency_history, inLiquidation: false }
      : undefined,
    previousNames: Array.isArray(p.previous_company_names)
      ? p.previous_company_names.map((n) => ({ name: n.name, until: n.ceased_on }))
      : undefined,
    source: 'uk',
    raw: p,
  });
}

const COMPANY_NUMBER = /^[A-Z0-9]{6,10}$/i;

export default {
  id: 'UK',
  label: 'Vereinigtes Königreich',
  license: 'OGL v3.0 — Companies House',
  sourceLabel: 'Companies House',
  sourceUrl: 'https://find-and-update.company-information.service.gov.uk/',
  attribution: 'Contains public sector information licensed under the Open Government Licence v3.0.',
  hasFinancials: true,
  get configured() { return !!process.env.UK_CH_API_KEY; },

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const { data } = await httpJson(`/search/companies?q=${encodeURIComponent(term)}&items_per_page=20`);
    const items = data?.items || [];
    return items.map(searchHitToDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id).toUpperCase();
    if (!COMPANY_NUMBER.test(key)) return null;
    const { status, data } = await httpJson(`/company/${encodeURIComponent(key)}`);
    if (status === 404 || !data) return null;
    return profileToDTO(data);
  },

  async getPeople(id) {
    const key = canonId(id).toUpperCase();
    if (!COMPANY_NUMBER.test(key)) return [];
    try {
      const { data } = await httpJson(`/company/${encodeURIComponent(key)}/officers?items_per_page=50`);
      const items = data?.items || [];
      return items.map((o) => ({
        name: o.name,
        role: o.officer_role,
        roleCode: o.officer_role,
        resigned: !!o.resigned_on,
      }));
    } catch { return []; }
  },

  // UK accounts via Companies House. We list the most recent "accounts"
  // filings, pick up to 3 (by date desc), download each PDF and route it
  // through uk-bilanz-parser (layout-aware → plain text → OCR). Parsed
  // KPIs are cached in-module plus persisted in SQLite by the caller.
  async getFinancials(id) {
    const key = canonId(id).toUpperCase();
    if (!COMPANY_NUMBER.test(key)) return [];
    let items;
    try {
      const { data } = await httpJson(
        `/company/${encodeURIComponent(key)}/filing-history?category=accounts&items_per_page=10`,
      );
      items = data?.items || [];
    } catch { return []; }
    if (!items.length) return [];

    // One filing per accounting period. The `significant_date` (made-up
    // date) is the fiscal year-end we map to `stichtag`; fall back to
    // `date` (filing date) if missing.
    const uniqByPeriod = new Map();
    for (const f of items) {
      if (!f?.links?.document_metadata) continue;
      const docId = String(f.links.document_metadata).split('/').pop();
      const period = f.action_date || f.date || f.made_up_date || null;
      const year = period ? String(period).slice(0, 4) : null;
      if (!year || !docId) continue;
      const cur = uniqByPeriod.get(year);
      if (!cur || (f.date || '') > (cur.date || '')) {
        uniqByPeriod.set(year, { docId, period, date: f.date, description: f.description });
      }
    }
    const chosen = [...uniqByPeriod.values()]
      .sort((a, b) => (b.period || '').localeCompare(a.period || ''))
      .slice(0, 3);

    const out = [];
    for (const f of chosen) {
      try {
        const kpi = await parseBilanCached(f);
        const sane = sanitiseKpi(kpi);
        if (sane) out.push(sane);
      } catch { /* skip broken filing */ }
    }
    return out.sort((a, b) => (a.stichtag || '').localeCompare(b.stichtag || ''));
  },
};

// Null out implausible fields rather than rejecting the whole row.
// Same contract as the FR adapter — we prefer 4/5 correct KPIs over 0/5.
function sanitiseKpi(kpi) {
  if (!kpi) return null;
  const CAP = 5_000_000_000_000;
  for (const f of ['umsatzerloese', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'betriebsergebnis']) {
    if (kpi[f] != null && Math.abs(kpi[f]) > CAP) kpi[f] = null;
  }
  if (kpi.bilanzsumme && kpi.eigenkapital != null) {
    const r = kpi.eigenkapital / kpi.bilanzsumme;
    if (r < 0.005 || r > 0.995) kpi.eigenkapital = null;
  }
  kpi.ek_quote = (kpi.bilanzsumme && kpi.eigenkapital != null)
    ? kpi.eigenkapital / kpi.bilanzsumme : null;
  const filled = ['umsatzerloese', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'betriebsergebnis']
    .filter((f) => kpi[f] != null).length;
  return filled >= 1 ? kpi : null;
}

async function parseBilanCached(f) {
  const cached = bilanCache.get(f.docId);
  if (cached && cached.expires > Date.now()) return cached.kpi;
  // Fetch document metadata so we know whether PDF is available.
  const { data: meta } = await httpJson(`/document/${encodeURIComponent(f.docId)}`, { host: DOC_HOST });
  const res = meta?.resources || {};
  if (!res['application/pdf']) {
    bilanCache.set(f.docId, { kpi: null, expires: Date.now() + BILAN_CACHE_TTL_MS });
    return null;
  }
  const contentUrl = `https://${DOC_HOST}/document/${encodeURIComponent(f.docId)}/content`;
  const { status, buf } = await httpBinary(contentUrl, { timeout: 180000 });
  if (status !== 200 || !buf?.length) return null;

  const kpi = await parseUkBilanPdf(buf, {
    dateCloture: f.period ? String(f.period).slice(0, 10) : null,
    typeBilan: f.description || null,
    sourceRef: f.docId,
  });
  bilanCache.set(f.docId, { kpi, expires: Date.now() + BILAN_CACHE_TTL_MS });
  return kpi;
}
