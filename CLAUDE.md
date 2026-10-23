# CLAUDE.md

Projekt-Leitfaden für Claude beim Arbeiten an **Kontur** (europäische Firmendatenbank).

## Was dieses Projekt ist

Kontur ruft on-demand die offenen Unternehmensregister der EU-Mitgliedstaaten
(+ EWR/UK) über einen einheitlichen Adapter-Layer ab. Jede Firma wird in ein
normalisiertes `Company`-DTO überführt und lokal in SQLite gecacht. Bilanzen
werden heuristisch aus PDFs extrahiert (layout-aware via pdf.js, OCR-Fallback
via Tesseract) und als Kennzahlen-Zeitreihe abgelegt.

## Architektur-Kurzfassung

```
server/
├── adapters/<cc>.js       Ein Adapter pro ISO-Land; Methoden:
│                          search, getCompany, getPeople, getFinancials
├── adapters/registry.js   Country-Code → Adapter-Map
├── adapters/base.js       Shared DTO-Helfer + AdapterError
├── fr-bilanz-parser.js    FR-spezifischer PDF-Bilanz-Parser (layout-aware + OCR)
├── pdf-bilanz-parser.js   AT/DE §224-UGB-Parser (Textlayer)
├── pdf-ocr.js             Tesseract-Pipeline (deu / fra), per-Seite-Tier-Batch
├── jab-parser.js          Österreichischer JAb-XML-Parser
├── normalize.js           Company-/Financials-/OCR-Cache in SQLite
├── cache.js               In-Memory LRU
├── analytics/             Health-Score + Kennzahl-Berechnung
│   └── models/            3-Statement-, LBO-, Merger-Modell (pure ESM, auch im Browser)
├── auth/                  Cookie-Session + scrypt
├── db/                    SQLite-Schema + Migrationen
└── index.js               Express-Routen
public/
├── index.html, app.js, app.css
└── design/                Design-Tokens (nur hier editieren, nie in app.css)
data/kontur.db             SQLite-Datenbank (gitignored)
.env                       Credentials — INPI_USERNAME/PASSWORD, FIRMENBUCH_TOKEN
```

## HTTP-API

```
GET /api/health                            Ping
GET /api/countries                         Liste der aktiven Adapter
GET /api/search?q=…&countries=FR,AT        Cross-Country-Suche
GET /api/company/:country/:id              Einzellookup (ISO-Land + national_id)
GET /api/company/:country/:id/document/:k  Dokument-Download-Proxy (AT IWG)
POST /api/models/three-statement           {country, id, assumptions?}
POST /api/models/lbo                       {country, id, assumptions?: {operating?, lbo?}}
POST /api/models/merger                    {acquirer, target, assumptions?: {acquirer?, target?, merger?}}
```

## Bewertungsmodelle

`server/analytics/models/` — drei Modelle, die aufeinander aufbauen:
`three-statement.js` (GuV, Bilanz, Kapitalflussrechnung verknüpft, Bilanzcheck
pro Jahr) ist die Basis; `lbo.js` (Sources & Uses, Tilgungsplan mit Cash Sweep
und PIK, IRR/MOIC) und `merger.js` (EPS Accretion/Dilution, PPA, Closing-Bilanz)
rufen `projectThreeStatement` auf. Die Module sind reine ES-Module ohne
Node-APIs: Express liefert sie unter `/lib/models/` aus, `public/models.js`
importiert dieselben Dateien und rechnet bei jeder Eingabe im Browser neu.
Die API-Routen lesen nur gecachte Financials (`readFinancials`), die Firma muss
also einmal über `/api/company` geladen worden sein. Nach Änderungen an den
Modellen: Bilanzcheck (`balanced`), Sources = Uses und die Wertbeitrags-Brücke
müssen exakt aufgehen.

## Quickstart

```bash
npm install
# .env anlegen — siehe .env.example
npm start          # Server auf http://localhost:3456
```

### Preview / Dev

Launch-Konfig in `.claude/launch.json` (`name: "kontur"`) — startet via
`mcp__Claude_Preview__preview_start`.

## Adapter hinzufügen

1. `server/adapters/<cc>.js` — implementiere `search`, `getCompany`, `getPeople`,
   optional `getFinancials`, `getDocuments`
2. In `registry.js` importieren und in das `ADAPTERS`-Array einhängen
3. UI-Metadaten (`label`, `license`, `sourceLabel`, `sourceUrl`, `attribution`,
   `hasFinancials`) pflegen — werden von `/api/countries` ausgeliefert
4. `configured` getter zurückgeben `true`, wenn der Adapter ohne weitere
   Konfiguration nutzbar ist (sonst mit API-Key/Login in `.env`)

## UK-Bulk-iXBRL-Ingest

**Die strukturierte Haupt-Quelle für UK-Finanzen** — nicht der heuristische
PDF-Parser. Companies House publiziert tägliche ZIPs mit allen elektronisch
eingereichten Accounts als iXBRL, frei und ohne Auth. Diese Route deckt
ca. 65 % aller UK-Filings ab (der Rest sind Paper-/Scan-Einreichungen, für
die der PDF-Parser bleibt).

- Quelle: `https://download.companieshouse.gov.uk/Accounts_Bulk_Data-YYYY-MM-DD.zip`
- Dateien: `Prod223_NNNN_CCCCCCCC_YYYYMMDD.html` (iXBRL) oder `.xml` (XBRL)
- Parser: [server/uk-ixbrl-parser.js](server/uk-ixbrl-parser.js) — extrahiert
  `<ix:nonFraction>` Tags und mappt FRC-core-Namen (Turnover, ProfitLoss,
  Equity, NetAssetsLiabilities, FixedAssets + CurrentAssets → Bilanzsumme)
- Ingest: `npm run ingest:uk-bulk` — downloadet, entpackt, parst parallel,
  upserted in `financials_yearly` via `upsertFinancials` direkt (kein HTTP
  hop, Server muss nicht laufen)
- Durchsatz: ~1 500 Filings/s, ein Tag in ~15 s
- Tag-Mapping liegt in `TAG_TO_KPI` im Parser; neue FRC-Taxonomie-
  Revisionen brauchen meist nur neue Einträge dort

## UK-Adapter-Spezifika (Companies House)

- Auth: HTTP Basic mit API-Key als Username, leeres Passwort. Key kommt
  aus `UK_CH_API_KEY` in `.env`. Anmelden unter
  https://developer.company-information.service.gov.uk/ → „Create an
  application" (Live) → „Create new key" (REST).
- Stammdaten: `/company/{number}` + `/company/{number}/officers`.
- Bilanzen: `/company/{number}/filing-history?category=accounts` listet
  accounts; jedes Filing hat `links.document_metadata` → Metadata-JSON am
  `document-api.company-information.service.gov.uk`. Content via
  `/document/{id}/content` (302-Redirect auf S3 — Authorization-Header
  darf NICHT weitergereicht werden, siehe `httpBinary` in uk.js).
- Parser ([uk-bilanz-parser.js](server/uk-bilanz-parser.js)): gleiche
  Architektur wie FR (Layout → Plain text → OCR `eng`), aber:
  - Zahlen: Komma als Tausender, Punkt als Dezimal (entgegensetzt zu FR)
  - Einheiten: `£m`, `£'000`, `£000`, „(in £ millions)" etc.
  - Labels zweistufig UK GAAP ↔ IFRS (Revenue/Turnover,
    Profit for the year / Net profit, Total equity / Net assets, …)
  - Banks: PBT statt Operating Profit (weil Banken kein Operating-Profit-
    Konzept haben)
- OCR-Pipeline liest bis Seite 140 (`ocrPdfUk`), mit
  `markerThreshold=3` — glossy Jahresberichte nennen „Balance Sheet" im
  Inhaltsverzeichnis vor den eigentlichen Tabellen.
- Reverse-Iteration beim Text-Parsing: Zeilen werden von unten nach oben
  gescannt, damit Tabellenzeilen Prosa-Erwähnungen („Revenue increased to
  £3,312 million") übertrumpfen.

## FR-Adapter-Spezifika (INPI RNE)

- Auth: `POST /api/sso/login` → JWT, ~1 h Gültigkeit, per 45-min TTL im Modul
- Firmen-Suche: `?companyName=…` (**NICHT** `?searchTerm=` — das wird von INPI
  still ignoriert und liefert eine zufällige Grundliste)
- Bilanzen: `/api/bilans?siren[]=<SIREN>` → PDF-Metadaten; Download via
  `/api/bilans/<id>/download`
- Parser wählt einen Bilanz-**Typ** pro Firma (S > K > C), um Format-Sprünge
  zwischen Jahren zu vermeiden
- Unit-Erkennung ist **per Seite** (Filings wie Michelin mischen CERFA-Euros
  mit `(en K€)` in späteren Notentabellen)
- OCR-Fallback greift, wenn Layout + Text beide leer/unzureichend; OCR-Text
  wird in SQLite (`ocr_text_cache`) gecacht — zweiter Aufruf ist instant

## Arbeitsregeln für Claude

- **Commits passieren automatisch** via Stop-Hook (siehe
  `.claude/settings.json` → `scripts/auto-commit.sh`). Du musst nicht manuell
  committen. Wenn ein Fix offensichtlich keinen Commit verdient (z. B. nur
  lokale Debug-Ausgabe), räume die Änderung auf, bevor die Antwort endet.
- **Niemals `.env` committen** — die `.gitignore` deckt das ab
- **Niemals die SQLite-DB committen** — gitignored, nur das Schema in
  `server/db/schema.sql` ist versioniert
- **Bilanz-Parser-Regel**: Wenn du Patterns änderst, immer mit
  `node -e` gegen eine bekannte PDF testen (siehe Danone / LVMH / Renault
  als kanonische Fälle) bevor ein Eval läuft
- **Eval-Harness**: `npm run eval:fr` (bzw. `scripts/fr-eval.mjs`) fährt
  10 SIRENs durch und berechnet Coverage + KPI-depth. Target: beide ≥ 90 %.
  Server muss vorher gestartet sein.

## Bekannte Limitationen

- BNP Paribas: Bank — regulatorische Bilanz fliesst nicht in INPI RNE
- Grosse Scan-PDFs (L'Oréal 394 S.): nur die ersten ~40 Seiten werden OCR'd,
  tiefe CERFA-Tabellen bleiben daher ausserhalb
- KPI-Spaltenzuordnung bei rein text-basierten/OCR-Zeilen ist heuristisch
  („current year = erste Zahl nach Label"); bei Layout-PDFs wird der
  Jahresheader x-basiert aufgelöst (zuverlässig)

## Schnellcheck nach Code-Änderungen

```bash
# einzelnen Adapter testen
node -e "import('./server/adapters/fr.js').then(async m => {
  const a = m.default;
  console.log(await a.getCompany('552032534'));
});"

# komplettes Eval (dauert mit OCR-Cache ~2-4 min, ohne 15+ min)
npm run eval:fr
```
