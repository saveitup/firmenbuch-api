// GLEIF Level 1 LEI-records factory. Produces an adapter for a given
// country by reusing the same REST call against api.gleif.org and filtering
// on `entity.jurisdiction`. LEI coverage varies by country — roughly every
// financially-relevant company (banks, listed firms, large corporates) has
// an LEI, plus many mid-sized firms via counterparty obligations.
//
// License: CC0 (GLEIF Golden Copy). Commercial use unrestricted.
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'api.gleif.org';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: HOST, path: p, method: 'GET',
        headers: { Accept: 'application/vnd.api+json', 'User-Agent': UA },
        timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: 404, data: null });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('GLEIF', `HTTP ${res.statusCode}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (e) { reject(new AdapterError('GLEIF', `JSON parse: ${e.message}`, { cause: e })); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('GLEIF', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('GLEIF', err.message, { cause: err })),
    );
    req.end();
  });
}

function formatAddress(a) {
  if (!a) return undefined;
  const street = Array.isArray(a.addressLines) ? a.addressLines.filter(Boolean).join(' ') : '';
  return [street, [a.postalCode, a.city].filter(Boolean).join(' '), a.country]
    .filter(Boolean).join(', ') || undefined;
}

const LEI_LIKE = /^[A-Z0-9]{20}$/i;

/**
 * Build a GLEIF-backed adapter for a specific country.
 * @param {Object} opts
 * @param {string} opts.country   — ISO 3166-1 alpha-2, uppercase
 * @param {string} opts.label     — human country name
 * @param {Object.<string,string>} [opts.legalForms] — ELF-code → human text
 * @param {string} [opts.nationalIdPattern] — regex test for the country's register IDs (e.g. "HRB" for DE)
 */
export function makeGleifAdapter({ country, label, legalForms = {}, nationalIdPattern }) {
  const idRegex = nationalIdPattern ? new RegExp(nationalIdPattern, 'i') : null;

  function toDTO(record) {
    const a = record?.attributes;
    if (!a) return null;
    const entity = a.entity || {};
    if ((entity.jurisdiction || '').toUpperCase() !== country) return null;
    const formId = entity.legalForm?.id;
    const status = (entity.status === 'ACTIVE' && a.registration?.status !== 'LAPSED')
      ? 'active' : 'dissolved';
    const previousNames = Array.isArray(entity.otherNames) && entity.otherNames.length
      ? entity.otherNames.map((o) => ({ name: o.name })).filter((n) => n.name)
      : undefined;
    return makeDTO(country, {
      nationalId: entity.registeredAs || a.lei,
      legalName: entity.legalName?.name,
      legalFormCode: formId,
      legalFormText: legalForms[formId],
      status,
      address: formatAddress(entity.legalAddress),
      incorporationDate: a.registration?.initialRegistrationDate?.slice(0, 10),
      lastUpdated: a.registration?.lastUpdateDate?.slice(0, 10),
      lei: a.lei,
      previousNames,
      source: `${country.toLowerCase()}-gleif`,
      raw: a,
    });
  }

  async function getByLei(lei) {
    const key = String(lei || '').trim().toUpperCase();
    if (!LEI_LIKE.test(key)) return null;
    const { status, data } = await httpJson(`/api/v1/lei-records/${encodeURIComponent(key)}`);
    if (status === 404 || !data?.data) return null;
    return toDTO(data.data);
  }

  return {
    id: country,
    label,
    license: 'CC0 — GLEIF (nur LEI-registrierte Firmen)',
    sourceLabel: 'GLEIF · LEI Level 1',
    sourceUrl: 'https://www.gleif.org/',
    attribution: `Quelle: GLEIF (CC0). Nur Firmen mit LEI — partielle Abdeckung.`,
    coverage: 'partial',           // surfaced in listCountries()
    hasFinancials: false,

    async search(q) {
      const term = String(q || '').trim();
      if (!term) return [];
      const stripped = term.replace(/\s+/g, '');
      if (LEI_LIKE.test(stripped)) {
        const hit = await getByLei(stripped);
        return hit ? [hit] : [];
      }
      if (idRegex && idRegex.test(term)) {
        const filter = encodeURIComponent(term);
        const path = `/api/v1/lei-records?filter%5Bentity.registeredAs%5D=${filter}&filter%5Bentity.jurisdiction%5D=${country}&page%5Bsize%5D=10`;
        const { data } = await httpJson(path);
        return (data?.data || []).map(toDTO).filter(Boolean);
      }
      const filter = encodeURIComponent(term);
      const path = `/api/v1/lei-records?filter%5Bentity.legalName%5D=${filter}&filter%5Bentity.jurisdiction%5D=${country}&page%5Bsize%5D=20`;
      const { data } = await httpJson(path);
      return (data?.data || []).map(toDTO).filter(Boolean);
    },

    async getCompany(id) {
      const raw = String(id || '').trim();
      if (!raw) return null;
      if (LEI_LIKE.test(raw.replace(/\s+/g, ''))) return getByLei(raw);
      const filter = encodeURIComponent(raw);
      const path = `/api/v1/lei-records?filter%5Bentity.registeredAs%5D=${filter}&filter%5Bentity.jurisdiction%5D=${country}&page%5Bsize%5D=1`;
      const { data } = await httpJson(path);
      const rec = data?.data?.[0];
      return rec ? toDTO(rec) : null;
    },
  };
}
