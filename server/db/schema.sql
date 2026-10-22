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

-- ─────────── AT Urkunden-Feed (screening universe) ───────────
-- One row per document JustizOnline announces via VERAENDERUNGENURKUNDE.
-- Metadata only; filled by scripts/at-universe.mjs. Rows are not tied to
-- `companies` (most firms are never looked up individually).
CREATE TABLE IF NOT EXISTS at_register_documents (
  doc_key            TEXT PRIMARY KEY,                 -- URKUNDE key, e.g. 006933_0070732451287_000___000_30_34091871_XML
  national_id_canon  TEXT NOT NULL,                    -- FN incl. check letter, derived from the key
  doc_code           TEXT,                             -- DOKUMENTART: 48 JAb, 137 berichtigt, 164 vorläufig, 51 Lagebericht, 27 Bestätigungsvermerk, 49 Konzernabschluss, 136 Liquidationsschlussbilanz
  doc_text           TEXT,
  vollzugsdatum      TEXT NOT NULL,
  content_type       TEXT,
  first_seen_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_atdoc_company ON at_register_documents(national_id_canon, doc_code, vollzugsdatum);
CREATE INDEX IF NOT EXISTS idx_atdoc_date    ON at_register_documents(vollzugsdatum);

-- Feed windows already fetched — the backfill checkpoint.
CREATE TABLE IF NOT EXISTS at_feed_windows (
  feed        TEXT NOT NULL,                           -- 'urkunde'
  von         TEXT NOT NULL,
  bis         TEXT NOT NULL,
  entries     INTEGER NOT NULL,
  complete    INTEGER NOT NULL,                        -- 1 = window lies fully in the past, never refetched
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (feed, von, bis)
);

-- Screening universe: one row per firm that filed a Jahresabschluss in the
-- fetched period. A Lagebericht or Bestätigungsvermerk marks mittelgroß/groß
-- (full form with GuV — 20/20 in the phase-0 check). Recreated on every
-- migrate so definition changes apply.
DROP VIEW IF EXISTS at_universe;
CREATE VIEW at_universe AS
SELECT
  d.national_id_canon,
  MAX(CASE WHEN d.doc_code IN ('48', '137') THEN d.vollzugsdatum END) AS last_jab_at,
  COUNT(DISTINCT CASE WHEN d.doc_code IN ('48', '137') THEN d.vollzugsdatum END) AS jab_filing_days,
  (SELECT x.doc_key FROM at_register_documents x
    WHERE x.national_id_canon = d.national_id_canon AND x.doc_code IN ('48', '137')
      AND x.content_type LIKE '%xml%'
    ORDER BY x.vollzugsdatum DESC, x.doc_key DESC LIMIT 1)            AS latest_jab_xml_key,
  MAX(d.doc_code IN ('51', '27'))                                     AS prefilter_mittel_gross,
  MAX(d.doc_code = '51')                                              AS has_lagebericht,
  MAX(d.doc_code = '27')                                              AS has_bestaetigungsvermerk,
  MAX(d.doc_code = '49')                                              AS has_konzernabschluss,
  MAX(d.doc_code = '137')                                             AS has_berichtigt,
  MAX(d.doc_code = '164')                                             AS has_vorlaeufig,
  MAX(d.doc_code = '136')                                             AS has_liquidationsschlussbilanz
FROM at_register_documents d
GROUP BY d.national_id_canon
HAVING SUM(d.doc_code IN ('48', '137', '164')) > 0;

-- Screening profile from the AUSZUG Kurzinformation (one row per firm).
-- Filled by scripts/at-jab-ingest.mjs; the street address itself lives in
-- companies.address.
CREATE TABLE IF NOT EXISTS at_company_profile (
  national_id_canon  TEXT PRIMARY KEY,
  plz                TEXT,
  ort                TEXT,
  bundesland         TEXT,                             -- from the Gemeindekennziffer of the Sitz
  gemeindekennziffer TEXT,
  geschaeftszweig    TEXT,
  homepage           TEXT,
  rechtsform         TEXT,
  ersterfassung      TEXT,
  organe_json        TEXT,                             -- [{roleCode, role, name, geburtsjahr, seit, vertretung}]
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_atprofile_bundesland ON at_company_profile(bundesland);

-- One row per Jahresabschluss document the ingest has processed.
CREATE TABLE IF NOT EXISTS at_jab_ingest (
  doc_key            TEXT PRIMARY KEY,
  national_id_canon  TEXT NOT NULL,
  status             TEXT NOT NULL,                    -- ok | no-data | error
  error              TEXT,
  ingested_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
