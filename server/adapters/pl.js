// Poland — Krajowy Rejestr Sądowy (KRS) via the Ministry of Justice's
// public REST API.
// Endpoints:
//   • https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/<KRS>?rejestr=P&format=json
//     → current state of a company (no auth, no key, no rate limit)
//   • https://wl-api.mf.gov.pl/api/search/nip/<NIP>?date=YYYY-MM-DD
//     → "Biała lista" — VAT whitelist, returns the KRS number for a NIP/REGON
// Auth:     none, fully public
// License:  CC0 — public-sector information re-use allowed for commercial use
//
// national_id is the 10-digit KRS number (e.g. "0000028860"). Lookups by
// NIP (10 digits) or REGON (9 or 14 digits) resolve through wl-api first.
//
// Financials: NOT served. The Repozytorium Dokumentów Finansowych at
// rdf-przegladarka.ms.gov.pl is bot-protected (Incapsula JS challenge),
// so structured access is impossible without a real browser. The
// adapter therefore declares hasFinancials: false until that gate
// changes; KRS itself only flags whether a filing was submitted, not
// the figures.

import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const KRS_HOST = 'api-krs.ms.gov.pl';
const WL_HOST  = 'wl-api.mf.gov.pl';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 12000;

function httpJson(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': UA },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode === 400) return resolve(null);     // invalid input → not-found
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('PL', `HTTP ${res.statusCode} on ${path}: ${raw.slice(0, 200)}`, { status: 502 }));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new AdapterError('PL', `JSON parse: ${e.message}`, { cause: e })); }
      });
    });
    req.on('timeout', () => req.destroy(new AdapterError('PL', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('PL', err.message, { cause: err })),
    );
    req.end();
  });
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

// Resolve a KRS number from a NIP or REGON via Biała lista. Returns
// null when wl-api has no entry for that ID.
async function krsFromTaxId(idType, id) {
  const date = todayIso();
  const path = `/api/search/${idType}/${encodeURIComponent(id)}?date=${date}`;
  const data = await httpJson(WL_HOST, path);
  return data?.result?.subject?.krs || null;
}

function krsToDTO(payload) {
  const o = payload?.odpis?.dane;
  const head = payload?.odpis?.naglowekA;
  if (!o?.dzial1 || !head?.numerKRS) return null;
  const d1 = o.dzial1;
  const dane = d1.danePodmiotu || {};
  const sied = d1.siedzibaIAdres || {};
  const ad   = sied.adres || {};

  const address = [
    [ad.ulica, ad.nrDomu, ad.nrLokalu].filter(Boolean).join(' '),
    [ad.kodPocztowy, ad.miejscowosc].filter(Boolean).join(' '),
    'POLSKA',
  ].filter((s) => s && s.trim()).join(', ');

  const nace = (d1.kapital?.kapitalZakladowy?.opisRodzajuKapitalu)
    ? undefined  // KRS doesn't expose PKD directly; stays null
    : undefined;

  const flags = inferFlags(o);

  return makeDTO('PL', {
    nationalId: head.numerKRS,
    legalName: dane.nazwa,
    legalFormText: dane.formaPrawna,
    status: flags?.bankrupt || flags?.inLiquidation ? 'dissolved' : 'active',
    address: address || undefined,
    incorporationDate: head.dataRejestracjiWKRS ? toIsoDate(head.dataRejestracjiWKRS) : undefined,
    lastUpdated: head.dataOstatniegoWpisu ? toIsoDate(head.dataOstatniegoWpisu) : undefined,
    website: sied.adresStronyInternetowej || undefined,
    flags,
    capital: dane.kapital || undefined,
    nace,
    source: 'pl-krs',
    raw: { regon: dane.identyfikatory?.regon, nip: dane.identyfikatory?.nip, head, dane },
  });
}

function inferFlags(o) {
  const d5 = o.dzial5 || {};
  const d6 = o.dzial6 || {};
  const inLiquidation = !!(o.dzial5?.likwidator || d5.kuratorzy);
  const bankrupt = !!(d5.upadlosc || d6.postepowanieUpadlosciowe);
  if (!inLiquidation && !bankrupt) return undefined;
  return { bankrupt, inLiquidation };
}

function toIsoDate(s) {
  // KRS date format: "DD.MM.YYYY"
  if (!s) return undefined;
  const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

const KRS_RE   = /^\d{10}$/;
const NIP_RE   = /^\d{10}$/;
const REGON_RE = /^(\d{9}|\d{14})$/;

// Both KRS and NIP are 10 digits — disambiguate by the leading digits and
// the source intent. Accept "KRS:0000028860" / "NIP:7740001454" prefixes
// as explicit overrides.
function classify(raw) {
  const s = canonId(raw).replace(/\s+/g, '').toUpperCase();
  const explicit = s.match(/^(KRS|NIP|REGON)[:\s-]?(\d+)$/i);
  if (explicit) {
    const kind = explicit[1].toUpperCase();
    const id = explicit[2];
    if (kind === 'KRS' && KRS_RE.test(id))   return { kind: 'KRS',   id };
    if (kind === 'NIP' && NIP_RE.test(id))   return { kind: 'NIP',   id };
    if (kind === 'REGON' && REGON_RE.test(id)) return { kind: 'REGON', id };
  }
  if (REGON_RE.test(s) && s.length === 14) return { kind: 'REGON', id: s };
  if (REGON_RE.test(s) && s.length === 9)  return { kind: 'REGON', id: s };
  // 10 digits: KRS numbers are right-padded with zeros (start with "00")
  // for almost all real entries. Use that as a heuristic; explicit
  // prefix wins for ambiguous ones.
  if (KRS_RE.test(s) && /^00/.test(s)) return { kind: 'KRS', id: s };
  if (NIP_RE.test(s)) return { kind: 'NIP', id: s };
  return null;
}

export default {
  id: 'PL',
  label: 'Polen',
  license: 'CC0 — KRS open data (Ministerstwo Sprawiedliwości)',
  sourceLabel: 'KRS · Krajowy Rejestr Sądowy',
  sourceUrl: 'https://prs.ms.gov.pl/',
  attribution: 'Źródło: Krajowy Rejestr Sądowy · Ministerstwo Sprawiedliwości RP.',
  hasFinancials: false,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const c = classify(term);
    if (!c) return [];          // free-text name search not exposed by KRS REST
    const hit = await this.getCompany(`${c.kind}:${c.id}`);
    return hit ? [hit] : [];
  },

  async getCompany(id) {
    const c = classify(id);
    if (!c) return null;
    let krs = null;
    if (c.kind === 'KRS') {
      krs = c.id;
    } else if (c.kind === 'NIP') {
      krs = await krsFromTaxId('nip', c.id);
    } else if (c.kind === 'REGON') {
      krs = await krsFromTaxId('regon', c.id);
    }
    if (!krs) return null;
    const data = await httpJson(KRS_HOST, `/api/krs/OdpisAktualny/${encodeURIComponent(krs)}?rejestr=P&format=json`);
    return data ? krsToDTO(data) : null;
  },

  async getPeople(id) {
    const c = classify(id);
    if (!c) return [];
    let krs = c.kind === 'KRS' ? c.id : null;
    if (!krs) krs = await krsFromTaxId(c.kind.toLowerCase(), c.id);
    if (!krs) return [];
    const data = await httpJson(KRS_HOST, `/api/krs/OdpisAktualny/${encodeURIComponent(krs)}?rejestr=P&format=json`);
    const sklad = data?.odpis?.dane?.dzial2?.reprezentacja?.sklad;
    if (!Array.isArray(sklad)) return [];
    return sklad
      .filter((p) => !p.czyZawieszona)
      .map((p) => ({
        // Surnames are GDPR-redacted by KRS for natural persons (asterisks)
        // — we surface what the API returns and let the UI label it.
        name: [p.imiona?.imie, p.nazwisko?.nazwiskoICzlon].filter(Boolean).join(' ').trim() || null,
        role: p.funkcjaWOrganie,
        roleCode: p.funkcjaWOrganie,
        resigned: !!p.czyZawieszona,
      }))
      .filter((x) => x.name);
  },
};
