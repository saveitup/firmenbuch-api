// United Kingdom — Companies House Public Data API.
// Endpoint: https://api.company-information.service.gov.uk
// Auth:     HTTP Basic with api-key as username, empty password
// License:  Open Government Licence v3.0 — commercial use allowed with attribution
// Register for a free key: https://developer.company-information.service.gov.uk
//
// national_id = company number (8 chars, alphanumeric, e.g. "01777777").
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'api.company-information.service.gov.uk';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const key = process.env.UK_CH_API_KEY;
    if (!key) return reject(new AdapterError('UK', 'UK_CH_API_KEY missing in .env', { status: 503 }));
    const auth = Buffer.from(`${key}:`).toString('base64');
    const req = https.request(
      { host: HOST, path: p, method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${auth}`, 'User-Agent': UA },
        timeout: TIMEOUT_MS },
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
  hasFinancials: false,
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
};
