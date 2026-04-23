// Slovenia — AJPES (Agencija RS za javnopravne evidence in storitve).
// national_id = matična številka (7 digits).
//
// AJPES does NOT publish a free JSON/REST API. Practical free paths:
//   • PRS Bulk ZIP (monthly, CSV) — https://www.ajpes.si/Registri/Poslovni_register/...
//     Stammdaten, would require a local ingest pipeline.
//   • PRS per-company HTML        — https://www.ajpes.si/prs/podjetjeSRG.asp
//     Per-company lookup, captcha kicks in above ~20-30 rq/min.
//   • JOLP HTML                    — https://www.ajpes.si/jolp/
//     Annual reports as HTML tables with stable AOP row numbers
//     (AOP 110 = Revenue, 151 = EBIT, 186 = Net profit, 001 = Total
//     assets, 056 = Equity). Parsing those rows is the realistic
//     financials path here — no public XBRL download exists.
//
// This adapter is a STUB — it implements the shape so SI shows up in the
// /api/countries listing with `hasFinancials: false` and `configured:
// false`, signalling that a proper ingest+scrape pipeline is still TODO.
// Keeping the file in place unblocks wiring and UI work ahead of the
// full implementation.

import { makeDTO } from './base.js';

const MATICNA_RE = /^\d{7}$/;

export default {
  id: 'SI',
  label: 'Slowenien',
  license: 'Public data — AJPES (non-API; bulk/scrape required)',
  sourceLabel: 'AJPES · PRS / JOLP',
  sourceUrl: 'https://www.ajpes.si/',
  attribution: 'Vir: AJPES — Poslovni register Slovenije (PRS) in JOLP.',
  hasFinancials: false,
  coverage: 'stub',
  get configured() { return false; },

  async search(q) {
    const term = String(q || '').trim();
    if (!term) return [];
    const stripped = term.replace(/\s+/g, '');
    if (MATICNA_RE.test(stripped)) {
      const hit = await this.getCompany(stripped);
      return hit ? [hit] : [];
    }
    return [];
  },

  async getCompany(id) {
    const key = String(id || '').replace(/\D+/g, '');
    if (!MATICNA_RE.test(key)) return null;
    // Placeholder: real implementation will GET
    // https://www.ajpes.si/prs/podjetjeSRG.asp?s=1&e=<maticna>
    // and parse firma/naslov/status from the HTML. Omitted here until
    // captcha/ToS behaviour is verified against live traffic.
    return makeDTO('SI', {
      nationalId: key,
      legalName: null,
      source: 'si-stub',
      raw: { stub: true, reason: 'AJPES has no free API; see adapter header for plan.' },
    });
  },

  async getPeople() { return []; },

  // Financials require JOLP HTML scrape against AOP rows, or the PRS
  // bulk CSV ingest. Returning [] keeps the contract; hasFinancials:false
  // tells the UI not to show a Kennzahlen tab for SI.
  async getFinancials() { return []; },
};
