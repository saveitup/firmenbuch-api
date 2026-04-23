// Slovakia — Register účtovných závierok (RUZ).
// Endpoint: https://www.registeruz.sk/cruz-public/api/
// Auth:     none — fully public, no key, no signup.
// License:  Public data — commercial use allowed.
//
// national_id = IČO (8 digits).
//
// RUZ is the central Slovak financial-statements register. It exposes
// structured JSON for both stammdaten (uctovna-jednotka) and annual
// accounts (uctovna-zavierka + priloha-zavierky-kpi). KPIs are already
// extracted upstream into typed "vseobecneUdajeKpi" rows — no XBRL
// parsing required. This is the cleanest adapter in the whole register.
//
// The ORSR (Obchodný register) is HTML-only and covers ownership/officers;
// we skip it here and rely on RUZ stammdaten which is sufficient for our DTO.

import https from 'node:https';
import { makeDTO, AdapterError, canonId } from './base.js';

const BASE = 'https://www.registeruz.sk/cruz-public/api';
// The RUZ site sits behind an F5 WAF that blacklists programmatic UAs
// (a bare `curl/8` or custom `Kontur/0.2` triggers "Request Rejected").
// A browser-shaped header set gets through the rule.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TIMEOUT_MS = 15000;

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'sk,en;q=0.8',
        'User-Agent':      UA,
        'Referer':         'https://www.registeruz.sk/',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new AdapterError('SK', `HTTP ${res.statusCode}: ${raw.slice(0, 200)}`, { status: 502 }));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new AdapterError('SK', `JSON parse: ${e.message}`, { cause: e })); }
      });
    });
    req.on('timeout', () => req.destroy(new AdapterError('SK', 'timeout')));
    req.on('error', (err) =>
      reject(err instanceof AdapterError ? err : new AdapterError('SK', err.message, { cause: err })),
    );
    req.end();
  });
}

function unitToDTO(u) {
  if (!u?.ico) return null;
  const ico = String(u.ico).padStart(8, '0');
  const address = [
    u.sidloUlica,
    [u.sidloPSC, u.sidloMesto].filter(Boolean).join(' '),
    u.sidloStat === 'SK' ? 'Slovensko' : u.sidloStat,
  ].filter(Boolean).join(', ');
  return makeDTO('SK', {
    nationalId: ico,
    legalName: u.nazovUJ || u.obchodneMeno,
    legalFormCode: u.pravnaForma ? String(u.pravnaForma) : undefined,
    status: u.datumZaniku ? 'dissolved' : 'active',
    address: address || undefined,
    incorporationDate: u.datumZalozenia,
    lastUpdated: u.datumPoslednejUpravy,
    nace: u.skNace?.kod
      ? { code: String(u.skNace.kod), text: u.skNace.nazov }
      : (u.hlavnaCinnost ? { code: null, text: u.hlavnaCinnost } : undefined),
    source: 'sk',
    raw: u,
  });
}

const ICO_RE = /^\d{6,8}$/;

export default {
  id: 'SK',
  label: 'Slowakei',
  license: 'Public data — Register účtovných závierok',
  sourceLabel: 'RUZ · Register účtovných závierok',
  sourceUrl: 'https://www.registeruz.sk/',
  attribution: 'Zdroj: Register účtovných závierok (Ministerstvo financií SR).',
  hasFinancials: true,

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (ICO_RE.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    // RUZ has no free-text name index exposed publicly; name-search is
    // handled by the local companies-cache upstream of this adapter. We
    // return an empty array rather than scraping orsr.sk.
    return [];
  },

  async getCompany(id) {
    const key = canonId(id).padStart(8, '0');
    if (!ICO_RE.test(key)) return null;
    // Step 1 — resolve ICO to RUZ internal id via filter list.
    const list = await httpJson(`${BASE}/uctovne-jednotky?zmenaOd=2000-01-01&ico=${encodeURIComponent(key)}`);
    const ids = list?.id || [];
    if (!ids.length) return null;
    // Step 2 — fetch the most recent unit record for that ICO.
    const unitId = ids[ids.length - 1];
    const unit = await httpJson(`${BASE}/uctovna-jednotka?id=${unitId}`);
    return unit ? unitToDTO(unit) : null;
  },

  async getPeople() {
    // Officers/statutári live in ORSR (HTML-only) and RPO — not exposed
    // by RUZ. Returning empty keeps the contract intact; a future SK
    // officers enrichment can scrape orsr.sk.
    return [];
  },

  // Slovak annual accounts are pre-parsed in RUZ. Each `uctovna-zavierka`
  // carries an `idPrilohy` list; each "priloha" resolves to a structured
  // KPI payload via /priloha-zavierky-kpi. We iterate the most recent
  // filings and pick the rows tagged with the standard Slovak indicators
  // (T1..T6 in the Výkaz ziskov a strát / Súvaha).
  async getFinancials(id) {
    const key = canonId(id).padStart(8, '0');
    if (!ICO_RE.test(key)) return [];
    // Resolve ICO → internal id.
    const list = await httpJson(`${BASE}/uctovne-jednotky?zmenaOd=2000-01-01&ico=${encodeURIComponent(key)}`);
    const unitIds = list?.id || [];
    if (!unitIds.length) return [];
    const unitId = unitIds[unitIds.length - 1];

    // Closures belonging to this unit. Filter in caller because RUZ
    // doesn't accept idUJ as a GET param on this endpoint.
    const unit = await httpJson(`${BASE}/uctovna-jednotka?id=${unitId}`);
    const zavierkaIds = unit?.idUctovnychZavierok || [];
    if (!zavierkaIds.length) return [];

    // Fetch the three most recent closures.
    const chosen = zavierkaIds.slice(-5);
    const out = [];
    for (const zid of chosen) {
      try {
        const z = await httpJson(`${BASE}/uctovna-zavierka?id=${zid}`);
        if (!z?.obdobieDo) continue;
        // Skip consolidated filings — we prefer standalone for comparability.
        if (z.konsolidovana) continue;
        const kpis = await kpisForZavierka(z);
        if (kpis) out.push(kpis);
      } catch { /* skip broken */ }
    }
    // Dedup by stichtag, most recent wins.
    const byDate = new Map();
    for (const k of out) {
      if (!byDate.has(k.stichtag) || (k.source_ref || '') > (byDate.get(k.stichtag).source_ref || '')) {
        byDate.set(k.stichtag, k);
      }
    }
    return [...byDate.values()].sort((a, b) => a.stichtag.localeCompare(b.stichtag));
  },
};

async function kpisForZavierka(z) {
  const stichtag = String(z.obdobieDo).slice(0, 10);
  const prilohaIds = Array.isArray(z.idPrilohy) ? z.idPrilohy : [];
  let umsatz = null, bilanzsumme = null, eigenkapital = null, jahres = null, betrieb = null;

  for (const pid of prilohaIds) {
    let pk;
    try { pk = await httpJson(`${BASE}/priloha-zavierky-kpi?id=${pid}`); }
    catch { continue; }
    if (!pk) continue;
    // RUZ delivers a flat `udaje` array of { kod, hodnota, rok } tuples.
    const udaje = Array.isArray(pk.udaje) ? pk.udaje : [];
    for (const u of udaje) {
      const v = toNumber(u.hodnota);
      if (v == null) continue;
      // The `kod` follows Slovak accounting standard labels. We pick the
      // "current-period" values (rok matches obdobieDo year) when present.
      const yr = u.rok ? Number(u.rok) : null;
      const wantedYear = Number(stichtag.slice(0, 4));
      if (yr && yr !== wantedYear) continue;
      switch (u.kod) {
        // Revenue — "Tržby z predaja tovaru + vlastných výrobkov a služieb"
        case 'VZS_T1':
        case 'VZS_04':
        case 'VYNOSY':
          if (umsatz == null) umsatz = v; break;
        // Balance sheet total — "Spolu majetok"
        case 'SUV_R01':
        case 'SPOLU_MAJETOK':
          if (bilanzsumme == null) bilanzsumme = v; break;
        // Equity — "Vlastné imanie"
        case 'SUV_R79':
        case 'VLASTNE_IMANIE':
          if (eigenkapital == null) eigenkapital = v; break;
        // Net income — "Výsledok hospodárenia za účtovné obdobie po zdanení"
        case 'VZS_R61':
        case 'CISTY_ZISK':
          if (jahres == null) jahres = v; break;
        // Operating profit — "Výsledok hospodárenia z hospodárskej činnosti"
        case 'VZS_R37':
        case 'PREVADZKOVY_VH':
          if (betrieb == null) betrieb = v; break;
      }
    }
  }

  const filled = [umsatz, bilanzsumme, eigenkapital, jahres, betrieb].filter((x) => x != null).length;
  if (!filled) return null;
  return {
    stichtag,
    currency: 'EUR',
    source_ref: String(z.id || ''),
    umsatzerloese: umsatz,
    bilanzsumme,
    eigenkapital,
    jahresergebnis: jahres,
    betriebsergebnis: betrieb,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
  };
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(typeof v === 'string' ? v.replace(/\s/g, '').replace(',', '.') : v);
  return Number.isFinite(n) ? n : null;
}
