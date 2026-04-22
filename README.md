# Kontur

*Europäische Firmendatenbank — ein Lookup für alle angebundenen nationalen Register.*

Kontur ruft on-demand die offenen Unternehmensregister der EU-Mitgliedstaaten
(plus EWR/UK) über einen einheitlichen Adapter-Layer auf. Jeder Treffer wird
in ein normalisiertes Company-DTO überführt und lokal gecacht.

## Status — Phase A (Gerüst)

| Bereich | Zustand |
| --- | --- |
| Adapter-Interface (`server/adapters/base.js`) | ✅ |
| Registry + Cross-Country-Search (`server/adapters/registry.js`) | ✅ |
| Stub-Adapter | AT, DE (Fixtures) |
| DB-Schema `(country, national_id)` | ✅ |
| Country-agnostic Health-Score + Peer-Grouping | behalten, noch nicht verdrahtet |
| Frontend | Minimaler Country-Dropdown + Such-View |

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

- **B** — Echte Adapter: AT (IWG SOAP), DE (Bundesanzeiger), FR (INPI), BE (KBO), NO (Brreg), DK (CVR)
- **C** — Tier-1-Komplettierung: FI, EE, LV, CZ, UK
- **D** — PL, SK, IE + GLEIF-Fallback für Rest-EU
- **E** — Health-Score/Peer-Benchmarks reaktivieren (wo Bilanzdaten da sind), Attribution-UI

## Lizenz

MIT.
