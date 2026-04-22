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
```

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
