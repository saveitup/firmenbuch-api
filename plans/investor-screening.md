# Plan: Target-Screening für das MBI-Suchmandat (AT zuerst)

**Ziel.** Kontur wird zum Recherche-Kanal (2) des *MBI Acquisition Search
Mandate V1.0* (Okt 2026): „KI-gestützte Unternehmensrecherche,
Register-/Abschlussdaten, strukturierte Anreicherung, Scoring und
Monitoring“. Dazu kommt die **gemeinsame Target-Datenbank und Deal-Pipeline**,
in die auch Kanal (1) — vertrauliche Netzwerkarbeit — einfließt.

Gesucht werden etablierte, profitable Mittelständler mit hoher
Cashflow-Qualität, belastbarer zweiter Führungsebene und Nachfolgesituation.
Maßstab ist **Datenqualität und tatsächlicher Fit, nicht die Anzahl erfasster
Firmen** (Mandat § 12).

**Abgrenzung zur bisherigen Architektur.** Kontur ist bisher on-demand. Dieses
Modul braucht für AT einen **Bulk-Bestand** (analog UK-iXBRL-Ingest) und
zusätzlich mandatsspezifische Daten (Pipeline, Notizen, manuelle Scores), die
getrennt von den Registerdaten liegen (Mandat § 11).

### Änderungsprotokoll

**v2 (Mandat V1.0 eingearbeitet):**

- Statt „möglichst viele Firmen analysieren“ ein **Trichter** Universe →
  Qualified → Priority → Active Opportunity. KI-Analyse nur ab „Qualified“.
- Statt eines generischen Cash-Scores das **Target Fit Scoring (20 Punkte)**
  des Mandats, plus Data Confidence, Deal Readiness und Research Status.
- Statt einer eigenen Branchen-Taxonomie die **Mandats-Cluster A1–B3**;
  ÖNACE dient nur noch als Vorfilter.
- Neu: Schätzer für Umsatz und EBITDA mit Spannen, Nachfolge-Signale aus dem
  Firmenbuch, Hard-Exclusion-Regeln mit UNKNOWN-Logik, Kalibrierung an
  100–200 Firmen, Deep Profiles, Netzwerk-Kanal in der Pipeline.
- DE/CH als spätere Erweiterung mit eigenem Spike.

**v3 (Anpassungen des Searchers):**

- Kern-EBITDA bis **5 Mio. €** (statt 3,5 Mio. €). Die Mitarbeiterzahl ist kein
  Kriterium mehr, nur noch Information.
- **Token-Verbrauch richtet sich nach dem Cluster:** Tiefenstufen 0–4 mit
  Budget pro Stufe (Phase 6).
- Das **Altersband** ist nie ausschlussrelevant und kein Filter, wird aber als
  Kontext zur Nachfolgesituation angezeigt.
- **Lizenz- und Datenschutzprüfungen entfallen**, für Datenquellen wie für die
  Target-Analyse. Das spart Tokens und Aufwand; betroffene Mandatskriterien
  bleiben bis zur DD UNKNOWN.

---

## 1. Mandat → Systemanforderungen

| Mandat | Anforderung an Kontur |
| --- | --- |
| § 1 Kernprofil (Umsatz 10–35 Mio., EBITDA 1,5–**5** Mio., Marge ≥ 15 %, Wachstum 2–7 %, 4–7x; Mitarbeiterzahl kein Kriterium) | Filter und Score-Inputs; da Umsatz/EBITDA oft nicht offengelegt sind → **Spannen-Schätzer** (§ 4) |
| § 2 Erweiterter Bereich (5–50 Mio., EBITDA 1–5 Mio.) | Zweites Größenband „erweitert“; nichts wird außerhalb automatisch verworfen |
| § 3 Finanzielle Mindestqualität + KPI-Liste | Cashflow-Engine (Phase 3) und KPI-Verfügbarkeitsmatrix (§ 3 unten) |
| § 4 Cluster A1–B3 | Cluster-Zuordnung (Phase 4), clusterspezifische Prüfpunkte |
| § 5 Qualitative Anforderungen | KI-Profil (Phase 6) mit Belegen, Tiefe je Cluster; Lizenzen werden nicht geprüft; vieles bleibt bis zur DD UNKNOWN |
| § 6 Verkäuferprofil (inhaber-/familiengeführt, altersbedingte Nachfolge) | **Deal-Readiness-Kontext** aus dem Firmenbuch (Phase 1/7); Altersband nie ausschlussrelevant |
| § 7 Harte Ausschlüsse + Datenregel | Regelwerk PASS / FLAG / FAIL / UNKNOWN; FAIL nur mit Evidenz (Phase 3) |
| § 8 Ausdrücklich zulässig | Keine automatischen Ausschlüsse für diese Fälle (z. B. niedrige Marge bei hoher Cash Conversion) |
| § 9 Target Fit Scoring | Score-Engine nach Mandatsformel, Schwellen konfigurierbar (Phase 7) |
| § 10 Prozess, zwei Kanäle | Pipeline-Stufen + manueller Eintrag von Netzwerk-Targets (Phase 7) |
| § 11 Daten strikt trennen | Getrennte Mandats-DB; Lizenz-/Datenschutzprüfung bewusst nicht Teil des Plans (§ 8) |
| § 12 90-Tage-Ziele | Meilensteine (§ 9 unten) |

**Mandat als Konfiguration, nicht als Code:** `config/mandate.example.json`
(versioniert) und `config/mandate.local.json` (gitignored). Sie enthalten
Korridore, Gewichte, Prioritätsschwellen, Cluster-Prioritäten, Token-Budgets
je Tiefenstufe und Persönliches (z. B. CEO-Fit-Präferenzen). Eine Mandatsversion 1.1 nach der Kalibrierung ist
dann eine Config-Änderung, kein Code-Release.

---

## 2. Ausgangslage im Code

| Baustein | Zustand | Lücke |
| --- | --- | --- |
| `server/adapters/at.js` | SUCHEFIRMA, SUCHEURKUNDE, URKUNDE | Kein AUSZUG (→ kein Geschäftszweig, keine Gesellschafter/Organe), kein Veränderungen-Feed |
| `server/jab-parser.js` | v4 + BMF-Legacy, nur Summenzeilen | Keine GuV-Details, kein Vorjahr (`BETRAG_VJ`), Verbindlichkeiten nicht aufgeschlüsselt |
| `server/analytics/` | Bestandskennzahlen, Health-Score, Peers über Rechtsform + Größe | Kein Cashflow, keine Schätzer, keine Branche |
| `watchlist_entries` | Merkliste | Keine Pipeline-Stufen, Notizen, Scores |
| DE-Adapter | GLEIF-Übergang (nur LEI-Firmen) | Für DE-Mittelstand unbrauchbar |

**Befund aus der lokalen DB:** 571 AT-Bilanzjahre, davon nur 6 mit Umsatz
und 8 mit Betriebsergebnis; Restlaufzeit-Split der Verbindlichkeiten wird nie
erkannt. Kleine GmbHs (§ 278 UGB) reichen nur Bilanz + Anhang ein. Spike 0.2
hat gezeigt, dass der größere Teil der Lücke am Parser liegt: Die
BMF-Vollform enthält eine komplette GuV, die bisher nicht gelesen wird.

---

## 3. Was öffentliche Daten zu den Mandats-KPIs hergeben

| KPI (Mandat § 3) | AT mittelgroß/groß (mit GuV) | AT klein (nur Bilanz) | Website / KI | Erst in der DD |
| --- | --- | --- | --- | --- |
| Umsatz, CAGR | ✔ (ggf. nur Rohergebnis, Spike 0.2) | Spanne (§ 4) | Claims („20 Mio. Umsatz“) | ✔ |
| EBITDA, Marge | ✔ JÜ + Steuern + Zinsen + AfA | Spanne (§ 4) | – | **normalisiert** nur hier |
| EBIT | ✔ Betriebserfolg | Schätzung | – | ✔ |
| Operativer Cashflow | ✔ indirekt | FCF-Proxy (Phase 3) | – | ✔ |
| Maintenance / Growth CapEx | AfA als Maintenance-Proxy, Rest Growth | nur Netto-Δ Anlagevermögen | – | ✔ |
| Working Capital | ✔ | ✔ | – | ✔ |
| Net Debt | ✔ wenn Bankverbindlichkeiten ausgewiesen | Näherung | – | ✔ |
| Cash Conversion | ✔ | ✖ (nur Proxy ohne EBITDA) | – | ✔ |
| Kundenkonzentration (< 20 %) | ✖ | ✖ | Hinweise (Referenzliste, „Hauptkunde“) | ✔ |
| Wiederkehrender Umsatz | ✖ | ✖ | Signale (Wartungsverträge, SaaS, Service-Abos) | ✔ |
| DSCR | Schätzung | grobe Schätzung | – | ✔ |
| Mitarbeiter (nur Info, kein Kriterium) | in BMF-Dateien nicht enthalten | nur v4-Kurzform-Anhang; Größenklasse ⇒ ≤ 50 | Karriereseite, Claims | ✔ |
| Organe / Nachfolge-Kontext | Kurzinformation: GF/Vorstand/Prokura mit Geburtsjahr und Beginn | dito | Team-Seite | ✔ |
| Gesellschafter / Anteile | ✖ nicht über HVD; voller Auszug kostenpflichtig | dito | – | ✔ |

**Konsequenz:** Ein *normalisiertes* EBITDA gibt es aus öffentlichen Daten nie.
Kontur arbeitet mit **berichteten Werten (Tier A)**, **Spannen-Schätzungen
(Tier B)** und **UNKNOWN**. Jede Zahl trägt Quelle und Konfidenz. Punktwerte
ohne Beleg erscheinen nicht in der UI.

---

## 4. Größenlogik für den Kernkorridor (AT)

Der Kernkorridor (10–35 Mio. € Umsatz, EBITDA 1,5–5 Mio. €) liegt **genau auf der Grenze
klein/mittelgroß** nach § 221 UGB (klein: ≤ 6,25 Mio. € Bilanzsumme,
≤ 12,5 Mio. € Umsatz, ≤ 50 AN; zwei von drei Merkmalen). Ein Teil der Targets
hat also eine GuV (Tier A), ein Teil nicht (Tier B).

**Größenklassen-Inferenz.** Die Art des Abschlusses verrät etwas über die
nicht offengelegten Werte:

- Kein GuV-Teil und Bilanzsumme > 6,25 Mio. € ⇒ Umsatz ≤ 12,5 Mio. € **und**
  ≤ 50 AN (sonst wäre die Firma nicht „klein“) ⇒ höchstens unteres Ende des
  Kernkorridors.
- GuV vorhanden ⇒ mittelgroß/groß ⇒ mindestens zwei Schwellen überschritten.
- Vorbehalt: Freiwillig umfangreichere Offenlegung kommt vor, deshalb ist das
  nur ein Signal und keine harte Regel.

**Umsatz-Schätzer (Tier B)** kombiniert unabhängige Schätzungen zu einer
Spanne:

1. Grenzen aus der Größenklassen-Inferenz
2. Forderungen L+L × 365 / Branchen-DSO (Cluster-Default, kalibrierbar)
3. Mitarbeiter × Umsatz je Beschäftigtem der Branche (Statistik Austria,
   Leistungs- und Strukturerhebung)
4. Umsatz-Claims von der Website (Phase 6), mit Datum

**Auch Tier A braucht den Umsatz-Schätzer oft:** 13 von 14 mittelgroßen
Vollform-Abschlüssen der Vorfilter-Stichprobe nennen nur das
**Rohergebnis**, keinen Umsatz. Das EBITDA ist trotzdem exakt. Für die
EBITDA-Marge ist der stärkste Input:

5. Umsatz ≈ Rohergebnis / Rohertragsquote, Spanne je Cluster (z. B.
   Großhandel A1 niedrig, technische Dienstleistung A2 hoch); kalibriert an
   den großen Firmen, die beides ausweisen

**EBITDA-Schätzer (Tier B):**

```
EBITDA ≈ JÜ / (1 − 23 % KöSt) + Zinsaufwand + AfA
  Zinsaufwand ≈ verzinsliche Verbindlichkeiten × Zinsannahme (Spanne)
  AfA         ≈ Sachanlagen + immat. VG × Cluster-AfA-Quote (Spanne)
→ Ausgabe: low / mid / high + Konfidenz
```

Kalibriert wird beides an den Tier-A-Firmen: Dort lassen sich die Schätzer
blind auf die Bilanz anwenden und gegen die echte GuV prüfen. Das ergibt ein
gemessenes Fehlerband statt eines Bauchgefühls.

**Startwerte für das AT-Universe-Größenband** (in `mandate.*.json`, nach den
ersten 100–200 Bewertungen nachzukalibrieren):

- Kern (EBITDA 1,5–5 Mio. €): JÜ-Median (3 J.) ≈ 0,6–3,5 Mio. €, *oder*
  geschätztes EBITDA-mid im Kernband, Bilanzsumme ≈ 3–40 Mio. €
- Erweitert (Umsatz 5–50 Mio. €, EBITDA 1–5 Mio. €): JÜ ≈ 0,4–3,5 Mio. €,
  Bilanzsumme ≈ 2–50 Mio. €
- Die Mitarbeiterzahl filtert nicht. Sie dient nur als Schätz-Input
  (Umsatz je Beschäftigtem) und als Information.
- Firmen ohne Abschluss oder nur mit Tier C bleiben im Universe (UNKNOWN),
  werden aber nicht automatisch „Qualified“.

---

## 5. Zielarchitektur

```
 JustizOnline HVD (SOAP): VERÄNDERUNGEN · AUSZUG · SUCHEURKUNDE · URKUNDE
        │                      │                 │
        ▼                      ▼                 ▼
 at-universe.mjs ──► companies + at_company_profile (Geschäftszweig, Organe,
                     Gesellschafter, Altersband, Prokura)
                               │
 at-jab-ingest.mjs ──► financials_yearly (+ guv_json, Vorjahr)
                               ▼
 analytics/cashflow.js · estimators.js ──► cashflow_yearly, estimates
 analytics/exclusions.js ──► criteria_status (PASS/FLAG/FAIL/UNKNOWN + Evidenz)
                               ▼
          ── Universe-Größenband + Cluster-Vorfilter ⇒ „Qualified“-Kandidaten ──
                               ▼
 web-discover.mjs · web-crawl.mjs ──► web_domains, web_pages      (nur Qualified)
 ai-profile.mjs (Claude Batch, Tiefe je Cluster) ──► ai_profiles (§5-Kriterien, Belege)
                               ▼
 analytics/target-fit.js ──► target_scores (20-Punkte-Spanne, Confidence, Readiness)
                               ▼
 data/mandate.db: pipeline, notes, manual_scores, calibration  ◄── Netzwerk-Kanal (manuell)
                               ▼
 GET /api/mandate/…  → Screener · Pipeline · Kalibrierung · Deep Profile (UI)
```

Stack bleibt Node/ESM + better-sqlite3 + Express + Vanilla-SPA. Jobs laufen
als `npm run …`-Skripte mit Checkpoints bzw. einer SQLite-Job-Tabelle.

---

## 6. Phasen

### Phase 0 — Spikes & Klärungen

| # | Frage | Entscheidet |
| --- | --- | --- |
| 0.1 | **Kosten & Limits** der HVD/IWG-Calls (`server/index.js` notiert eine Gebühr pro URKUNDE). Self-funded Search ⇒ Kosten zählen. | Bulk ja/nein; Strategie „jeden 2. Abschluss laden, Vorjahr aus `BETRAG_VJ`“ |
| 0.2 | ✅ **GuV-, Vorjahres- und Mitarbeiter-Abdeckung** — erledigt, siehe [phase0](investor-screening.phase0.md#02--was-die-jab-xmls-enthalten): Vollform-Abschlüsse haben eine komplette GuV (BMF-Parser ignoriert sie bisher), Vorjahr immer befüllt | Parser-Mapping; Anteil Tier A |
| 0.3 | ✅ **Veränderungen-Feed** — erledigt, siehe [phase0](investor-screening.phase0.md#03--veränderungen-feeds): beide Feeds laufen, Wochenfenster gehen, Historie ≥ 2 Jahre; ~150–200 Tsd. Abschlüsse/Jahr, fast alle als XML | Universe-Aufbau |
| 0.4 | ✅ **AUSZUG-Inhalt** — erledigt, siehe [phase0](investor-screening.phase0.md#04--was-der-auszug-liefert): nur „Kurzinformation“ verfügbar, also GF/Vorstand/Prokura mit Geburtsjahr und Beginn, aber **keine Gesellschafter**; Geschäftszweig und Homepage nur selten eingetragen | Deal-Readiness-Signale |
| 0.5 | **Website-Trefferquote** über Impressum-FN (§ 5 ECG) an 100 Firmen | Discovery-Strategie |
| 0.6 | **LLM-Qualität & Kosten je Tiefenstufe** an 30 Firmen (Opus 5.5 / Sonnet 5.5 / Haiku 5.5) gegen manuell erstellte Soll-Profile | Modell + Token-Budget je Stufe |
| 0.7 | **Kalibrierungsset** festlegen: 100–200 AT-Firmen über alle Cluster (bekannte Targets, Grenzfälle, bewusste Nicht-Fits) | Ground Truth für Schätzer und Score |

**Exit:** `plans/investor-screening.phase0.md` mit Messwerten und
Entscheidungen.

### Phase 1 — Universe & Stammdaten (AT)

1. ✅ `at.js`: **AUSZUG_V2 mit `UMFANG = "Kurzinformation"`** implementieren
   (`getCompany`, neu `getPeople`, `getKurzinformation`; Bundesland aus der
   Gemeindekennziffer)
   (`getCompany` liefert echte Stammdaten). Strukturiert gespeichert werden
   Sitz (PLZ → Bundesland), Geschäftszweig und Homepage (falls eingetragen),
   Ersterfassung, Rechtsform, Organe (GF/Vorstand/Prokura mit Beginn) und
   Rechtstatsachen. Gesellschafter liefert die HVD-Schnittstelle nicht
   (Spike 0.4).
2. **Deal-Readiness-Kontext** aus den Organen: Altersband der GF (z. B.
   „60–64“; reiner Kontext, nie Ausschluss- oder Filterkriterium),
   Amtsdauer, Anzahl GF, Prokura vorhanden (Signal für eine zweite
   Führungsebene), Namensgleichheit GF/Prokura (Familie, möglicher interner
   Nachfolger). **Eigentümerstruktur** (Gesellschafter-GF, Anteile,
   Holding-Kette) nur für Priority-Kandidaten über einen kostenpflichtigen
   vollen Auszug, sonst UNKNOWN.
3. ✅ `scripts/at-universe.mjs` (`npm run ingest:at-universe`), Tabellen
   `at_register_documents` / `at_feed_windows`, View `at_universe`.
   Die FN-Prüfbuchstaben werden aus dem `KEY` berechnet (gewichtete
   Ziffernsumme mod 17, Gewichte 6·4·14·15·10·1, Buchstaben
   `abdfghikmpstvwxyz`; stimmt bei allen 3 156 FN der DB). Damit lassen sich
   Feed-Einträge ohne Einzelabfrage mit `companies`/`financials_yearly`
   verknüpfen. Ursprüngliche Spezifikation: `VERAENDERUNGENURKUNDE` rückwärts über
   ≈ 24 Monate in **Wochenfenstern** (~104 Calls, ~45 min). Ergebnis: alle
   Firmen mit eingereichtem Jahresabschluss samt direkt ladbarem
   Dokument-`KEY` (kein SUCHEFIRMA/SUCHEURKUNDE nötig). Zusätzlich je Firma
   festhalten, ob Lagebericht (51), Bestätigungsvermerk (27) oder
   Konzernabschluss (49) eingereicht wurden: das ist der **Vorfilter für
   mittelgroß/groß** (bestätigt mit 20 von 20 Vollform-Abschlüssen, siehe
   phase0 § 0.3). Neueintragungen und
   Löschungen kommen aus `VERAENDERUNGENFIRMA`. Idempotent, mit Checkpoint.
4. Konzern-/Holding-Erkennung über die Bilanzstruktur (Finanzanlagen
   dominieren, kaum Personalaufwand, Kurzform trotz hoher Bilanzsumme):
   Holdings markieren, damit der Screener keine leeren Holdings rankt. Die
   Verknüpfung mit der operativen Tochter braucht Gesellschafterdaten und
   gibt es daher erst für Priority-Kandidaten.

**Exit:** ≥ 95 % des Kalibrierungssets im Universe; Stammdaten ≥ 90 % befüllt.

**Stand 22.10.2026 (Phase 1 + Vorfilter-Ingest):**
- **Universe:** Feed Okt. 2024 – Okt. 2026, 902 250 Dokumente,
  **217 749 Firmen** mit Jahresabschluss (98,6 % davon mit XML)
- Vorfilter mittelgroß/groß: 8 389; Konzernabschluss: 1 071;
  Liquidationsschlussbilanz: 466
- **Geladen:** 8 181 Vorfilter-Firmen mit Kurzinformation und neuestem
  Abschluss; 2 Verbindungsabbrüche, im zweiten Lauf nachgeholt
- **Screener:**
  - 2 101 Firmen im Kernband (EBITDA 1,5–5 Mio.), 2 768 im erweiterten Band
  - nur 748 der 2 101 weisen einen Umsatz aus, 1 353 nur das Rohergebnis
  - von den 748 mit Umsatz haben 106 eine EBITDA-Marge ≥ 15 %
- **Nebenbefund:** BMF-Abschlüsse betten Anhang und **Lagebericht als PDF**
  ein. Sie werden im gespeicherten XML entfernt (80 MB statt 784 MB), sind
  für Phase 6 aber eine direkte Quelle, bei Bedarf neu laden.

### Phase 2 — Finanzdaten in die Tiefe

1. `jab-parser.js` **erweitern, nicht umbauen** (Mapping in
   [phase0 § 0.2](investor-screening.phase0.md#02--was-die-jab-xmls-enthalten)):
   - ✅ **BMF-GuV** (`HGB_231_2_*`) lesen — größter Einzelhebel, macht alle
     Vollform-Firmen zu Tier A. Umgesetzt: Feld `guv` inkl. EBITDA, für v4
     gleich mit
   - ✅ Vorjahresspalte (Einheit aus `VOR_GJ/WERT_TSD` bzw.
     `DARSTELLUNG_VORHERGEHEND`). Umgesetzt: Feld `priorYear`
   - ✅ Speicherung: GuV in `financials_yearly.guv_json`; Vorjahre nur
     eingefügt, wenn das Jahr fehlt (`source_ref` mit Suffix `#VJ`). Der
     spätere Originalabschluss ersetzt sie, Originalzeilen werden nie
     überschrieben
   - Prüfung ohne IWG-Calls: `npm run check:jab` (Parser-Regression gegen
     git HEAD, GuV-Summenregeln, Vorjahr vs. DB, Speicherlogik auf einer
     Wegwerf-DB)
   - Bilanz-Detail: Forderungen/Verbindlichkeiten L+L, Bankverbindlichkeiten,
     verbundene Unternehmen, Rückstellungsarten, Restlaufzeiten
   - v4-GuV → `guv_json`; Größenklasse (v4 `GROESSENKLASSE`, BMF `HGBFORM`);
     AN-Zahl, wo vorhanden
   - **Roh-XML speichern**, damit Parser-Verbesserungen keine neuen Calls
     kosten
   - BMF-Legacy bleibt für historische Jahre nötig (seit 1.3.2025 ist
     JAb 4.0 Pflicht)
2. ✅ `scripts/at-jab-ingest.mjs` (`npm run ingest:at-jab`): je Firma
   Kurzinformation + neuester XML-Abschluss → `companies`,
   `at_company_profile`, `financials_yearly`; Status in `at_jab_ingest`.
   Roh-XML ohne eingebettete Anhänge gzip-komprimiert unter
   `data/at-jab-xml/` (~5–8 KB je Firma). Ursprüngliche Spezifikation:
   XML-`KEY`s aus dem Universe laden, direkt
   `upsertFinancials`. Reihenfolge nach Vorfilter: zuerst Firmen mit
   Lagebericht/Bestätigungsvermerk, dann der Rest, sofern 0.1 das erlaubt.
   PDF/OCR nur für Qualified-Kandidaten. Danach inkrementell: 1 Feed-Call
   pro Tag. Dokumentarten:
   - Jahresabschluss (48)
   - „berichtigt“ (137) ersetzt denselben Stichtag
   - „vorläufig“ (164) wird später ersetzt
   - Konzernabschluss (49) separat führen
3. `npm run eval:at`: 20 Firmen, Soll-Werte von Hand aus den PDFs.

**Exit:** Im Größenband haben ≥ 85 % der Firmen ≥ 2 Bilanzjahre;
Summenzeilen ≥ 95 % korrekt, GuV-Positionen ≥ 90 % korrekt.

### Phase 3 — Cashflow, Schätzer, Ausschluss-Regeln

**Cashflow** (`analytics/cashflow.js`), jede Zeile mit `tier` und Warnungen:

- **Tier A** (GuV + 2 Bilanzen, indirekte Methode angelehnt an AFRAC 36):
  CFO = JÜ + AfA ± Δ Rückstellungen − Δ NWC; Investitionen ≈ Δ AV + AfA;
  FCF; dazu EBITDA, EBIT, Marge, Cash Conversion, Maintenance-CapEx ≈ AfA,
  Growth-CapEx = Investitionen − AfA, Net Debt / EBITDA, DSCR-Schätzung.
- **Tier B** (nur Bilanzen + JÜ): Die AfA kürzt sich heraus:
  `FCF ≈ JÜ − Δ AV − Δ NWC (ohne Kasse) + Δ Rückstellungen`. Gegenprobe über
  Δ Netto-Finanzposition + implizite Ausschüttung (EK(t−1) + JÜ − EK(t)).
  Weichen beide Wege stark ab → Warnung, keine automatische Wertung.
- **Tier C** (eine Bilanz): nur Bestandsgrößen, Finanzkategorie im Score
  bleibt UNKNOWN.

**Schätzer** (`analytics/estimators.js`): Umsatz- und EBITDA-Spannen nach
§ 4, kalibriert an Tier-A-Firmen (Blindtest Bilanz → GuV), Fehlerband
dokumentiert. Bewertungs- und Finanzierungsrahmen: EV-Spanne = 4–7x
EBITDA-Spanne, Akquisitionsschulden 2–3x (max. 4x), resultierende
Eigenkapitallücke.

**Ausschluss-Regeln** (`analytics/exclusions.js`), Mandat § 7. Jede Regel
liefert `PASS | FLAG | FAIL | UNKNOWN` mit Evidenz-Verweis:

| Mandat § 7 | Automatische Evidenz | Status maximal automatisch |
| --- | --- | --- |
| Strukturell negativer normalisierter FCF | FCF ≤ 0 in ≥ 3 von 4 Jahren, Gegenprobe ohne Warnung | FLAG |
| Untragbarer Schuldendienst / Verschuldung | negatives EK + hohe Verbindlichkeiten; Net Debt / EBITDA-high > 5x | FLAG |
| Abhängigkeit von Eigentümer/Schlüsselperson | keine Prokura, ein GF = Alleingesellschafter, keine Team-Seite (nur Signal; Altersband fließt nicht ein) | FLAG (schwach) |
| Investitions-/Sanierungsstau | sinkendes AV bei hoher Anlagenintensität über Jahre (Signal) | FLAG (schwach) |
| Regulatorische Risiken / Lizenzen | wird bewusst nicht geprüft (Tokens sparen) | UNKNOWN → DD |
| Unzuverlässige Finanzinformationen | fehlende/verspätete Abschlüsse, Inkonsistenzen | FLAG |
| Turnaround nötig | Insolvenz-/Sanierungseintrag im Firmenbuch, i. L. | **FAIL** (Registerfakt) |

**FAIL** setzt die Automatik nur bei Registerfakten. Alle anderen Fälle
bleiben FLAG, bis jemand sie mit Evidenz bestätigt (Mandat: „Harte Ausschlüsse
erfordern belastbare Evidenz“). Fehlende Daten ergeben UNKNOWN, nie FAIL.
Fälle aus Mandat § 8 (z. B. niedrige Marge bei sehr guter Cash Conversion)
lösen kein FLAG aus.

**Exit:** Unit-Tests mit handgerechneten Fällen; Tier-A-FCF ≤ 10 % Abweichung
zur publizierten Geldflussrechnung in ≥ 80 % von 15–20 Großfirmen;
EBITDA-Schätzer-Fehlerband gemessen und in der UI angezeigt.

### Phase 4 — Cluster-Zuordnung (A1–B3)

1. **Vorfilter ÖNACE 2025** aus dem Geschäftszweig (= Tiefenstufe 0: Claude,
   50 Firmen pro Request, gecachte Taxonomie), dann ein Mapping auf die
   Mandats-Cluster, z. B.:
   - A1 Großhandel/Distribution ← ÖNACE 46
   - A2 Technische B2B-Dienstleistungen ← u. a. 33, 43.2, 71, 80–82
   - A3 Industrielle Nischen ← 20–30 (Herstellung)
   - B1 Healthcare/MedTech/Pharma-Distribution ← 46.46, 32.5, 21
   - B2 B2B-Software/Tech-Services ← 62, 63
   - B3 Asset-light-Logistik/Infrastruktur ← 49.4, 52 (ohne Asset-heavy)
   - „Out of Scope“ (z. B. B2C-Einzelhandel, Gastronomie, Bau-Generalunternehmer)
2. **Bestätigung per Website-Profil** (Phase 6): Cluster mit Konfidenz und
   Begründung; „Out of Scope“ ist ein Signal, kein Ausschluss.
3. **Clusterspezifische Prüfpunkte** aus Mandat § 4 als Kennzahlen:
   - A1: Vorräte-Intensität / Lagerbindung, Lieferantenkonzentration (KI-Hinweis)
   - A2: Service-/Wartungsverträge, Fachkräfte-Abhängigkeit (Stellenanzeigen)
   - A3: Anlagenintensität, Δ AV vs. AfA (Ersatz-CapEx)
   - B1: Nachfragequalität, Lieferantenrisiko (Regulatorik/Lizenzen nicht
     automatisiert → DD)
   - B2: Recurring-Signale, Personalintensität
   - B3: Anlagenintensität niedrig, vertragliche Erlöse
4. Manueller Override; Overrides fließen ins Kalibrierungsset.

**Exit:** ≥ 85 % korrekte Cluster im Kalibrierungsset.

### Phase 5 — Website-Discovery & Crawler (nur Qualified)

- **Discovery:** Impressum-FN-Match (§ 5 ECG) als Verifikationsschlüssel;
  Kandidaten aus Common Crawl (gratis), Rest über eine Such-API (z. B. Brave).
  Stufen: FN-Match > Name + PLZ > verwerfen.
- **Crawler:** robots.txt und 1 Request/s pro Domain (verhindert Sperren),
  ≤ 15 Seiten (Start, Über uns, Leistungen, Branchen/Referenzen,
  Team/Geschäftsleitung, Karriere, News, Standorte, Impressum), bereinigter
  Text in `web_pages`, kein Roh-HTML dauerhaft. Crawlen ist billig, Tokens
  sind es nicht: Gecrawlt wird großzügig, ans LLM geht nur die Seitenauswahl
  der jeweiligen Tiefenstufe (Phase 6).
- **Deterministische Signale:** offene Stellen (inkl. Führungsrollen wie
  „Geschäftsführer“/„Nachfolge“), Sprachversionen/Export, Zertifikate,
  Standorte, „seit 19xx“, Team-Seite mit zweiter Ebene, Webshop (B2C-Hinweis).
- **Quellen:** nur die Firmen-Websites, kein LinkedIn und keine
  Verzeichnisse. Das hält Crawl-Aufwand und Tokens klein.

**Exit:** ≥ 70 % der Qualified mit verifizierter Domain.

### Phase 6 — KI-Profil mit clusterabhängiger Tiefe

Profile entstehen über die Claude Message Batches API mit Structured Outputs
(`zod` ist schon Dependency). Jedes Feld trägt `value | UNKNOWN`, eine
Quell-URL und ein Kurzzitat. Aussagen ohne Beleg werden verworfen.

**Tiefenstufen.** Der Token-Verbrauch richtet sich nach Cluster-Priorität und
Finanzbild. Die Budgets stehen in `mandate.*.json`, die Modellwahl je Stufe
misst Spike 0.6.

| Stufe | Für wen | LLM-Input | Output | ~Kosten/Firma* |
| --- | --- | --- | --- | --- |
| 0 Klassifikation | ganzes Universe | Firmenwortlaut + Geschäftszweig, **50 Firmen pro Request**, Taxonomie gecacht | Cluster-Kandidat, ÖNACE | ~0,1 ct |
| 1 Triage | alle Qualified | Start- + Über-uns-Seite, ≤ 4 Tsd. Token | Cluster-Bestätigung, 3–5 Signale, Stopp bei Out of Scope; ≤ 500 Token | ~1,3 ct |
| 2 Standard | B1–B3 | ≤ 6 Seiten, ≤ 8 Tsd. Token | Kernprofil; ≤ 1,5 Tsd. Token | ~3 ct |
| 3 Vertieft | A1–A3 **und** B-Firmen mit Finanz-Kategorie ≥ 4/5 (Mandat § 2) | ≤ 15 Seiten, ≤ 15 Tsd. Token | volles Profil; ≤ 3 Tsd. Token | ~6 ct |
| 4 Deep Profile | Priority (10–15) | alle Daten + Notizen + Peers, ~50 Tsd. Token | One-Pager (Phase 8); ≤ 8 Tsd. Token | ~0,40 $ |
| – | Out of Scope nach Triage | – | – | 0 |

\*Opus 5.5 zu Batch-Preisen (Stufe 4 interaktiv ohne Batch), Thinking-Tokens
im Output eingerechnet. Ein Beispiel-Lauf mit 15 Tsd. Universe, 3 Tsd.
Triage, 500 Standard, 800 Vertieft und 15 Deep Profiles kostet **≈ 120 $**.
Mit einem kleineren Modell für die Stufen 0–1 wären es ≈ 70 $, falls Spike
0.6 bestätigt, dass die Qualität dort reicht.

**Inhalte je Stufe** (kumulativ):

- **Stufe 1:** Geschäftsmodell in zwei Sätzen, B2B/B2C, Cluster, Grund für
  Out of Scope
- **Stufe 2:** Produkte/Use Cases, Zielkunden, Nischenführer/regionale
  Stärke, Hinweise auf Kundenkonzentration und Lieferantenabhängigkeit,
  zweite Führungsebene (Team-Seite), wiederkehrende Erlöse,
  Internationalität
- **Stufe 3:** Wertsteigerungshebel (Wachstum, Professionalisierung,
  Digitalisierung, KI), Risiken mit Beleg (für die FLAG-Regeln), genannte
  Wettbewerber → Position relativ zu AT-Peers, Buy-and-Build-Potenzial
- **Nicht abgefragt:** Lizenzen, Regulatorik, Datenschutz (→ DD)

**Token-Sparregeln:**

- Batch API (−50 %), Prompt Caching für System-Prompt, Rubrik und Taxonomie
- Text vor dem LLM deterministisch säubern: Navigation, Footer und
  Cookie-Banner entfernen, seitenübergreifende Duplikate streichen, Seiten
  per Keyword-Score auswählen
- Finanzdaten als kompakte Kennzahlenzeile, nicht als JSON-Dump
- `max_tokens` und Effort je Stufe begrenzen, kompaktes Output-Schema
- Kein Re-Run ohne geänderten `input_hash` (Content-Hash der Seiten)
- **Eskalation statt Vorab-Tiefe:** Eine Firma steigt erst auf, wenn die
  günstigere Stufe Fit signalisiert
- **Budget-Deckel pro Lauf:** Abarbeitung nach Cluster-Priorität ×
  Finanzscore; ist der Deckel erreicht, stoppt der Lauf, statt Inputs zu
  kürzen

Profile sind versioniert (`model`, `prompt_version`, `stage`, `input_hash`)
und in der UI als KI-generiert gekennzeichnet.

**Exit:** < 2 % unbelegte Aussagen in der Stichprobe; Qualitätsziel im Eval
erreicht.

### Phase 7 — Target Fit Scoring, Pipeline, Kalibrierung

**Score-Engine** (`analytics/target-fit.js`), Formel exakt nach Mandat § 9:
`Punkte_k = Bewertung_k (0–5) × Gewicht_k / 5`, Summe max. 20.

| Kategorie (Gewicht) | Automatische Inputs | Typischer Status vor DD |
| --- | --- | --- |
| Finanzielle Qualität & Cashflow (5) | FCF-Niveau/-Stabilität, Marge bzw. Spanne, Cash Conversion, EK-Quote, Net Debt | Tier A: belastbar · Tier B: Spanne |
| Geschäftsmodell & Marktposition (4) | Cluster-Priorität (A > B), § 5-Signale, Recurring, Peer-Position | teilweise |
| Management & Nachfolgefähigkeit (4) | Prokura/zweite Ebene, Team-Seite, GF-Struktur | Signale, oft UNKNOWN |
| Bewertung & Finanzierbarkeit (3) | EV-Spanne 4–7x, Schuldenkapazität 2–3x vs. bestehende Net Debt, EK-Lücke | Spanne |
| Wertsteigerungspotenzial (2) | Digitalisierungs-/Professionalisierungshebel, Wachstum, Internationalisierung | KI-Signale |
| Persönlicher CEO-Fit (2) | **manuell** (Präferenzen aus `mandate.local.json` als Vorschlag) | manuell |

**UNKNOWN wird nicht als 0 gezählt.** Der Score erscheint als **Spanne**:
pessimistisch (UNKNOWN = 0), optimistisch (UNKNOWN = 5) und Mittelwert, z. B.
„14,8 (11,9–17,6)“. Das Prioritätsband (17–20 hoch / 14–16,9 vertiefen /
11–13,9 beobachten / < 11 niedrig) folgt dem Mittelwert, eine breite Spanne
markiert „mehr Recherche nötig“.

**Getrennt ausgewiesen** (Mandat § 9):

- **Data Confidence:** Tier, Aktualität des Abschlusses, verifizierte Website,
  Anteil belegter Kriterien
- **Deal Readiness:** Amtsdauer und Anzahl der GF, Namensgleichheit
  GF/Prokura (Familie), kein erkennbarer Nachfolger in GF/Prokura;
  Eigentümerstruktur erst nach vollem Auszug (Priority). Das **Altersband** wird
  als Kontext angezeigt; aussagekräftig ist es nur im Zusammenspiel (z. B.
  60+ *und* Alleingesellschafter *und* keine zweite Ebene). Es ist nie
  Ausschlussgrund, Score-Abzug oder Filter-Default. Manuelle Netzwerk-Infos
  haben Vorrang.
- **Research Status:** Pipeline-Stufe + Checkliste offener Punkte

**Pipeline** (Mandat § 10) in `data/mandate.db`:

- Stufen: Universe → Qualified → Priority → Active Opportunity, dazu
  Geparkt/Verworfen mit Grund
- Universe → Qualified **automatisch vorgeschlagen** (Größenband, kein FAIL,
  Cluster ≠ Out of Scope). Qualified → Priority **nur manuell** (Mandat:
  „persönliche manuelle Prüfung“)
- **Kanal-Feld:** KI-Recherche | Netzwerk (Quelle: Family Office, Anwalt,
  Nachfolgeberater, …). Netzwerk-Targets lassen sich manuell anlegen, auch
  ohne Registerdaten (CH/DE)
- Notizen, nächster Schritt, Datum. Kontaktpersonen nur minimal und
  getrennt (§ 11)

**Kalibrierung** (90-Tage-Ziel „100–200 Unternehmen manuell kalibriert“):

- Review-Ansicht: Systemvorschlag pro Kategorie + Belege → manuelle Bewertung
  0–5 mit Kommentar; gespeichert werden beide Werte
- Auswertung: Übereinstimmung pro Kategorie, systematische Über-/
  Unterbewertung, Fehlerband der Schätzer → Gewichte/Schwellen in
  `mandate.local.json` anpassen → Mandatsversion 1.1

✅ **Screener v1** (vor Score und KI-Profil): Route `#screen`,
`GET /api/screen` + `/api/screen.csv` (`server/screen.js`):
- Filter: EBITDA-Band Kern/erweitert/alle, Bundesland, Konzern,
  übernahmefähige Rechtsform, Name
- sortierbare Spalten: Umsatz bzw. Rohergebnis, EBITDA, Δ VJ, Marge,
  Bilanzsumme, EK-Quote, Organe als Kontext
- Klick auf eine Zeile öffnet die Detailansicht

**UI** (`public/`, Tokens nur in `public/design/`): Tabs **Screener**
(Filter: Kern/erweitert, Cluster, Region, Tier, Score-Band, Deal Readiness;
Tabelle mit Score-Spanne und Badges), **Pipeline** (Kanban nach Stufen),
**Kalibrierung**. Die Detailansicht bekommt die Tabs Cashflow, Profil,
Mandats-Check (alle Kriterien mit Status + Evidenz) und Wettbewerb.

**Exit:** 100–200 Firmen kalibriert; Kategorie-Übereinstimmung System ↔
manuell (±1 Punkt) ≥ 70 % in den automatisierbaren Kategorien.

### Phase 8 — Deep Profiles & Monitoring

- **Deep Profile** (Ziel: 10–15) als One-Pager aus allen Daten + Notizen:
  Geschäftsmodell, KPI-Tabelle mit Quelle und Konfidenz, Cashflow-Reihe,
  Bewertungs-/Finanzierungsrahmen (EV 4–7x, Schulden 2–3x, EK-Lücke,
  mögliches Seller Loan), Nachfolgesituation, Mandats-Check, **offene
  DD-Fragen** (alles, was UNKNOWN ist). Export als Markdown/PDF.
- **Monitoring** über die Veränderungen-Feeds für Pipeline-Firmen: neuer
  Abschluss (Urkunden-Feed), GF-/Prokura-Wechsel (Signal: Nachfolge geregelt
  oder Deal weg), Löschung/Liquidation → Hinweis in der Pipeline. Der
  Firmen-Feed nennt nur die FN, nicht was sich geändert hat. Deshalb für
  Treffer die Kurzinformation neu laden und mit dem letzten Stand
  vergleichen.

### Phase 9 — Erweiterung DE/CH (nach den 90 Tagen, mit eigenem Spike)

- **DE:** Kleine Kapitalgesellschaften legen nur die Bilanz offen (§ 326 HGB),
  kleine und mittelgroße dürfen die GuV mit dem Rohergebnis beginnen
  (§ 276 HGB). Der Umsatz fehlt also noch häufiger als in AT. Zugang über
  Handelsregister/Unternehmensregister: Rate-Limits und
  Automatisierbarkeit im Spike prüfen. Der heutige GLEIF-Adapter reicht
  nicht.
- **CH:** Private AG/GmbH müssen keine Abschlüsse veröffentlichen → Zefix-
  Stammdaten + Website-Profil; Finanzkategorie bleibt UNKNOWN; die Schweiz
  läuft im Wesentlichen über den Netzwerk-Kanal.

---

## 7. Datenhaltung & Trennung (Mandat § 11)

- **Registerdaten** (öffentlich, mandatsneutral): `data/kontur.db` wie bisher.
- **Mandatsdaten** (Pipeline, Notizen, manuelle Scores, Kalibrierung,
  Kontakte): `data/mandate.db`, gitignored, eigener Migrationspfad.
- **Mandatskonfiguration:** `config/mandate.example.json` versioniert,
  `config/mandate.local.json` gitignored (persönliche Präferenzen,
  CEO-Fit).
- Neue Tabellen in `kontur.db` (Entwurf): `at_company_profile`, `cashflow_yearly`,
  `estimates`, `criteria_status`, `industry_class`, `web_domains`, `web_pages`,
  `ai_profiles`, `peer_edges`, `jobs`.
- Neue Tabellen in `mandate.db`: `pipeline_entries`, `notes`, `manual_scores`,
  `target_scores` (Snapshot je Mandatsversion), `contacts` (minimal).

## 8. Bewusst nicht im Scope

- **Lizenz- und Datenschutzprüfungen** finden nicht statt, weder für die
  Datenquellen (IWG, Website-Inhalte) noch in der Target-Analyse. Die
  betroffenen Mandatskriterien (§ 5 übertragbare Lizenzen, § 7 regulatorische
  Risiken/Lizenzen) bleiben UNKNOWN und gehören in die DD.
- Was bleibt, ist technisch begründet und kostet keine Tokens: robots.txt und
  Rate-Limits im Crawler (verhindert Sperren), der bestehende Hinweis „kein
  amtlicher Auszug“, Kennzeichnung der KI-Profile.

## 9. 90-Tage-Abgleich (Mandat § 12)

| Mandats-Erfolgskriterium | Plan-Ergebnis | ~Zeitraum |
| --- | --- | --- |
| Suchmandat validiert | `mandate.example.json` + Abgleich mit realen Daten (Phase 0, § 3–4) | Woche 1–2 |
| Datenquellen geprüft | Phase-0-Entscheidungsvorlage inkl. Kosten und Limits | Woche 1–2 |
| Skalierbares Universe aufgebaut | Phase 1–2 (AT vollständig, inkrementell) | Woche 2–6 |
| 100–200 Unternehmen manuell kalibriert | Phase 3–4 + Kalibrierungs-UI (Phase 7) | Woche 5–10 |
| 30–50 priorisierte Kandidaten | Phase 5–7, Pipeline-Stufe „Priority“ | Woche 7–11 |
| 10–15 vertiefte Profile | Phase 8 Deep Profiles | Woche 10–13 |
| Erste diskrete Netzwerkgespräche | Pipeline-Kanal „Netzwerk“, Deep Profiles als Gesprächsgrundlage | ab Woche 8 |

**MVP nach ~6 Wochen:** Phasen 0–3 + Screener mit Größenband, Tier,
Cashflow, Schätzern, Ausschluss-Flags und Deal-Readiness-Signalen, noch ohne
KI-Profil. Das reicht bereits für die manuelle Kalibrierung der ersten
Firmen. Website- und KI-Strang (Phasen 5–6) laufen parallel, sobald die
Modellwahl (0.6) steht.

```
Phase 0 ──► 1 ──► 2 ──► 3 ──┬──► 7 (Score, Pipeline, Kalibrierung) ──► 8 ──► (9)
                    └──► 4 ──► 5 ──► 6 ──┘
```

## 10. Was NICHT zu tun ist

- Keine bestehenden Felder in `jab-parser.js` umbenennen, nur ergänzen.
- Keine Bulk-Downloads, solange 0.1 offen ist.
- Altersband nie als Ausschluss, Score-Abzug oder Filter-Default verwenden.
- Keine Lizenz-, Regulatorik- oder Datenschutzfragen in die Prompts.
- Kein automatisches FAIL ohne Registerfakt bzw. bestätigte Evidenz;
  UNKNOWN nie als FAIL oder 0 werten.
- Keine Punktwerte für geschätzte KPIs in der UI, immer Spanne + Konfidenz.
- KI-Tiefe nur gemäß Tiefenstufe: Über Stufe 0 hinaus nur Qualified-Firmen,
  Out of Scope stoppt nach der Triage.
- Keine automatisierte Kontaktaufnahme zu Eigentümern; der Erstkontakt
  bleibt manuell und diskret.
- Kein Headless-Browser als Standard-Crawler.
