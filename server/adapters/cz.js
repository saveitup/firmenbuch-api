// Czech Republic — ARES (Administrativní registr ekonomických subjektů).
// Endpoints:
//   POST /ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat    — search
//   GET  /ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}       — detail
// License: Open Data, commercial reuse allowed.
// No auth, no key.
//
// national_id = IČO (8 digits, may have leading zeros).
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'ares.gov.cz';
const BASE_PATH = '/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

// Common pravni-forma codes → human text. Not exhaustive; missing codes
// fall through to the raw numeric code.
const LEGAL_FORMS = {
  '101': 'Fyzická osoba podnikající',
  '111': 'Veřejná obchodní společnost',
  '112': 'Společnost s ručením omezeným',
  '113': 'Společnost komanditní',
  '121': 'Akciová společnost',
  '122': 'Komanditní společnost',
  '301': 'Státní podnik',
  '311': 'Družstvo',
  '312': 'Spotřební družstvo',
  '421': 'Akciová společnost',
  '601': 'Nadace',
  '641': 'Nadační fond',
  '701': 'Sdružení',
  '705': 'Podnikatelské sdružení',
  '706': 'Družstvo',
  '707': 'Odborová organizace',
  '751': 'Obecně prospěšná společnost',
  '761': 'Ústav',
  '801': 'Obec',
  '804': 'Kraj',
};

function httpJson({ method = 'GET', path: p, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: HOST, path: p, method, headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: 404, data: null });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('CZ', `HTTP ${res.statusCode} on ${p}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (e) { reject(new AdapterError('CZ', `JSON parse: ${e.message}`, { cause: e })); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new AdapterError('CZ', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('CZ', err.message, { cause: err })),
    );
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function toDTO(s) {
  if (!s || !s.ico) return null;
  const active = s.seznamRegistraci?.stavZdrojeRos !== 'ZRUSENI' && !s.datumZaniku;
  // ARES returns an array of NACE codes; the first one is the primary activity.
  const naceCode = Array.isArray(s.czNace2008) && s.czNace2008.length ? s.czNace2008[0] : undefined;
  return makeDTO('CZ', {
    nationalId: s.ico,
    legalName: s.obchodniJmeno,
    legalFormCode: s.pravniForma,
    legalFormText: LEGAL_FORMS[s.pravniForma],
    status: active ? 'active' : 'dissolved',
    address: s.sidlo?.textovaAdresa,
    incorporationDate: s.datumVzniku,
    lastUpdated: s.datumAktualizace,
    nace: naceCode ? { code: naceCode } : undefined,
    flags: (s.seznamRegistraci?.stavZdrojeRos === 'ZRUSENI')
      ? { bankrupt: false, inLiquidation: true }
      : undefined,
    source: 'cz',
    raw: s,
  });
}

const DIGITS_ICO = /^\d{1,8}$/;

export default {
  id: 'CZ',
  label: 'Tschechien',
  license: 'Otevřená data ARES — komerční užití povoleno',
  sourceLabel: 'ARES · Ekonomické subjekty',
  sourceUrl: 'https://ares.gov.cz/',
  attribution: 'Zdroj: ARES (otevřená data).',
  hasFinancials: false,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (DIGITS_ICO.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    const { data } = await httpJson({
      method: 'POST',
      path: `${BASE_PATH}/vyhledat`,
      body: { obchodniJmeno: term, pocet: 20 },
    });
    const list = data?.ekonomickeSubjekty || [];
    return list.map(toDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id).padStart(8, '0');
    if (!DIGITS_ICO.test(key)) return null;
    const { status, data } = await httpJson({ path: `${BASE_PATH}/${key}` });
    if (status === 404 || !data) return null;
    return toDTO(data);
  },
};
