# Kontur

*Europäische Firmendatenbank — ein Lookup für alle angebundenen nationalen Register.*

Kontur ruft on-demand die offenen Unternehmensregister der EU-Mitgliedstaaten
(plus EWR/UK) über einen einheitlichen Adapter-Layer auf. Jeder Treffer wird
in ein normalisiertes Company-DTO überführt und lokal gecacht.

## Status — Phase B (Live-Adapter)

| Bereich | Zustand |
| --- | --- |
| Adapter-Interface (`server/adapters/base.js`) | ✅ |
| Registry + Cross-Country-Search (`server/adapters/registry.js`) | ✅ |
| **AT** — JustizOnline IWG | ✅ Live, inkl. XML/PDF-Bilanzen |
| **NO** — Brønnøysund Enhetsregisteret | ✅ Live |
| **FR** — INPI RNE | ✅ Live — Firmen + Organe + Bilanz-KPIs (heuristisch aus PDF/OCR) |
| **CZ, FI** — ARES / PRH | ✅ Live (ohne Finanzen) |
| **DE, SE, PL, IT, ES, NL, BE, IE** | GLEIF-basierter Übergang (nur LEI-Firmen) |
| **UK** — Companies House | ✅ Live — Firmen + Officers + **strukturierte iXBRL-Bilanzen** (Bulk-Ingest) + PDF-Parser-Fallback |
| DB-Schema `(country, national_id)` + financials_yearly | ✅ |
| Health-Score + Kennzahlen | ✅ verdrahtet, sichtbar im Detail-View |
| Frontend | Country-Dropdown, Such-View, Detail mit Organe/Kennzahlen/Score |

### FR-KPI-Extraktion (Stand: Round 16)

| Metrik | Ergebnis | Ziel |
| --- | --- | --- |
| Coverage (SIRENs mit ≥1 Bilanz) | **90 %** (9/10) | ≥ 90 % |
| KPI-Tiefe (⌀ gefüllte KPIs pro Firma) | **91 %** (4.56/5) | ≥ 90 % |

Testsample: LVMH, L'Oréal, Danone, TotalEnergies, Renault, Carrefour, Sanofi,
Michelin, Orange, BNP Paribas. Ausführung: `npm run eval:fr` (Server muss
laufen).

### UK-Bulk-Ingest (iXBRL)

Companies House publiziert einen freien täglichen ZIP mit allen
elektronisch eingereichten Accounts als iXBRL — strukturiert, keine
OCR-Heuristik. Ein Ingest-Lauf über einen Tag:

```bash
npm run ingest:uk-bulk                  # gestrigen Tag holen
npm run ingest:uk-bulk -- --date=2026-04-22
```

Typische Werte: ~10 000 iXBRL-Dateien/Tag, ~1 500 Filings/s Parsing,
ingest eines kompletten Tages in ~15 Sekunden. Cronbar; Checkpoint in
`logs/ingest-uk-bulk.checkpoint.json` verhindert Doppelungen.

## Architektur

```
server/
├── adapters/
│   ├── base.js          Adapter-Interface + DTO-Helper
│   ├── registry.js      Country → Adapter Map
│   ├── at-stub.js       AT-Stub (Fixtures)
│   └── de-stub.js       DE-Stub (Fixtures)
├── analytics/           Health-Score + Peer-Grouping (country-agnostic)
├── auth/                Cookie-Session + scrypt
├── cache.js             In-Memory LRU
├── db/                  SQLite Schema + Connection
├── normalize.js         Persist/read Company-DTOs
└── index.js             Express-Routen
public/
├── index.html           Shell
├── app.js               Search & Detail
├── app.css              Layout
└── design/              Tokens + Reset + Components
```

## Quickstart

```bash
npm install
npm start
# → http://localhost:3456
```

## HTTP-API

```
GET  /api/health                           Ping
GET  /api/countries                        Liste der aktiven Adapter
GET  /api/search?q=…&country=AT,DE         Cross-Country-Suche
GET  /api/company/:country/:id             Einzellookup (ISO-Land + national_id)
```

## Nächste Phasen

- **C** — UK Companies House (bester freier API mit strukturierten Finanzen),
  DE Bundesanzeiger-Scraper, BE KBO, DK CVR
- **D** — Skandinavien vollständig (SE Bolagsverket, FI PRH erweitert, IS
  Fyrirtækjaskrá), Osteuropa (PL, SK, HU)
- **E** — Health-Score-Peer-Benchmarks über Länder hinweg (derzeit nur AT/FR/NO
  Bilanzen), Attribution-UI

## Lizenz

MIT.
