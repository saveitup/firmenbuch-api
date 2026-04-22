// Helpers to persist and read back normalised CompanyDTOs.
// The DB is a cache, not the source of truth — adapters are called on demand
// and the row is upserted after every successful lookup.
import { getDb } from './db/index.js';
import { canonId } from './adapters/base.js';

export function upsertCompany(dto) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companies (
      country, national_id, national_id_canon, legal_name,
      legal_form_code, legal_form_text, status, address,
      incorporation_date, lei, source, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(country, national_id_canon) DO UPDATE SET
      national_id        = excluded.national_id,
      legal_name         = excluded.legal_name,
      legal_form_code    = excluded.legal_form_code,
      legal_form_text    = excluded.legal_form_text,
      status             = excluded.status,
      address            = excluded.address,
      incorporation_date = excluded.incorporation_date,
      lei                = COALESCE(excluded.lei, companies.lei),
      source             = excluded.source,
      raw_json           = excluded.raw_json,
      last_seen_at       = datetime('now')
  `).run(
    dto.country,
    dto.nationalId,
    dto.nationalIdCanon || canonId(dto.nationalId),
    dto.legalName || null,
    dto.legalFormCode || null,
    dto.legalFormText || null,
    dto.status || null,
    dto.address || null,
    dto.incorporationDate || null,
    dto.lei || null,
    dto.source || dto.country.toLowerCase(),
    dto.raw ? JSON.stringify(dto.raw) : null,
  );
}

export function readCompany(country, nationalIdCanon) {
  const row = getDb()
    .prepare('SELECT * FROM companies WHERE country = ? AND national_id_canon = ?')
    .get(country, nationalIdCanon);
  if (!row) return null;
  return rowToDTO(row);
}

/**
 * Search locally-cached companies by name (LIKE match, case-insensitive).
 * Used by /api/search to prepend companies from our own DB that the upstream
 * register wouldn't rank highly — this is how a query like "Renault" gets
 * Renault SA at the top even though INPI buries it under small shops.
 *
 * Optional `country` narrows the search; `onlyWithFinancials` restricts to
 * rows that already have KPIs in financials_yearly (the practical goal is
 * to surface companies the user can see Kennzahlen for).
 */
export function searchCompaniesLocal(query, { country = null, onlyWithFinancials = false, limit = 10 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  // Strip `%` and `_` so user-typed wildcards don't leak through the LIKE.
  // No backslash-escape needed because the dangerous characters are dropped
  // outright — safer than ESCAPE-clauses across SQLite versions.
  const pattern = `%${q.replace(/[%_]/g, '').toUpperCase()}%`;
  const params = [pattern];
  let sql = 'SELECT c.* FROM companies c';
  if (onlyWithFinancials) {
    sql += ' JOIN financials_yearly f ON f.country = c.country AND f.national_id_canon = c.national_id_canon';
  }
  sql += ' WHERE UPPER(c.legal_name) LIKE ?';
  if (country) {
    sql += ' AND c.country = ?';
    params.push(country);
  }
  if (onlyWithFinancials) sql += ' GROUP BY c.country, c.national_id_canon';
  sql += ' ORDER BY length(c.legal_name) ASC LIMIT ?';
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params);
  return rows.map(rowToDTO);
}

function rowToDTO(row) {
  return {
    country: row.country,
    nationalId: row.national_id,
    nationalIdCanon: row.national_id_canon,
    legalName: row.legal_name,
    legalFormCode: row.legal_form_code,
    legalFormText: row.legal_form_text,
    status: row.status,
    address: row.address,
    incorporationDate: row.incorporation_date,
    lei: row.lei,
    source: row.source,
    raw: row.raw_json ? safeParse(row.raw_json) : undefined,
    fetchedAt: row.last_seen_at,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

/**
 * Upsert yearly KPIs for a company. `rows` is an array of objects matching
 * the adapter getFinancials() output (see server/adapters/base DTO docs).
 * Called after a fresh adapter.getFinancials() — cached rows accumulate a
 * time series over repeat calls.
 */
export function upsertFinancials(country, nationalIdCanon, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO financials_yearly (
      country, national_id_canon, stichtag, source_ref, currency,
      umsatzerloese, bilanzsumme, eigenkapital, jahresergebnis,
      betriebsergebnis, arbeitnehmer, ek_quote, balance_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(country, national_id_canon, stichtag) DO UPDATE SET
      source_ref       = excluded.source_ref,
      currency         = excluded.currency,
      umsatzerloese    = excluded.umsatzerloese,
      bilanzsumme      = excluded.bilanzsumme,
      eigenkapital     = excluded.eigenkapital,
      jahresergebnis   = excluded.jahresergebnis,
      betriebsergebnis = excluded.betriebsergebnis,
      arbeitnehmer     = excluded.arbeitnehmer,
      ek_quote         = excluded.ek_quote,
      balance_json     = COALESCE(excluded.balance_json, financials_yearly.balance_json),
      computed_at      = datetime('now')
  `);
  const tx = db.transaction((batch) => {
    for (const r of batch) {
      stmt.run(
        country, nationalIdCanon, r.stichtag,
        r.source_ref || null, r.currency || null,
        r.umsatzerloese ?? null, r.bilanzsumme ?? null,
        r.eigenkapital ?? null, r.jahresergebnis ?? null,
        r.betriebsergebnis ?? null, r.arbeitnehmer ?? null,
        r.ek_quote ?? null,
        r.balanceSheet ? JSON.stringify(r.balanceSheet) : null,
      );
    }
  });
  tx(rows);
  return rows.length;
}

/** OCR text cache: read */
export function readOcrText(country, documentKey) {
  const row = getDb().prepare(`
    SELECT ocr_text FROM ocr_text_cache
    WHERE country = ? AND document_key = ?
  `).get(country, documentKey);
  return row?.ocr_text ?? null;
}

/** OCR text cache: write */
export function writeOcrText(country, documentKey, ocrText) {
  if (!ocrText) return;
  getDb().prepare(`
    INSERT INTO ocr_text_cache (country, document_key, ocr_text)
    VALUES (?, ?, ?)
    ON CONFLICT(country, document_key) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      computed_at = datetime('now')
  `).run(country, documentKey, ocrText);
}

/** Read all yearly KPIs for a company, oldest first. */
export function readFinancials(country, nationalIdCanon) {
  const rows = getDb().prepare(`
    SELECT stichtag, currency, umsatzerloese, bilanzsumme, eigenkapital,
           jahresergebnis, betriebsergebnis, arbeitnehmer, ek_quote, balance_json
    FROM financials_yearly
    WHERE country = ? AND national_id_canon = ?
    ORDER BY stichtag ASC
  `).all(country, nationalIdCanon);
  for (const r of rows) {
    if (r.balance_json) {
      try { r.balanceSheet = JSON.parse(r.balance_json); } catch {}
    }
    delete r.balance_json;
  }
  return rows;
}
