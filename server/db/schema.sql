-- Kontur schema (SQLite) — multi-country company registry.
-- Composite key (country, national_id) instead of Austrian fnr.
-- Country codes are ISO 3166-1 alpha-2, uppercase (AT, DE, FR, ...).

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ─────────── Companies ───────────
CREATE TABLE IF NOT EXISTS companies (
  country            TEXT NOT NULL,
  national_id        TEXT NOT NULL,                    -- as delivered by the register (e.g. FN for AT, HRB for DE, SIREN for FR)
  national_id_canon  TEXT NOT NULL,                    -- lowercased, whitespace stripped
  legal_name         TEXT,
  legal_form_code    TEXT,
  legal_form_text    TEXT,
  status             TEXT,                             -- 'active' | 'dissolved' | registry-specific string
  address            TEXT,                             -- freeform single line; structured fields in raw_json
  incorporation_date TEXT,
  lei                TEXT,                             -- if known (GLEIF cross-ref)
  source             TEXT NOT NULL,                    -- adapter id (e.g. 'at', 'de', 'gleif')
  raw_json           TEXT,                             -- original adapter payload for debugging
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (country, national_id_canon)
);
CREATE INDEX IF NOT EXISTS idx_companies_name    ON companies(legal_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(country);
CREATE INDEX IF NOT EXISTS idx_companies_status  ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_lei     ON companies(lei);

-- ─────────── Flat yearly KPIs (time series; country-agnostic) ───────────
-- Populated only for countries where the adapter exposes financial filings.
CREATE TABLE IF NOT EXISTS financials_yearly (
  country            TEXT NOT NULL,
  national_id_canon  TEXT NOT NULL,
  stichtag           TEXT NOT NULL,
  source_ref         TEXT,                             -- adapter-specific document ref; "#VJ" suffix = taken from the prior-year column of that document
  currency           TEXT DEFAULT 'EUR',
  umsatzerloese      REAL,
  bilanzsumme        REAL,
  eigenkapital       REAL,
  jahresergebnis     REAL,
  betriebsergebnis   REAL,
  arbeitnehmer       REAL,
  ek_quote           REAL,
  balance_json       TEXT,                              -- full Aktiva/Passiva breakdown (Austria v4 JAb)
  guv_json           TEXT,                              -- GuV line items incl. EBITDA (Austria JAb full form)
  health_score       REAL,
  health_grade       TEXT,
  computed_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (country, national_id_canon, stichtag),
  FOREIGN KEY (country, national_id_canon) REFERENCES companies(country, national_id_canon)
);
CREATE INDEX IF NOT EXISTS idx_fin_company  ON financials_yearly(country, national_id_canon);
CREATE INDEX IF NOT EXISTS idx_fin_stichtag ON financials_yearly(stichtag);

-- ─────────── OCR text cache ───────────
-- Scanned PDF JAbs get fed through tesseract; the extracted text is cached
-- here keyed by adapter-specific document ID so subsequent views don't
-- re-run the ~1-minute OCR pipeline.
CREATE TABLE IF NOT EXISTS ocr_text_cache (
  country      TEXT NOT NULL,
  document_key TEXT NOT NULL,
  ocr_text     TEXT NOT NULL,
  computed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (country, document_key)
);

-- ─────────── Users ───────────
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  api_key       TEXT UNIQUE NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────── Watchlist ───────────
CREATE TABLE IF NOT EXISTS watchlist_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key         TEXT NOT NULL,                    -- 'user:<id>' or 'anon:<cookie>'
  country           TEXT NOT NULL,
  national_id_canon TEXT NOT NULL,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_key, country, national_id_canon)
);
CREATE INDEX IF NOT EXISTS idx_watch_owner ON watchlist_entries(owner_key);
