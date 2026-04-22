// Norway — Enhetsregisteret (Brønnøysundregistrene).
// Endpoint: https://data.brreg.no/enhetsregisteret/api/enheter
// License: NLOD 2.0 — commercial use allowed with attribution.
// No auth, no key, stable JSON.
//
// national_id here = organisasjonsnummer (9 digits).
import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const BASE = 'https://data.brreg.no/enhetsregisteret/api';
const UA = 'Kontur/0.2 (+https://github.com/)';
const TIMEOUT_MS = 8000;

function call(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('NO', `HTTP ${res.statusCode} on ${url}`, { status: 502 }));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new AdapterError('NO', `JSON parse failed: ${e.message}`, { cause: e })); }
      });
    });
    req.on('timeout', () => { req.destroy(new AdapterError('NO', 'timeout')); });
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('NO', err.message, { cause: err })),
    );
  });
}

function toDTO(enhet) {
  if (!enhet || !enhet.organisasjonsnummer) return null;
  const addr = enhet.forretningsadresse || enhet.postadresse;
  const address = addr
    ? [
        Array.isArray(addr.adresse) ? addr.adresse.filter(Boolean).join(', ') : addr.adresse,
        [addr.postnummer, addr.poststed].filter(Boolean).join(' '),
        addr.land,
      ].filter(Boolean).join(', ')
    : undefined;
  const nace = enhet.naeringskode1
    ? { code: enhet.naeringskode1.kode, text: enhet.naeringskode1.beskrivelse }
    : undefined;
  const flags = (enhet.konkurs || enhet.underAvvikling || enhet.underTvangsavviklingEllerTvangsopplosning)
    ? {
        bankrupt: !!enhet.konkurs,
        inLiquidation: !!(enhet.underAvvikling || enhet.underTvangsavviklingEllerTvangsopplosning),
      }
    : undefined;
  return makeDTO('NO', {
    nationalId: enhet.organisasjonsnummer,
    legalName: enhet.navn,
    legalFormCode: enhet.organisasjonsform?.kode,
    legalFormText: enhet.organisasjonsform?.beskrivelse,
    status: enhet.slettedato ? 'dissolved' : 'active',
    address,
    incorporationDate: enhet.stiftelsesdato,
    lastUpdated: enhet.registreringsdatoEnhetsregisteret,
    website: enhet.hjemmeside,
    phone: enhet.telefon,
    email: enhet.epostadresse,
    nace,
    employeeCount: typeof enhet.antallAnsatte === 'number' ? enhet.antallAnsatte : undefined,
    flags,
    source: 'no',
    raw: enhet,
  });
}

function roleToPerson(r) {
  if (!r || r.avregistrert) return null;
  const name = r.person
    ? [r.person.navn?.fornavn, r.person.navn?.mellomnavn, r.person.navn?.etternavn].filter(Boolean).join(' ')
    : r.enhet?.navn?.[0] || r.enhet?.organisasjonsnummer;
  if (!name) return null;
  return {
    name,
    role: r.type?.beskrivelse,
    roleCode: r.type?.kode,
    resigned: !!r.fratraadt,
  };
}

const DIGITS_9 = /^\d{9}$/;

export default {
  id: 'NO',
  label: 'Norwegen',
  license: 'NLOD 2.0 — Brønnøysundregistrene',
  sourceLabel: 'Brønnøysundregistrene · Enhetsregisteret',
  sourceUrl: 'https://www.brreg.no/',
  attribution: 'Kilde: Brønnøysundregistrene (NLOD 2.0).',
  hasFinancials: true,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];

    // If the query is a 9-digit orgnr, go straight to the detail endpoint.
    const stripped = term.replace(/\s+/g, '');
    if (DIGITS_9.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }

    const url = new URL(`${BASE}/enheter`);
    url.searchParams.set('navn', term);
    url.searchParams.set('size', '20');
    const data = await call(url.toString());
    const list = data?._embedded?.enheter || [];
    return list.map(toDTO).filter(Boolean);
  },

  async getCompany(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return null;
    const data = await call(`${BASE}/enheter/${key}`);
    return data ? toDTO(data) : null;
  },

  async getPeople(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return [];
    try {
      const data = await call(`${BASE}/enheter/${key}/roller`);
      const groups = data?.rollegrupper || [];
      const out = [];
      for (const g of groups) {
        for (const r of g.roller || []) {
          const p = roleToPerson(r);
          if (p) out.push(p);
        }
      }
      return out;
    } catch {
      return [];
    }
  },

  // Regnskapsregisteret: most-recent annual accounts (one filing per call).
  // Over time the cached `financials_yearly` rows build up a time series.
  async getFinancials(id) {
    const key = canonId(id);
    if (!DIGITS_9.test(key)) return [];
    try {
      const rows = await call(`https://data.brreg.no/regnskapsregisteret/regnskap/${key}`);
      if (!Array.isArray(rows)) return [];
      return rows.map(accountsToKPI).filter(Boolean);
    } catch {
      return [];
    }
  },
};

function accountsToKPI(r) {
  if (!r?.regnskapsperiode?.tilDato) return null;
  const er = r.resultatregnskapResultat || {};
  const dr = er.driftsresultat || {};
  const inntekter = dr.driftsinntekter || {};
  const eg = r.egenkapitalGjeld || {};
  const eiend = r.eiendeler || {};
  const gjeld = eg.gjeldOversikt || {};

  const eigenkapital = toNumber(eg.egenkapital?.sumEgenkapital);
  const bilanzsumme  = toNumber(eg.sumEgenkapitalGjeld ?? eiend.sumEiendeler);
  const umsatz       = toNumber(inntekter.sumDriftsinntekter);
  const ekQuote = (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null;

  // Map Brreg roll-ups into our shared `balanceSheet` shape. Brreg only exposes
  // totals (no split of Anlage/Umlauf into sub-positions) — unreported fields
  // stay `null` so ratios that need them surface as "Nicht verfügbar".
  const sumGjeld   = toNumber(gjeld.sumGjeld);
  const langsiktig = toNumber(gjeld.langsiktigGjeld?.sumLangsiktigGjeld);
  const balanceSheet = {
    aktiva: {
      total: bilanzsumme,
      anlagevermoegen: {
        total:         toNumber(eiend.anleggsmidler?.sumAnleggsmidler),
        immaterielle:  null,
        sachanlagen:   null,
        finanzanlagen: null,
      },
      umlaufvermoegen: {
        total:         toNumber(eiend.omloepsmidler?.sumOmloepsmidler),
        vorraete:      null,
        forderungen:   null,
        wertpapiere:   null,
        kassenbestand: null,
      },
      rechnungsabgrenzung: null,
    },
    passiva: {
      total: bilanzsumme,
      eigenkapital: {
        total:             eigenkapital,
        // Norwegian EK split: innskutt (paid-in, ~ Stamm+Kapitalrücklagen)
        //                    opptjent (retained, ~ Gewinnrücklagen+Bilanzgewinn).
        stammkapital:      toNumber(eg.egenkapital?.innskuttEgenkapital?.sumInnskuttEgenkaptial),
        kapitalruecklagen: null,
        gewinnruecklagen:  toNumber(eg.egenkapital?.opptjentEgenkapital?.sumOpptjentEgenkapital),
        bilanzgewinn:      { total: null, gewinnvortrag: null, jahresueberschuss: toNumber(er.aarsresultat) },
      },
      rueckstellungen: null,
      verbindlichkeiten: { total: sumGjeld, langfristig: langsiktig },
      rechnungsabgrenzung: null,
    },
  };

  return {
    stichtag: r.regnskapsperiode.tilDato,
    currency: r.valuta || 'NOK',
    source_ref: r.journalnr || (r.id && String(r.id)),
    umsatzerloese: umsatz,
    betriebsergebnis: toNumber(dr.driftsresultat),
    jahresergebnis: toNumber(er.aarsresultat),
    bilanzsumme,
    eigenkapital,
    ek_quote: ekQuote,
    arbeitnehmer: null,
    balanceSheet,
  };
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
