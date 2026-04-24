// Denmark — CVR (Centrale Virksomhedsregister) via Datafordeler distribution.
// Endpoint: http://distribution.virk.dk/cvr-permanent/_search     (stamdata)
//           http://distribution.virk.dk/offentliggoerelser/_search (regnskaber)
// Auth:     API key (URL parameter). Register at https://datafordeler.dk/,
//           create an IT-System, then "API-Schlüssel erstellen".
//           The key is sent as a `username=<key>` URL parameter (the
//           Datafordeler convention for free data access).
// License:  Public data — commercial use allowed (Datafordeler terms).
//
// national_id = CVR-nummer, 8 digits.
import http from 'node:http';
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';
import { parseDkIxbrl } from '../dk-ixbrl-parser.js';

const CVR_HOST  = 'distribution.virk.dk';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 15000;

const BILAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const bilanCache = new Map();

function apiKey() {
  return process.env.DK_CVR_API_KEY || null;
}

function appendAuth(url) {
  const key = apiKey();
  if (!key) return null;
  const u = new URL(url);
  // Datafordeler expects the API key as BOTH `username` and `password`
  // URL params (the webuser-style auth repurposed for free-data keys).
  u.searchParams.set('username', key);
  u.searchParams.set('password', key);
  return u.toString();
}

function httpReq(rawUrl, { body = null, method = 'GET', timeout = TIMEOUT_MS, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const authedUrl = appendAuth(rawUrl);
    if (!authedUrl) return reject(new AdapterError('DK', 'DK_CVR_API_KEY missing in .env', { status: 503 }));
    const u = new URL(authedUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      Accept: accept,
      'User-Agent': UA,
    };
    if (body) headers['Content-Type'] = 'application/json';
    const req = lib.request({
      host: u.host,
      path: u.pathname + u.search,
      method,
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 404) return resolve({ status: 404, body: null, buf });
        if (res.statusCode === 401) return reject(new AdapterError('DK', 'Invalid DK_CVR_API_KEY', { status: 503 }));
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('DK', `HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`, { status: 502 }));
        }
        if (accept === 'application/json') {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf.toString('utf8')), buf }); }
          catch (e) { reject(new AdapterError('DK', `JSON parse: ${e.message}`, { cause: e })); }
        } else {
          resolve({ status: res.statusCode, body: null, buf });
        }
      });
    });
    req.on('timeout', () => req.destroy(new AdapterError('DK', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('DK', err.message, { cause: err })),
    );
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function cvrToDTO(hit) {
  // Hit shape: { _source: { Vrvirksomhed: {...} } } or the flat Vrvirksomhed.
  const v = hit?._source?.Vrvirksomhed || hit?.Vrvirksomhed || hit;
  if (!v?.cvrNummer) return null;
  const cvr = String(v.cvrNummer).padStart(8, '0');

  const meta = v.virksomhedMetadata || {};
  const name = meta.nyesteNavn?.navn
    || pickLatest(v.navne, 'navn')
    || null;

  const form = meta.nyesteVirksomhedsform || pickLatest(v.virksomhedsform);
  const addr = meta.nyesteBeliggenhedsadresse || pickLatest(v.beliggenhedsadresse);
  const industry = meta.nyesteHovedbranche || pickLatest(v.hovedbranche);

  const address = addr ? formatAddr(addr) : undefined;
  const status = normalizeStatus(meta.sammensatStatus || v.status?.[0]?.status || 'NORMAL');

  return makeDTO('DK', {
    nationalId: cvr,
    legalName: name,
    legalFormCode: form?.virksomhedsformkode ? String(form.virksomhedsformkode) : undefined,
    legalFormText: form?.kortBeskrivelse || form?.langBeskrivelse,
    status,
    address,
    incorporationDate: meta.stiftelsesDato || v.stiftelsesDato,
    lastUpdated: v.sidstOpdateret,
    nace: industry?.branchekode
      ? { code: String(industry.branchekode), text: industry.branchetekst }
      : undefined,
    employeeCount: typeof meta.nyesteAarsbeskaeftigelse?.antalAnsatte === 'number'
      ? meta.nyesteAarsbeskaeftigelse.antalAnsatte
      : undefined,
    source: 'dk',
    raw: v,
  });
}

function pickLatest(arr, field) {
  if (!Array.isArray(arr) || !arr.length) return null;
  // CVR fields carry `periode: { gyldigFra, gyldigTil }`. Pick the one
  // without gyldigTil, else latest gyldigFra.
  const active = arr.find((x) => !x?.periode?.gyldigTil);
  const chosen = active || arr[arr.length - 1];
  return field ? chosen?.[field] : chosen;
}

function formatAddr(a) {
  const street = [a.vejnavn, a.husnummerFra].filter(Boolean).join(' ');
  const city = [a.postnummer, a.postdistrikt].filter(Boolean).join(' ');
  return [street, city, 'Danmark'].filter(Boolean).join(', ') || undefined;
}

function normalizeStatus(s) {
  const t = String(s || '').toUpperCase();
  if (/OPHØRT|OPLØST|KONKURS|SLETTET|TVANGSOPLØST/.test(t)) return 'dissolved';
  return 'active';
}

const CVR_RE = /^\d{8}$/;

export default {
  id: 'DK',
  label: 'Dänemark',
  license: 'Datafordeler — CVR · frit tilgængelige data',
  sourceLabel: 'Erhvervsstyrelsen · CVR',
  sourceUrl: 'https://datacvr.virk.dk/',
  attribution: 'Kilde: Erhvervsstyrelsen · CVR via Datafordeler.',
  hasFinancials: true,
  get configured() {
    return !!process.env.DK_CVR_API_KEY;
  },

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (CVR_RE.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    const body = {
      from: 0,
      size: 20,
      query: {
        match_phrase_prefix: {
          'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn': { query: term },
        },
      },
    };
    const { body: data } = await httpReq(`http://${CVR_HOST}/cvr-permanent/_search`, {
      method: 'POST',
      body,
    });
    const hits = data?.hits?.hits || [];
    return hits.map(cvrToDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id);
    if (!CVR_RE.test(key)) return null;
    const body = {
      size: 1,
      query: { term: { 'Vrvirksomhed.cvrNummer': Number(key) } },
    };
    const { body: data } = await httpReq(`http://${CVR_HOST}/cvr-permanent/_search`, {
      method: 'POST',
      body,
    });
    const hit = data?.hits?.hits?.[0];
    return hit ? cvrToDTO(hit) : null;
  },

  async getPeople(id) {
    const key = canonId(id);
    if (!CVR_RE.test(key)) return [];
    // People are exposed via the Vrdeltagerperson index with a
    // relation edge pointing at the cvrNummer. Single request, small page.
    try {
      const body = {
        size: 50,
        query: {
          nested: {
            path: 'Vrdeltagerperson.virksomhedSummariskRelation',
            query: {
              term: { 'Vrdeltagerperson.virksomhedSummariskRelation.virksomhed.cvrNummer': Number(key) },
            },
          },
        },
      };
      const { body: data } = await httpReq(`http://${CVR_HOST}/cvr-permanent/_search`, {
        method: 'POST',
        body,
      });
      const hits = data?.hits?.hits || [];
      return hits.map((h) => personHit(h, key)).filter(Boolean);
    } catch {
      return [];
    }
  },

  // Danish annual reports (Årsrapporter) are published via the
  // Offentliggørelser index. Each document has a set of files — we grab the
  // XML/iXBRL representation when available (strukturerede Regnskaber), fall
  // back to PDF parsing later if needed.
  async getFinancials(id) {
    const key = canonId(id);
    if (!CVR_RE.test(key)) return [];
    let hits;
    try {
      const body = {
        from: 0,
        size: 10,
        sort: [{ 'offentliggoerelse.offentliggoerelsesTidspunkt': { order: 'desc' } }],
        query: {
          bool: {
            must: [
              { term: { 'cvrNummer': Number(key) } },
              { term: { 'offentliggoerelse.dokumentType': 'AARSRAPPORT' } },
            ],
          },
        },
      };
      const { body: data } = await httpReq(`http://${CVR_HOST}/offentliggoerelser/_search`, {
        method: 'POST',
        body,
      });
      hits = data?.hits?.hits || [];
    } catch { return []; }

    // One filing per fiscal year — most recent three.
    const byYear = new Map();
    for (const h of hits) {
      const s = h._source || {};
      const end = s.regnskab?.regnskabsperiode?.slutDato;
      if (!end) continue;
      const year = String(end).slice(0, 4);
      const cur = byYear.get(year);
      if (!cur || (s.offentliggoerelse?.offentliggoerelsesTidspunkt || '') >
                  (cur._source.offentliggoerelse?.offentliggoerelsesTidspunkt || '')) {
        byYear.set(year, h);
      }
    }
    const chosen = [...byYear.values()].slice(0, 5);

    const out = [];
    for (const h of chosen) {
      try {
        const kpis = await parseFilingCached(h);
        if (kpis) for (const k of kpis) out.push(k);
      } catch { /* skip */ }
    }
    // Dedup by stichtag (iXBRL emits current + comparative — merge with
    // most-recently-filed winning).
    const byDate = new Map();
    for (const k of out) {
      if (!byDate.has(k.stichtag)) byDate.set(k.stichtag, k);
    }
    return [...byDate.values()].sort((a, b) => a.stichtag.localeCompare(b.stichtag));
  },
};

function personHit(hit, cvr) {
  const p = hit?._source?.Vrdeltagerperson;
  if (!p) return null;
  const name = pickLatest(p.navne, 'navn');
  if (!name) return null;
  // Role from the relation edge for this CVR — pick the most recent org role.
  const rel = (p.virksomhedSummariskRelation || []).find(
    (r) => String(r?.virksomhed?.cvrNummer || '').padStart(8, '0') === cvr,
  );
  const orgRoller = rel?.organisationer || [];
  const role = orgRoller.find((o) => o.hovedtype === 'LEDELSESORGAN')
    || orgRoller[0];
  const roleCode = role?.medlemsData?.[0]?.attributter?.[0]?.vaerdier?.[0]?.vaerdi
    || role?.organisationsNavn?.[0]?.navn
    || null;
  return {
    name,
    role: roleCode,
    roleCode,
    resigned: false,
  };
}

async function parseFilingCached(hit) {
  const s = hit?._source || {};
  const pubId = s.offentliggoerelse?.offentliggoerelsesTidspunkt
    + '|' + (s.cvrNummer || '') + '|' + (s.regnskab?.regnskabsperiode?.slutDato || '');
  const cached = bilanCache.get(pubId);
  if (cached && cached.expires > Date.now()) return cached.kpis;

  const docs = s.offentliggoerelse?.dokumenter || [];
  const ixbrl = docs.find((d) => /xml|ixbrl/i.test(d.dokumentMimeType || d.dokumentType || ''));
  if (!ixbrl?.dokumentUrl) {
    bilanCache.set(pubId, { kpis: null, expires: Date.now() + BILAN_CACHE_TTL_MS });
    return null;
  }
  const { buf } = await httpReq(ixbrl.dokumentUrl, { accept: 'application/xml', timeout: 60000 });
  if (!buf?.length) return null;
  const kpis = parseDkIxbrl(buf, {
    filename: ixbrl.dokumentUrl.split('/').pop(),
    currency: s.regnskab?.valuta || 'DKK',
  });
  bilanCache.set(pubId, { kpis, expires: Date.now() + BILAN_CACHE_TTL_MS });
  return kpis;
}
