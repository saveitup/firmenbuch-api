// Czech Republic — ARES (Administrativní registr ekonomických subjektů)
// for stamm + or.justice.cz Sbírka listin for filings discovery.
//
// Endpoints:
//   POST ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat — search
//   GET  ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}    — detail
//   GET  or.justice.cz/ias/ui/rejstrik-$firma?ico={ico}     — resolves ICO → subjektId
//   GET  or.justice.cz/ias/ui/vypis-sl-firma?subjektId=...  — list of filings
//   GET  or.justice.cz/ias/ui/vypis-sl-detail?dokument=...&subjektId=...&spis=... — PDF resolver
//
// License: Open Data, commercial reuse allowed.
// No auth, no key.
//
// hasFinancials stays false: we surface the filings as downloadable PDFs
// via getDocuments() but don't yet auto-extract Rozvaha / Výkaz z. a z.
// KPIs — that needs a Czech bilanz parser comparable to fr-bilanz-parser
// and is a follow-up task.
//
// national_id = IČO (8 digits, may have leading zeros).
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const HOST = 'ares.gov.cz';
const OR_HOST = 'or.justice.cz';
const BASE_PATH = '/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;

// (subjektId, filings, detail PDF URL) caches keyed by ICO and dokument.
const SUBJEKT_TTL_MS  = 24 * 60 * 60 * 1000;
const DOCS_TTL_MS     = 60 * 60 * 1000;
const subjektCache = new Map();
const docsCache    = new Map();

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

  // Sbírka listin filings list — resolves ICO → subjektId → filings page,
  // returns each "účetní závěrka [YYYY]" entry as a downloadable doc.
  // Other filing types (notářský zápis, výroční zpráva) are surfaced too
  // so the UI can offer them; the server's downloadDocument() proxies the
  // actual PDF.
  async getDocuments(id) {
    const ico = canonId(id).padStart(8, '0');
    if (!DIGITS_ICO.test(ico)) return [];
    try {
      const subjektId = await resolveSubjektId(ico);
      if (!subjektId) return [];
      return await listFilings(subjektId);
    } catch { return []; }
  },

  async downloadDocument(key) {
    if (!key) return null;
    const m = String(key).match(/^cz-doc:(\d+):(\d+):(\d+)$/);
    if (!m) return null;
    const [, dokument, subjektId, spis] = m;
    const pdfPath = await resolveDocPdfPath(dokument, subjektId, spis);
    if (!pdfPath) return null;
    const { status, buf, contentType } = await httpBinary(`https://${OR_HOST}${pdfPath}`);
    if (status !== 200 || !buf?.length) return null;
    return {
      bytes: buf,
      contentType: contentType || 'application/pdf',
      filename: `Sbirka-${dokument}.pdf`,
    };
  },
};

// ─── or.justice.cz helpers ─────────────────────────────────────────────

function httpHtml(url, { timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return httpHtml(new URL(res.headers.location, url).toString(), { timeout }).then(resolve, reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('CZ', `HTTP ${res.statusCode} on ${url}`, { status: 502 }));
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    }).on('timeout', function () { this.destroy(new AdapterError('CZ', 'timeout')); })
      .on('error', (err) => reject(err instanceof AdapterError ? err : new AdapterError('CZ', err.message, { cause: err })))
      .end();
  });
}

function httpBinary(url, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const go = (target, hops) => {
      if (hops > 5) return reject(new AdapterError('CZ', 'too many redirects'));
      https.request({
        host: target.host,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { Accept: 'application/pdf,*/*', 'User-Agent': UA },
        timeout,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return go(new URL(res.headers.location, target), hops + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          buf: Buffer.concat(chunks),
          contentType: res.headers['content-type'],
        }));
      }).on('timeout', function () { this.destroy(new AdapterError('CZ', 'download timeout')); })
        .on('error', (err) => reject(err instanceof AdapterError ? err : new AdapterError('CZ', err.message, { cause: err })))
        .end();
    };
    go(u, 0);
  });
}

async function resolveSubjektId(ico) {
  const cached = subjektCache.get(ico);
  if (cached && cached.expires > Date.now()) return cached.subjektId;
  const html = await httpHtml(`https://${OR_HOST}/ias/ui/rejstrik-$firma?ico=${encodeURIComponent(ico)}`);
  const m = html.match(/subjektId=(\d+)/);
  const subjektId = m ? m[1] : null;
  subjektCache.set(ico, { subjektId, expires: Date.now() + SUBJEKT_TTL_MS });
  return subjektId;
}

// Wicket renders one <tr> per filing on the Sbírka listin page. Each row
// has a `dokument=<id>` link, an optional date column (DD.MM.YYYY) and one
// or more <span class="symbol">type [YYYY]</span> tokens.
async function listFilings(subjektId) {
  const cached = docsCache.get(subjektId);
  if (cached && cached.expires > Date.now()) return cached.docs;
  const html = await httpHtml(`https://${OR_HOST}/ias/ui/vypis-sl-firma?subjektId=${encodeURIComponent(subjektId)}`);
  const docs = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/g;
  let row;
  while ((row = trRe.exec(html)) !== null) {
    const tr = row[0];
    const dm = tr.match(/dokument=(\d+)/);
    if (!dm) continue;
    const dokument = dm[1];
    const sm = tr.match(/spis=(\d+)/);
    const spis = sm ? sm[1] : '0';
    const types = [...tr.matchAll(/<span class="symbol">([^<]+)<\/span>/g)].map((m) => m[1].trim());
    const dateMatch = tr.match(/(\d{2}\.\d{2}\.\d{4})/);
    const stichtag = dateMatch ? toIsoDate(dateMatch[1]) : null;
    const yearMatch = types.join(' ').match(/\[(\d{4})\]/);
    const yearFallback = yearMatch ? `${yearMatch[1]}-12-31` : null;
    const isAccounts = types.some((t) => /účetní závěrka/i.test(t));
    docs.push({
      stichtag: stichtag || yearFallback,
      pdfKey: `cz-doc:${dokument}:${subjektId}:${spis}`,
      title: types.join(' · ') || 'Listina',
      source_ref: dokument,
      filedAt: stichtag,
      isAccounts,
    });
  }
  // "účetní závěrka" entries first, then by stichtag desc.
  docs.sort((a, b) => {
    if (a.isAccounts !== b.isAccounts) return a.isAccounts ? -1 : 1;
    return (b.stichtag || '').localeCompare(a.stichtag || '');
  });
  docsCache.set(subjektId, { docs, expires: Date.now() + DOCS_TTL_MS });
  return docs;
}

// Detail page -> /ias/content/download?id=<hash>. We extract the path so
// the caller can stream it through downloadDocument().
async function resolveDocPdfPath(dokument, subjektId, spis) {
  const html = await httpHtml(
    `https://${OR_HOST}/ias/ui/vypis-sl-detail?dokument=${dokument}&subjektId=${subjektId}&spis=${spis}`,
  );
  const m = html.match(/href="(\/ias\/content\/download\?[^"]+)"/);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function toIsoDate(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
