// Denmark — CVR via cvrapi.dk (third-party free REST mirror).
// Endpoint: https://cvrapi.dk/api
// Auth:     none. Their terms require a contact e-mail in the User-Agent
//           header so they can get in touch about abuse / rate limits.
// License:  cvrapi.dk re-distributes the CVR open-data feed; CVR itself
//           is CC0 / free for commercial use.
//
// Why not the official Datafordeler CVR services?
// ── distribution.virk.dk/cvr-permanent requires an Erhvervsstyrelsen
//    webuser (separate signup, IP-whitelist, ~3 weeks review).
// ── services.datafordeler.dk/CVR/HentCVRData requires both a
//    Datafordeler API-key AND a per-service "Anmodning om adgang"
//    with manual Erhvervsstyrelsen approval.
// Both are valid but too slow for a productive adapter; cvrapi.dk
// ships today with the same underlying CC0 data.
//
// Financials (Årsrapporter) are NOT served by cvrapi.dk. The iXBRL
// feed at regnskaber.virk.dk is IP-restricted (our network is
// blocked). Adapter therefore declares hasFinancials: false until a
// usable bilanz channel is available.
//
// national_id = CVR-nummer, 8 digits.
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'cvrapi.dk';
// cvrapi.dk explicitly requires identification in the UA per their terms.
// Using the Kontur app URL + operator contact keeps us compliant.
const UA = 'Kontur/0.2 (+kontakt: pontus.maximus@icloud.com)';
const TIMEOUT_MS = 10000;

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path, method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': UA },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('DK', `HTTP ${res.statusCode}: ${raw.slice(0, 200)}`, { status: 502 }));
        }
        try {
          const data = JSON.parse(raw);
          // cvrapi.dk returns {error,message} at HTTP 200 for rate-limit
          // and unknown-vat cases — surface those as null instead of a
          // half-parsed DTO.
          if (data?.error) return resolve(null);
          resolve(data);
        } catch (e) { reject(new AdapterError('DK', `JSON parse: ${e.message}`, { cause: e })); }
      });
    });
    req.on('timeout', () => req.destroy(new AdapterError('DK', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('DK', err.message, { cause: err })),
    );
    req.end();
  });
}

function toIsoDate(s) {
  // cvrapi.dk emits dates as "DD/MM - YYYY" — convert to ISO.
  if (!s) return undefined;
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\s*-\s*(\d{4})$/);
  if (!m) return undefined;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function toDTO(d) {
  if (!d?.vat) return null;
  const cvr = String(d.vat).padStart(8, '0');
  const address = [
    d.address,
    [d.zipcode, d.city].filter(Boolean).join(' '),
    'Danmark',
  ].filter(Boolean).join(', ');

  const bankrupt = !!d.creditbankrupt;
  const dissolved = !!d.enddate;
  const status = dissolved ? 'dissolved' : 'active';

  return makeDTO('DK', {
    nationalId: cvr,
    legalName: d.name,
    legalFormCode: d.companycode != null ? String(d.companycode) : undefined,
    legalFormText: d.companydesc,
    status,
    address: address || undefined,
    incorporationDate: toIsoDate(d.startdate),
    phone: d.phone || undefined,
    email: d.email || undefined,
    employeeCount: typeof d.employees === 'number' ? d.employees : undefined,
    nace: d.industrycode
      ? { code: String(d.industrycode), text: d.industrydesc }
      : undefined,
    flags: (bankrupt || dissolved)
      ? { bankrupt, inLiquidation: false }
      : undefined,
    source: 'dk-cvrapi',
    raw: d,
  });
}

const CVR_RE = /^\d{8}$/;

export default {
  id: 'DK',
  label: 'Dänemark',
  license: 'CC0 — CVR open data (via cvrapi.dk)',
  sourceLabel: 'CVR · cvrapi.dk',
  sourceUrl: 'https://datacvr.virk.dk/',
  attribution: 'Data fra Det Centrale Virksomhedsregister (CVR) · CC0, leveret via cvrapi.dk.',
  hasFinancials: false,
  coverage: 'stamm',

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (CVR_RE.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    // Name search via cvrapi.dk — returns a single best match object.
    const data = await httpJson(`/api?search=${encodeURIComponent(term)}&country=dk`);
    const dto = toDTO(data);
    return dto ? [dto] : [];
  },

  async getCompany(id) {
    const key = canonId(id).padStart(8, '0');
    if (!CVR_RE.test(key)) return null;
    const data = await httpJson(`/api?vat=${encodeURIComponent(key)}&country=dk`);
    return data ? toDTO(data) : null;
  },

  async getPeople(id) {
    // cvrapi.dk exposes `owners` (may be null). We map when present
    // but don't persist roles — cvrapi does not distinguish board /
    // executive / proxy roles, only ownership slices.
    const key = canonId(id).padStart(8, '0');
    if (!CVR_RE.test(key)) return [];
    const data = await httpJson(`/api?vat=${encodeURIComponent(key)}&country=dk`);
    const owners = Array.isArray(data?.owners) ? data.owners : [];
    return owners
      .filter((o) => o?.name)
      .map((o) => ({ name: o.name, role: 'Ejer', roleCode: 'OWNER', resigned: false }));
  },
};
