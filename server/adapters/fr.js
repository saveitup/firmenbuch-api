// France — Registre National des Entreprises (INPI).
// Base:    https://registre-national-entreprises.inpi.fr
// Auth:    POST /api/sso/login with email+password → JWT, ~1h lifetime
// License: Licence Ouverte 2.0 (Etalab) — commercial use with attribution
//
// national_id = SIREN (9 digits). INPI returns nested "formality.content"
// payloads with either `personneMorale` (companies) or `personnePhysique`
// (entrepreneurs individuels). We map both but keep the full raw payload
// for callers that need more detail than the DTO exposes.
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';
import { parseFrBilanPdf } from '../fr-bilanz-parser.js';

const BASE = 'https://registre-national-entreprises.inpi.fr';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 45 * 60 * 1000;

let cachedToken = null;     // { value, expires }

// Parsed-bilan cache: INPI bilan id → KPI row. PDFs are big (multi-MB) and
// stable once filed, so we cache aggressively — 24h TTL is conservative.
const BILAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const bilanCache = new Map(); // id → { kpi, expires }

function httpJson({ method = 'GET', path: p, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${BASE}${p}`,
      {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': UA,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) return resolve({ status: 404, data: null });
          if (res.statusCode === 401) return resolve({ status: 401, data: safeParse(raw) });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new AdapterError('FR', `HTTP ${res.statusCode} on ${p}: ${raw.slice(0, 200)}`, { status: 502 }));
          }
          resolve({ status: res.statusCode, data: safeParse(raw) });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new AdapterError('FR', 'timeout')); });
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('FR', err.message, { cause: err })),
    );
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function login() {
  const username = process.env.INPI_USERNAME;
  const password = process.env.INPI_PASSWORD;
  if (!username || !password) {
    throw new AdapterError('FR', 'INPI_USERNAME / INPI_PASSWORD not set in .env', { status: 503 });
  }
  const { data } = await httpJson({
    method: 'POST',
    path: '/api/sso/login',
    body: { username, password },
  });
  const token = data?.token;
  if (!token) throw new AdapterError('FR', 'login returned no token', { status: 502 });
  cachedToken = { value: token, expires: Date.now() + TOKEN_TTL_MS };
  return token;
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  return login();
}

async function authedGet(p) {
  let token = await getToken();
  let res = await httpJson({ path: p, headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    // Stale token — refresh once and retry.
    token = await getToken(true);
    res = await httpJson({ path: p, headers: { Authorization: `Bearer ${token}` } });
  }
  return res;
}

// Binary download with auth + 401 retry. Used for bilan PDFs which can be
// several MB; streamed into a Buffer because the parser needs it all at once.
function httpBinary(p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${BASE}${p}`, {
      method: 'GET',
      headers: { Accept: '*/*', 'User-Agent': UA, Authorization: `Bearer ${token}` },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
    });
    req.on('timeout', () => req.destroy(new AdapterError('FR', 'timeout downloading bilan')));
    req.on('error', (err) => reject(err instanceof AdapterError ? err : new AdapterError('FR', err.message, { cause: err })));
    req.end();
  });
}

async function authedBinary(p) {
  let token = await getToken();
  let r = await httpBinary(p, token);
  if (r.status === 401) {
    token = await getToken(true);
    r = await httpBinary(p, token);
  }
  return r;
}

// INPI payload → DTO. Handles the "formality.content" nested shape.
function toDTO(payload) {
  if (!payload) return null;
  const content = payload.formality?.content || payload.content || payload;
  const pm = content.personneMorale || content.personne_morale;
  const pp = content.personnePhysique || content.personne_physique;

  let legalName, legalFormCode, legalFormText, incorporationDate, status, address;

  if (pm) {
    const identite = pm.identite || {};
    const entreprise = identite.entreprise || {};
    const natureCreation = content.natureCreation || {};
    const denomination = pm.denomination || identite.denomination || entreprise.denomination;
    legalName = denomination || identite.nom || entreprise.libelleNaturePersonneMorale;
    legalFormCode = entreprise.formeJuridique || entreprise.formeJuridiqueCode || identite.formeJuridique || natureCreation.formeJuridique;
    legalFormText = entreprise.libelleFormeJuridique || identite.libelleFormeJuridique;
    // INPI stores incorporation under natureCreation.dateCreation for most
    // modern filings; older records may only have dateImmatriculation on
    // identite.entreprise. Fall through in that order.
    incorporationDate = natureCreation.dateCreation || entreprise.dateImmatriculation || entreprise.dateCreation || identite.dateImmatriculation;
    address = flattenAddress(pm.adresseEntreprise?.adresse || pm.adresse?.adresse || pm.adresseEntreprise);
  } else if (pp) {
    const identite = pp.identite || {};
    const entrepreneur = identite.entrepreneur || {};
    legalName = [entrepreneur.descriptionPersonne?.prenoms?.[0], entrepreneur.descriptionPersonne?.nom]
      .filter(Boolean).join(' ') || entrepreneur.descriptionPersonne?.nom;
    legalFormCode = 'EI';
    legalFormText = 'Entrepreneur individuel';
    incorporationDate = entrepreneur.dateImmatriculation;
    address = flattenAddress(pp.adresseEntreprise?.adresse || pp.adresseEntreprise);
  } else {
    return null;
  }

  const siren = payload.siren || content.siren || pm?.identite?.entreprise?.siren || pp?.identite?.entrepreneur?.siren;
  if (!siren) return null;

  const dateCessation = pm?.identite?.entreprise?.dateCessation || pp?.identite?.entrepreneur?.dateCessation;
  status = dateCessation ? 'dissolved' : 'active';

  const lastUpdated = payload.updatedAt
    || payload.formality?.content?.natureCreation?.dateMiseAJour
    || payload.formality?.derniereMiseAJour
    || content?.dateMiseAJour;

  // Enrichment — best-effort against INPI's moving payload shape.
  const entreprise = pm?.identite?.entreprise || pp?.identite?.entrepreneur || {};
  const descEntreprise = pm?.identite?.description || {};
  const ape = entreprise.codeApe || descEntreprise.codeApe || entreprise.activitePrincipale;
  const apeLabel = entreprise.libelleApe || descEntreprise.libelleApe;
  const nace = ape ? { code: ape, text: apeLabel } : undefined;
  const capitalAmount = descEntreprise.montantCapital || entreprise.capital?.montantCapital;
  const capitalCurrency = descEntreprise.deviseCapital || entreprise.capital?.devise;
  const capital = capitalAmount ? { amount: Number(capitalAmount), currency: capitalCurrency || 'EUR' } : undefined;
  const adrEnt = pm?.adresseEntreprise || pp?.adresseEntreprise || {};
  const website = adrEnt.adresse?.siteInternet || adrEnt.siteInternet;
  const phone = adrEnt.adresse?.telephone || adrEnt.telephone;
  const email = adrEnt.adresse?.courriel || adrEnt.courriel;

  return makeDTO('FR', {
    nationalId: siren,
    legalName,
    legalFormCode,
    legalFormText,
    status,
    address,
    incorporationDate,
    lastUpdated,
    website,
    phone,
    email,
    nace,
    capital,
    source: 'fr',
    raw: payload,
  });
}

// Extract officers from the formality composition block. INPI's payload
// has gone through several shapes; we pattern-match defensively.
function extractPeople(payload) {
  if (!payload) return [];
  const content = payload.formality?.content || payload.content || payload;
  const pm = content.personneMorale || content.personne_morale;
  if (!pm) return [];
  const composition = pm.composition || pm.dirigeants || {};
  const pouvoirs = composition.pouvoirs || composition.dirigeants || composition.representants || [];
  if (!Array.isArray(pouvoirs)) return [];
  const out = [];
  for (const p of pouvoirs) {
    const indiv = p.individu?.descriptionPersonne || p.individu || p.personnePhysique?.descriptionPersonne;
    const pm2 = p.entreprise || p.personneMorale?.identite?.entreprise;
    let name;
    if (indiv) {
      const first = Array.isArray(indiv.prenoms) ? indiv.prenoms[0] : indiv.prenom;
      name = [first, indiv.nom].filter(Boolean).join(' ');
    } else if (pm2) {
      name = pm2.denomination || pm2.nom;
    }
    if (!name) continue;
    out.push({
      name,
      role: p.roleEntreprise || p.role || p.qualite,
      roleCode: p.codeRole,
      resigned: !!p.dateFinPouvoir,
    });
  }
  return out;
}

function flattenAddress(a) {
  if (!a) return undefined;
  const line = [a.numVoie, a.typeVoie, a.voie || a.nomVoie].filter(Boolean).join(' ');
  return [line, [a.codePostal, a.commune].filter(Boolean).join(' '), a.pays]
    .filter(Boolean)
    .join(', ');
}

const DIGITS_9 = /^\d{9}$/;

export default {
  id: 'FR',
  label: 'Frankreich',
  license: 'Licence Ouverte 2.0 — INPI RNE',
  sourceLabel: 'INPI · Registre National des Entreprises',
  sourceUrl: 'https://data.inpi.fr/',
  attribution: 'Source : INPI RNE (Licence de réutilisation homologuée). Ne constitue pas un extrait officiel.',
  hasFinancials: true,
  get configured() { return !!(process.env.INPI_USERNAME && process.env.INPI_PASSWORD); },

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (DIGITS_9.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    // INPI's name-search parameter is `companyName`, NOT `searchTerm`.
    // `searchTerm` is accepted syntactically (HTTP 200) but silently
    // ignored — the API returns a generic unfiltered list, which looked
    // like "same results for every query" to callers. Only `companyName`
    // actually filters by denomination.
    const p = `/api/companies?companyName=${encodeURIComponent(term)}&pageSize=20`;
    const { data } = await authedGet(p);
    const list = data?.companies || data?.results || (Array.isArray(data) ? data : []);
    return list.map(toDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return null;
    const { status, data } = await authedGet(`/api/companies/${key}`);
    if (status === 404 || !data) return null;
    return toDTO(data);
  },

  async getPeople(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return [];
    try {
      const { status, data } = await authedGet(`/api/companies/${key}`);
      if (status === 404 || !data) return [];
      return extractPeople(data);
    } catch {
      return [];
    }
  },

  // Comptes annuels via INPI. The RNE API exposes only PDF filings (no
  // structured XBRL), so we list bilans via /api/bilans?siren[]={SIREN},
  // download the most recent filings, and parse KPIs out of each PDF.
  // Parsing is heuristic (narrative-format tables); the KPI row carries
  // source: 'pdf-heuristic-fr' so the UI can flag confidence.
  async getFinancials(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return [];
    let list;
    try {
      const { status, data } = await authedGet(`/api/bilans?siren[]=${key}`);
      if (status === 404 || !Array.isArray(data)) return [];
      list = data.filter((b) => b.siren === key && b.id);
    } catch { return []; }
    if (!list.length) return [];

    // Pick a single filing type for the whole company and stick with it —
    // mixing "S" (comptes sociaux / parent-only) with "C" (consolidated)
    // produces year-on-year jumps that look like real financial events but
    // are just format changes. Preference order: S > K > C. Within the
    // chosen type, keep one filing per fiscal year (most recent upload
    // wins) and cap at 3 years to bound request latency.
    const withDate = list.filter((b) => b.dateCloture && b.typeBilan);
    let chosenType = null;
    for (const t of ['S', 'K', 'C']) {
      if (withDate.some((b) => b.typeBilan === t)) { chosenType = t; break; }
    }
    if (!chosenType) return [];
    const byYear = new Map();
    for (const b of withDate) {
      if (b.typeBilan !== chosenType) continue;
      const year = b.dateCloture.slice(0, 4);
      const cur = byYear.get(year);
      if (!cur || (b.updatedAt || '') > (cur.updatedAt || '')) byYear.set(year, b);
    }
    const chosen = [...byYear.values()]
      .sort((a, b) => b.dateCloture.localeCompare(a.dateCloture))
      .slice(0, 3);

    const out = [];
    for (const b of chosen) {
      try {
        const kpi = await parseBilanCached(b);
        const sane = sanitiseKpi(kpi);
        if (sane) out.push(sane);
      } catch { /* one bad PDF shouldn't block the rest */ }
    }
    // Oldest first to match the contract expected by the DB layer.
    return out.sort((a, b) => (a.stichtag || '').localeCompare(b.stichtag || ''));
  },

  // List the raw bilan PDFs available at INPI for this SIREN. The UI
  // renders these as download links next to the Kennzahlen, so users can
  // inspect the original document even when heuristic parsing failed
  // (scanned PDFs, exotic layouts, slow OCR). Shape matches the AT
  // adapter's contract: `{ stichtag, pdfKey, title }`.
  async getDocuments(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return [];
    try {
      const { status, data } = await authedGet(`/api/bilans?siren[]=${key}`);
      if (status === 404 || !Array.isArray(data)) return [];
      return data
        .filter((b) => b.siren === key && b.id && b.dateCloture)
        .map((b) => ({
          stichtag: String(b.dateCloture).slice(0, 10),
          // We prefix the key so downloadDocument knows which INPI endpoint
          // to hit. Simpler than adding a separate typed field.
          pdfKey: `bilan:${b.id}`,
          title: `Bilan ${b.typeBilan || '?'} ${String(b.dateCloture).slice(0, 4)}`,
          source_ref: b.id,
          typeBilan: b.typeBilan,
        }))
        .sort((a, b) => b.stichtag.localeCompare(a.stichtag));
    } catch { return []; }
  },

  async downloadDocument(key) {
    if (!key) return null;
    const m = String(key).match(/^bilan:([a-f0-9]+)$/i);
    if (!m) return null;
    const bilanId = m[1];
    const { status, buf, contentType } = await authedBinary(`/api/bilans/${bilanId}/download`);
    if (status !== 200 || !buf?.length) return null;
    return {
      bytes: buf,
      contentType: contentType || 'application/pdf',
      filename: `INPI-bilan-${bilanId}.pdf`,
    };
  },
};

// Sanity check for heuristic parser output. The most common failure mode
// is the EK regex matching a line like "Capital social 169 170" that sits
// inside a consolidated filing — which produces an EK/Bilanz ratio that
// borders on zero. We reject rows where that ratio is outside a wide but
// realistic band for going concerns. Unsafe at the tails (highly leveraged
// banks, pure-equity holdings) but catches the parser errors we see.
// Plausibility pass. Rather than drop the whole row when a single KPI
// looks wrong, we null-out just the implausible fields — users prefer 4/5
// correct KPIs over 0/5. Returns null only when there are no credible
// KPIs left (caller then drops the filing entirely).
function sanitiseKpi(kpi) {
  if (!kpi) return null;
  const CAP = 5_000_000_000_000;  // 5 T € — larger than any non-bank FR balance
  const fields = ['umsatzerloese', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'betriebsergebnis'];
  for (const f of fields) {
    const v = kpi[f];
    if (v != null && Math.abs(v) > CAP) kpi[f] = null;
  }
  // Shareholders' equity vs total assets: must sit in a realistic band.
  // If the ratio is absurd we blank just the equity field — the balance
  // figure is usually the authoritative one and worth keeping.
  if (kpi.bilanzsumme && kpi.eigenkapital != null) {
    const r = kpi.eigenkapital / kpi.bilanzsumme;
    if (r < 0.005 || r > 0.995) kpi.eigenkapital = null;
  }
  kpi.ek_quote = (kpi.bilanzsumme && kpi.eigenkapital != null)
    ? kpi.eigenkapital / kpi.bilanzsumme : null;
  const filled = fields.filter((f) => kpi[f] != null).length;
  return filled >= 1 ? kpi : null;
}

function isPlausibleKpi(kpi) {
  return sanitiseKpi(kpi) != null;
}

async function parseBilanCached(b) {
  const cached = bilanCache.get(b.id);
  if (cached && cached.expires > Date.now()) return cached.kpi;
  const { status, buf, contentType } = await authedBinary(`/api/bilans/${b.id}/download`);
  if (status !== 200 || !buf || !/pdf/i.test(contentType || '')) return null;
  const kpi = await parseFrBilanPdf(buf, {
    dateCloture: b.dateCloture,
    typeBilan: b.typeBilan,
    sourceRef: b.id,
  });
  bilanCache.set(b.id, { kpi, expires: Date.now() + BILAN_CACHE_TTL_MS });
  return kpi;
}
