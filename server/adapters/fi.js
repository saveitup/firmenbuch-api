// Finland — Patentti- ja rekisterihallitus (PRH) / YTJ open data v3.
// Endpoint: https://avoindata.prh.fi/opendata-ytj-api/v3/companies
// License: CC BY 4.0 — commercial use with attribution.
// No auth, no key.
//
// national_id = Y-tunnus (businessId), format "1234567-8".
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'avoindata.prh.fi';
const BASE = '/opendata-ytj-api/v3/companies';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: HOST, path: p, method: 'GET', headers: { Accept: 'application/json', 'User-Agent': UA }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: 404, data: null });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('FI', `HTTP ${res.statusCode} on ${p}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (e) { reject(new AdapterError('FI', `JSON parse: ${e.message}`, { cause: e })); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('FI', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('FI', err.message, { cause: err })),
    );
    req.end();
  });
}

// PRH returns descriptions in 3 languages: 1=fi, 2=sv, 3=en.
// Prefer English, then Finnish.
function pickDescription(descriptions) {
  if (!Array.isArray(descriptions) || !descriptions.length) return undefined;
  const byLang = (code) => descriptions.find((d) => d.languageCode === code || d.languageCode === String(code));
  return (byLang(3) || byLang('3') || byLang(1) || byLang('1') || descriptions[0])?.description;
}

function currentName(names) {
  if (!Array.isArray(names)) return undefined;
  // Type "1" = primary name. Prefer the one without an endDate (i.e. current).
  const primary = names.filter((n) => n.type === '1' || n.type === 1);
  const active = primary.find((n) => !n.endDate);
  return (active || primary[0] || names[0])?.name;
}

function formatAddress(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) return undefined;
  // Type 1 = visiting/street address; fall back to whatever exists.
  const a = addresses.find((x) => x.type === 1) || addresses[0];
  const city = a.postOffices?.find((p) => p.languageCode === '1' || p.languageCode === 1)?.city
            || a.postOffices?.[0]?.city;
  const streetLine = [a.street, a.buildingNumber].filter(Boolean).join(' ').trim()
    || (a.postOfficeBox ? `PL ${a.postOfficeBox}` : '');
  return [streetLine, [a.postCode, city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ') || undefined;
}

// Mapping of PRH status codes to our normalised status. Codes are:
//   1 = Unfinished, 2 = Active / registered, 3 = Closed / dissolved (observed).
// For anything else we fall through to the tradeRegisterStatus field.
function extractStatus(c) {
  if (c.status === '3' || c.status === 3) return 'dissolved';
  const trs = c.tradeRegisterStatus;
  if (trs && typeof trs === 'object') {
    const desc = pickDescription(trs.descriptions) || '';
    if (/terminat|closed|suljettu|upphörd/i.test(desc)) return 'dissolved';
  }
  return 'active';
}

function toDTO(c) {
  const businessId = c?.businessId?.value;
  if (!businessId) return null;
  const form = Array.isArray(c.companyForms) && c.companyForms.length
    ? c.companyForms.find((f) => !f.endDate) || c.companyForms[0]
    : null;
  const nace = c.mainBusinessLine
    ? { code: c.mainBusinessLine.type, text: pickDescription(c.mainBusinessLine.descriptions) }
    : undefined;
  // Previous primary names (type "1") that are no longer current.
  const previousNames = Array.isArray(c.names)
    ? c.names
        .filter((n) => (n.type === '1' || n.type === 1) && n.endDate)
        .map((n) => ({ name: n.name, until: n.endDate }))
    : undefined;
  return makeDTO('FI', {
    nationalId: businessId,
    legalName: currentName(c.names),
    legalFormCode: form?.type,
    legalFormText: form ? pickDescription(form.descriptions) : undefined,
    status: extractStatus(c),
    address: formatAddress(c.addresses),
    incorporationDate: c.registrationDate || c.businessId?.registrationDate,
    lastUpdated: c.lastModified,
    website: c.website?.url || c.website,
    nace,
    previousNames: previousNames && previousNames.length ? previousNames : undefined,
    source: 'fi',
    raw: c,
  });
}

const BUSINESS_ID = /^\d{6,7}-\d$/;

export default {
  id: 'FI',
  label: 'Finnland',
  license: 'CC BY 4.0 — PRH Avoindata',
  sourceLabel: 'PRH · YTJ Avoindata',
  sourceUrl: 'https://avoindata.prh.fi/',
  attribution: 'Lähde: Patentti- ja rekisterihallitus (PRH) · CC BY 4.0.',
  hasFinancials: false,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (BUSINESS_ID.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    const { data } = await httpJson(`${BASE}?name=${encodeURIComponent(term)}`);
    const list = data?.companies || [];
    return list.slice(0, 50).map(toDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id);
    if (!BUSINESS_ID.test(key)) return null;
    const { data } = await httpJson(`${BASE}?businessId=${encodeURIComponent(key)}`);
    const c = data?.companies?.[0];
    return c ? toDTO(c) : null;
  },
};
