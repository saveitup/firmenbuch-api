// Adapter interface. Every country adapter must implement this contract.
// Adapters return normalised Company DTOs (see server/normalize.js) or throw.
//
// Philosophy: the adapter is stateless. Caching, persistence, auth concerns
// belong to the server layer. The adapter only knows how to talk to ONE
// upstream register and convert its payload to our DTO.

/**
 * @typedef {Object} CompanyDTO
 * @property {string} country            ISO-3166-1 alpha-2, uppercase
 * @property {string} nationalId          as delivered by the register
 * @property {string} nationalIdCanon     lowercased, whitespace stripped
 * @property {string} legalName
 * @property {string=} legalFormCode
 * @property {string=} legalFormText
 * @property {string=} status             'active' | 'dissolved' | raw string
 * @property {string=} address            freeform single line
 * @property {string=} incorporationDate  ISO 8601 date
 * @property {string=} lei                LEI if known
 * @property {string}  source             adapter id
 * @property {Object=} raw                original upstream payload
 * @property {string}  fetchedAt          ISO 8601 timestamp
 */

/**
 * @typedef {Object} Adapter
 * @property {string}  id                                         country code, uppercase
 * @property {string}  label                                      human-readable country name
 * @property {string}  license                                    short license string, shown in UI
 * @property {boolean} hasFinancials                              true if this adapter can return yearly KPIs
 * @property {(query: string) => Promise<CompanyDTO[]>} search    free-text search → list of hits
 * @property {(id: string) => Promise<CompanyDTO|null>} getCompany  look up a single company by national_id
 */

export function canonId(id) {
  return String(id || '').trim().toLowerCase().replace(/\s+/g, '');
}

export function nowIso() {
  return new Date().toISOString();
}

/** Convenience: build a minimal DTO, filling sane defaults. */
export function makeDTO(country, partial) {
  const nationalId = String(partial.nationalId || '').trim();
  return {
    country,
    nationalId,
    nationalIdCanon: canonId(nationalId),
    legalName: partial.legalName || '',
    legalFormCode: partial.legalFormCode,
    legalFormText: partial.legalFormText,
    status: partial.status,
    address: partial.address,
    incorporationDate: partial.incorporationDate,
    lei: partial.lei,
    source: partial.source || country.toLowerCase(),
    lastUpdated: partial.lastUpdated,        // when the register itself last refreshed the record
    // Enrichment fields — populated by adapters where available.
    website: partial.website,
    phone: partial.phone,
    email: partial.email,
    nace: partial.nace,                      // { code, text }
    employeeCount: partial.employeeCount,
    capital: partial.capital,                // { amount, currency }
    flags: partial.flags,                    // { bankrupt, inLiquidation }
    previousNames: partial.previousNames,    // [{ name, until? }]
    raw: partial.raw,
    fetchedAt: nowIso(),
  };
}

export class AdapterError extends Error {
  constructor(adapterId, message, { status = 502, cause } = {}) {
    super(`[${adapterId}] ${message}`);
    this.adapterId = adapterId;
    this.status = status;
    if (cause) this.cause = cause;
  }
}
