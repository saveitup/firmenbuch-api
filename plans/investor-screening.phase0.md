# Phase 0 — Ergebnisse

Gehört zu [investor-screening.md](investor-screening.md). Stand 2026-10-22.

| Spike | Status |
| --- | --- |
| 0.1 Kosten & Limits HVD/IWG | offen |
| **0.2 GuV-/Vorjahres-/AN-Abdeckung** | **erledigt** (unten) |
| **0.3 Veränderungen-Feed** | **erledigt** (unten) |
| **0.4 AUSZUG-Inhalt** | **erledigt** (unten) |
| 0.5 Website-Trefferquote | offen |
| 0.6 LLM-Qualität & Kosten | offen |
| 0.7 Kalibrierungsset | offen |

Re-Run ohne neue IWG-Calls (Rohdaten liegen gitignored in `data/staging-at-*`):

```bash
node --env-file=.env scripts/spike-at-jab.mjs
node scripts/spike-at-auszug.mjs --analyse
node scripts/spike-at-veraenderungen.mjs --analyse
```

---

## 0.2 — Was die JAb-XMLs enthalten

**Stichprobe:** 15 Abschlüsse aus der lokalen DB, 11 mit Bilanzsumme
> 6,25 Mio. € (u. a. voestalpine, STRABAG, Andritz, ASAMER Kies, Palmers,
Horvath & Partner) und 4 kleine (Autohändler, Handel), Stichtage 2023–2025.

### Ergebnis in einem Satz

**Die GuV ist bei allen Abschlüssen im Vollformat vorhanden. Der heutige
Parser liest sie im alten BMF-Format nur nicht** (`parseBmfLegacy` setzt
`umsatzerloese: null` fest). Daher kommen die 6 von 571 Zeilen mit Umsatz,
nicht daher, dass Firmen keine GuV einreichen.

### Formate

| Format | Anteil Stichprobe | Erkennung | GuV? |
| --- | --- | --- | --- |
| BMF-Legacy, Vollform | 5/15 | `ALLG_JUSTIZ/JABFORM/HGBFORM = "JAB"` | ✔ Abschnitt `BILANZ_GLIEDERUNG/GUV`, Positionen `HGB_231_2_*` |
| BMF-Legacy, Kurzform (klein) | 7/15 | `HGBFORM = "UGB23"`, Abschnitte `HGB_Form_2/3` | ✖ nur Bilanz |
| v4 (JAb 4.0), Vollform | 1/15 | `GROESSENKLASSE = "G"`, Abschnitt `GUV_GKV` | ✔ sprechende Elementnamen |
| v4, kleine Form | 2/15 | `GROESSENKLASSE = "K"`, `JAHRESABSCHLUSS_KONZERNABSCHLUSS = "JAB-ANLAGE12"` | ✖ Bilanz + Anhang-Auszug |

Historische Jahre liegen überwiegend im BMF-Format vor; beide Parser bleiben
nötig. v4 trägt die **Größenklasse explizit** (`G`/`K`, vermutlich auch `M`).

### BMF-GuV: Positionsnummern (verifiziert über Summen)

An ASAMER Kies (GJ 2024) nachgerechnet: Die Summe von Z1–Z8 ergibt exakt Z9,
Z10–Z15 ergeben Z16, Z9 + Z16 ergibt Z17, Z17 + Z21 ergibt Z22.
Gegengeprüft an voestalpine, STRABAG und Horvath & Partner.

| Tag | Bedeutung | für |
| --- | --- | --- |
| `HGB_231_2_1` | Umsatzerlöse | Umsatz, Marge |
| `HGB_231_2_HGB_279` | **Rohergebnis** (statt Z1/Z5, mittelgroße GmbH) | – |
| `HGB_231_2_2` / `_3` / `_4` | Bestandsveränderung / aktivierte Eigenleistungen / sonstige betr. Erträge | – |
| `HGB_231_2_5` | Materialaufwand | – |
| `HGB_231_2_6` | Personalaufwand | Personalintensität |
| `HGB_231_2_7` | **Abschreibungen** | EBITDA, Maintenance-CapEx-Proxy |
| `HGB_231_2_8` | sonstige betriebliche Aufwendungen | – |
| `HGB_231_2_9` | **Betriebserfolg (EBIT)** | EBIT |
| `HGB_231_2_10`–`_14` | Finanzerträge/-aufwendungen | – |
| `HGB_231_2_15` | **Zinsen und ähnliche Aufwendungen** | DSCR, Net Debt |
| `HGB_231_2_16` | Finanzerfolg | – |
| `HGB_231_2_17` | Ergebnis vor Steuern | – |
| `HGB_231_2_21` | **Steuern vom Einkommen** | FCF nach Steuern |
| `HGB_231_2_22` | **Jahresüberschuss/-fehlbetrag** | FCF |
| `HGB_231_2_24`/`_25`/`_27` | Auflösung/Zuweisung Rücklagen | Ausschüttungs-Herleitung |
| `HGB_231_2_28` / `_29` | Gewinnvortrag / Bilanzgewinn | Ausschüttungs-Herleitung |

**Wichtig für den Kernkorridor:** Mittelgroße GmbHs weisen oft nur das
Rohergebnis aus (Horvath & Partner: kein Umsatz, Rohergebnis 14,4 Mio. €).
**EBITDA = Z9 − Z7 ist aber immer berechenbar.** Für das Mandat zählt ohnehin
das EBITDA, nicht der Umsatz. Der Umsatz bleibt in diesen Fällen eine Spanne
(Plan § 4).

### Vorjahresspalte

- In **allen** Positionen aller 15 Dateien ist `BETRAG_VJ` befüllt.
- Einheit: BMF `ALLG_JUSTIZ/VOR_GJ/WERT_TSD` (`j` = TEUR, `n` = EUR), v4
  `EINGABEDARSTELLUNG/DARSTELLUNG_VORHERGEHEND/EINHEIT`.
- **Gegenprobe:** In 5 von 5 Fällen (ASAMER Kies, Autohaus Horvath, Auto
  Blaser, Auto Centro, Palmers) entspricht die Vorjahres-Bilanzsumme exakt
  dem separat gespeicherten Vorjahresabschluss (bei TEUR auf 1 000 € gerundet).
- ⇒ **Ein Download liefert zwei Jahre** (Bilanz *und* GuV), damit sind Deltas
  ab dem ersten Abschluss möglich. Für eine 5-Jahres-Reihe genügen 3 statt 5
  URKUNDE-Calls.

### Mitarbeiter, Bankverbindlichkeiten, Größe

| Merkmal | Fundstelle | Abdeckung |
| --- | --- | --- |
| Durchschnittliche AN-Zahl | nur v4, `ANLAGE2_OFFENZULEGENDER_ANHANG/DURCHSCHNITTLICHE_ANZAHL_ARBEITNEHMER` | 2/15 (beide v4 klein); in BMF-Dateien nicht gefunden |
| Verbindlichkeiten ggü. Kreditinstituten | BMF Vollform `HGB_224_3_D_2` (+ Restlaufzeit `_HGB_225a/b`), v4 `VERBINDLICHKEITEN_GEGENUEBER_KREDITINSTITUTEN` | nur Vollform; Kurzform nur Summe Verbindlichkeiten + Restlaufzeit |
| Größenklasse | v4 `GROESSENKLASSE`; BMF indirekt über `HGBFORM` (JAB vs. UGB23) | 15/15 ableitbar |

**Größenklassen-Inferenz bestätigt sich in der Stichprobe:** Armstrong
Consulting (9,3 Mio. € Bilanzsumme) und HS Timber Group (56,8 Mio. €) reichen
die Kurzform ein. Damit liegen Umsatz ≤ 12,5 Mio. € und ≤ 50 AN nahe.

### Umsetzung (2026-10-22)

`server/jab-parser.js` liefert jetzt pro Abschluss zusätzlich:
- `guv`: Umsatz/Rohergebnis, Material, Personal, Abschreibungen,
  Betriebserfolg, Finanzerfolg, Zinsaufwand, EGT, Steuern, Ergebnis nach
  Steuern, Jahresüberschuss und `ebitda`, für BMF und v4
- `priorYear`: dieselbe Struktur aus der Vorjahresspalte

`umsatzerloese`, `betriebsergebnis` und `jahresergebnis` kommen bei
Vollform-Abschlüssen aus der GuV. Der Jahresüberschuss war bisher bei Firmen
mit Rücklagenbewegungen falsch, weil er aus Bilanzgewinn − Gewinnvortrag
hergeleitet wurde. Beispiele: voestalpine +114 → −209 Mio. €,
STRABAG 289 → 403 Mio. €, Horvath & Partner +2,7 → −4,2 Mio. €.

`npm run check:jab` über die 15 Dateien:
- keine Regression bei bestehenden Feldern
- GuV-Summenregeln stimmen im laufenden Jahr und im Vorjahr
- Vorjahr = gespeicherter Vorjahresabschluss in 14 von 15 Fällen

**Neue Erkenntnis — angepasste Vorjahreszahlen:** Bei Auto-Gusenbauer
weicht die Vorjahresspalte des Abschlusses 2024 vom Original-Abschluss 2023
ab (Bilanzsumme 6,12 statt 6,26 Mio. €). Die Firma hat ihr Vorjahr im
Folgeabschluss angepasst. Für die Cashflow-Deltas (Phase 3) heißt das:
**t und t−1 aus derselben Datei nehmen** (gleiche Bilanzierungsbasis); die
Original-Zeile des Vorjahres bleibt „wie berichtet“ stehen.
`upsertFinancials` fügt `priorYear` deshalb nur ein, wenn das Jahr noch
fehlt (`source_ref` mit Suffix `#VJ`); Originalzeilen werden nie
überschrieben. Für die Deltas braucht Phase 3 das Vorjahr aus dem
Abschluss von t aber auch dann, wenn die Originalzeile existiert. Dafür
gibt es zwei Wege: das Roh-XML speichern (Phase 2) oder den
`priorYear`-Block pro Zeile mitspeichern. Diese Entscheidung ist noch offen.

### Konsequenzen für den Plan

1. **Phase 2 wird kleiner und wertvoller:** Den BMF-GuV-Abschnitt zu parsen
   (Mapping oben) ist eine überschaubare Erweiterung von `parseBmfLegacy`.
   Danach sind alle Vollform-Firmen Tier A. Bestehende DB-Zeilen lassen sich
   nicht nachträglich anreichern, weil die Roh-XMLs nicht gespeichert wurden.
   **Künftig sollte das Roh-XML gespeichert werden**, damit spätere
   Parser-Verbesserungen keine neuen Calls kosten.
2. **Tier-Zuordnung über das Format statt über das Vorhandensein von Feldern:**
   JAB/v4-G/M ⇒ Tier A, UGB23/v4-K ⇒ Tier B.
3. **Die Mitarbeiterzahl ist aus den Abschlüssen kaum verfügbar.** Das passt
   dazu, dass sie laut Plan v3 ohnehin kein Kriterium ist.
4. Der Vorjahres-Trick reduziert die URKUNDE-Calls um ~40 %. Relevant, falls
   0.1 Gebühren bestätigt.

---

## 0.4 — Was der AUSZUG liefert

### Zugang

- WSDL: `https://justizonline.gv.at/jop/api/at.gv.justiz.fbw/ws/fbw.wsdl`
  (mit `X-API-KEY`). Operationen: `AUSZUG`, `AUSZUG_V1_`, `AUSZUG_V2_`,
  `SUCHEFIRMA`, `SUCHEURKUNDE`, `URKUNDE`, `VERAENDERUNGENFIRMA`,
  `VERAENDERUNGENURKUNDE`, `WERTETABELLEN_V2_`.
- Request `AUSZUG_V2_REQUEST`: `FNR`, `STICHTAG`, `UMFANG` (Freitext).
- **Mit unserem Token funktioniert nur `UMFANG = "Kurzinformation"`.**
  „aktueller Auszug“, „historischer Auszug“ und weitere Varianten liefern
  `Der Parameter "UMFANG" fehlt oder ist ungültig`. `AUSZUG` und `AUSZUG_V1_`
  antworten mit HTTP 404. Vermutung: Der HVD-Zugang umfasst nur die
  Kurzinformation; der volle Auszug läuft über die kostenpflichtigen
  Verrechnungsstellen.

### Inhalt der Kurzinformation (7 Firmen)

| Feld | Element | Abdeckung | Nutzen |
| --- | --- | --- | --- |
| Firmenwortlaut, Adresse, Sitz (Ortnr.), Rechtsform, Gericht, Ersterfassung | `FI_DKZ02/03/06/07/09` | 7/7 | Stammdaten, Bundesland |
| **Geschäftszweig** | `FI_DKZ05/TEXT` | **2/7** („Unternehmensberatung“, „Autohandel, KFZ-Werkstätte“) | Cluster-Vorfilter, nur teilweise |
| **Homepage** | `FI_DKZ25/HOMEPAGE` | **1/7** (Andritz) | Website-Discovery, nur Bonus |
| **Organe** GF / Vorstand / Prokura | `FUN` (`@FKEN` = GF, VM, PR) + `FU_DKZ10/DATVON`, `VART` | 7/7 | zweite Ebene (Prokura), Amtsdauer |
| **Geburtsdatum** natürlicher Personen | `PER/PE_DKZ02/GEBURTSDATUM` | 7/7 | Altersband (Kontext) |
| Rechtstatsachen (Beschlüsse, Umgründungen …) | `RECHTSTATSACHE/RTS_DKZ50` | teilweise | Monitoring |
| **Gesellschafter / Anteile / Stammeinlagen** | (`FU_DKZ10/KAPITAL`, `PE_DKZ09/PE_FNR` im Schema) | **0/7** | ✖ nicht in der Kurzinformation |
| Aufsichtsrat | – | 0/7 (auch nicht bei der Andritz AG) | ✖ |

Beispiele, wie die Signale sich lesen:

- *Autohaus Erich Horvath:* zwei GF mit gleichem Nachnamen (Jahrgang 1943,
  seit 1979, und Jahrgang 1966, seit 2010) ⇒ familieninterne Nachfolge
  wahrscheinlich schon erfolgt
- *Auto-Gusenbauer:* ein GF (seit 2014) plus zwei Prokuristen, einer davon
  mit gleichem Nachnamen ⇒ Familienunternehmen mit zweiter Ebene
- *Horvath & Partner:* ein GF plus 11 Prokuristen ⇒ ausgeprägte zweite Ebene

### Konsequenzen für den Plan

1. **Eigentümerstruktur ist aus der HVD-Schnittstelle nicht verfügbar.** Damit
   entfallen als automatische Signale „Gesellschafter-GF ja/nein“,
   „Eigentümerkonzentration“ und das Auflösen von Holding-Ketten (Plan Phase 1
   Punkt 2 und 4). Optionen:
   - (a) voller Auszug über eine Verrechnungsstelle, kostenpflichtig, nur für
     die Shortlist (Priority, ggf. Qualified)
   - (b) Heuristik aus der Kurzinformation: alleiniger GF ohne Prokura,
     Namensgleichheit von GF und Prokura, Amtsdauer
   - (c) Netzwerk-Kanal und manuelle Recherche
   Empfehlung: (b) automatisch für alle, (a) nur für Priority-Kandidaten.
2. **Deal Readiness** stützt sich damit auf: Altersband und Amtsdauer der GF,
   Anzahl GF, Prokura vorhanden ja/nein, Namensgleichheit (Familie,
   möglicher interner Nachfolger).
3. **Geschäftszweig ist zu dünn** als alleinige Basis für die
   Cluster-Klassifikation (Stufe 0). Stufe 0 sollte zusätzlich Firmenwortlaut
   und Bilanzstruktur nutzen (z. B. Vorräte-Intensität → Handel/Produktion,
   Anlagenintensität → Asset-heavy). Die Website-Triage (Stufe 1) wird
   wichtiger.
4. **Homepage aus dem Register** ist ein Bonus, ersetzt aber nicht die
   Discovery über Impressum und Common Crawl (Phase 5).

---

## 0.3 — Veränderungen-Feeds

**Stichprobe:** 9 Einzeltage von Okt. 2024 bis Okt. 2026 (ein Dienstag je
Quartal, der 29.9. kurz vor der Offenlegungsfrist, ein Sonntag) plus ein
7-Tage-Fenster, jeweils für beide Operationen. Alle 20 Abrufe waren
erfolgreich.

### Zugang und Technik

| | `VERAENDERUNGENURKUNDE` | `VERAENDERUNGENFIRMA` |
| --- | --- | --- |
| Request | `VON`, `BIS` | `VON`, `BIS`, optional `GERICHT`, `RECHTSFORM`, `ARTDERVERAENDERUNG` |
| Antwort je Eintrag | `KEY` (beginnt mit der FN), `DOKUMENTART` (Code/Text), `VOLLZUGSDATUM`, `CONTENTTYPE` | `FNR`, `VNR`, `VOLLZUGSDATUM`, `ARTDERVERAENDERUNG`, `DETAIL` |
| Antwortzeit | **~16–18 s Grundlast** pro Call (auch bei 0 Treffern); 7 Tage in der Hochsaison: 22 s, 5,8 MB | 1–3 s pro Tag; 7 Tage: 6 s |
| Großes Fenster | 7 Tage mit 16 942 Einträgen ohne Fehler | 7 Tage mit 9 770 Einträgen ohne Fehler |
| Historie | mindestens bis Okt. 2024 verfügbar | dito |
| Wochenende | Sonntag: 0 Einträge | dito |

### Volumen: Jahresabschlüsse (Code 48) pro Werktag

| Tag | Firmen mit JAb | JAb-Dokumente | alle Dokumente |
| --- | --- | --- | --- |
| Di 20.01.2026 | 128 | 250 | 318 |
| Di 17.03.2026 | 231 | 458 | 492 |
| Di 19.05.2026 | 498 | 986 | 1 051 |
| Di 21.07.2026 | 834 | 1 655 | 1 764 |
| **Di 29.09.2026** (Frist 30.9.) | **4 497** | **8 953** | **9 423** |
| Mo–Fr 12.–16.10.2026 (Ø) | 1 561 | 3 119 | 3 388 |
| Di 20.10.2026 | 2 001 | 3 969 | 4 384 |
| Di 18.11.2025 | 377 | 748 | 926 |
| Di 15.10.2024 | 2 319 | 4 602 | 4 879 |

- **Hochrechnung:** grob **150 000–200 000 Jahresabschlüsse pro Jahr**,
  stark saisonal (Spitze um die Frist am 30.9.). Die Werte zwischen den
  Stichtagen sind interpoliert; die exakte Zahl liefert der Backfill.
- **Praktisch jeder Abschluss liegt als XML vor:** Die JAb-Dokumente sind
  fast immer XML/PDF-Paare (z. B. 29.9.: 4 452 XML bei 4 497 Firmen).
  PDF/OCR braucht es nur noch für ältere Jahrgänge.
- **Weitere Dokumentarten** (20.10.): Jahresabschluss berichtigt (137): 85,
  Bestätigungsvermerk (27): 85, Lagebericht (51): 80, Jahresabschluss
  vorläufig/unvollständig (164): 79, Konzernabschluss (49): 30,
  Liquidationsschlussbilanz (136): 14.

### Firmen-Feed

- Pro Werktag 675–5 192 Veränderungen. Die meisten sind „Änderung“ und
  folgen der JAb-Saison: Die Einreichung eines Abschlusses zählt
  offenbar als Änderung.
- **Neueintragungen 84–165 und Löschungen 54–105 pro Werktag.** Damit lässt
  sich der Status des Universe ohne Einzelabfragen aktuell halten.
- **`DETAIL` war in allen Stichproben leer.** Was sich geändert hat (z. B.
  ein GF-Wechsel), steht also nicht im Feed.

### Konsequenzen für den Plan

1. **Universe direkt aus dem Urkunden-Feed:** Jeder JAb-`KEY` trägt die FN
   und ist sofort per URKUNDE ladbar. SUCHEURKUNDE pro Firma entfällt, das
   spart einen Call je Firma. Backfill über 24 Monate in **Wochenfenstern:
   ~104 Calls, ~45 min**, danach 1 Call pro Tag (~20 s).
2. **Der Engpass ist der Dokument-Download, nicht der Feed:** Bei ~175 000
   Firmen pro Jahr liefert ein XML pro Firma dank Vorjahresspalte schon zwei
   Jahre. Das wären trotzdem ~175 000 URKUNDE-Calls für das volle Universe.
   Ob das wirtschaftlich ist, entscheidet 0.1 (Gebühren).
3. **Vorfilter ohne Download — bestätigt** (Prüfung unten): Firmen mit
   Lagebericht (51) oder Bestätigungsvermerk (27) im Feed reichen eine
   Vollform mit GuV ein (20 von 20). Im Sample betraf das **612 von 18 376
   Firmen (3,3 %)**, hochgerechnet ~5 000–6 000 Firmen pro Jahr. Kleine
   Firmen im unteren Kernkorridor (≤ 12,5 Mio. € Umsatz) fängt der Vorfilter
   nicht; sie brauchen den Download und sind Tier B.
4. **Ingest muss weitere Dokumentarten kennen** (Phase 2):
   - „berichtigt“ (137) ersetzt den Abschluss desselben Stichtags
   - „vorläufig/unvollständig“ (164) wird später ersetzt
   - Konzernabschluss (49) hilft bei der Holding-Erkennung
   - `at.js` berücksichtigt heute nur Code 48
5. **Monitoring** (Phase 8): FNRs aus dem Firmen-Feed mit den
   Pipeline-Firmen schneiden, für Treffer die Kurzinformation neu laden und
   mit dem letzten Stand vergleichen, weil der Feed selbst keine Details
   liefert.

### Vorfilter-Prüfung (Lagebericht/Bestätigungsvermerk → Vollform?)

**Stichprobe:** 20 der 609 Firmen, die im Feed-Sample einen Lagebericht oder
Bestätigungsvermerk *und* einen XML-Jahresabschluss eingereicht haben.
Gleichmäßig über den FN-Bereich verteilt (jede 30. Firma); alle 20 hatten
beides eingereicht. Liste: `data/staging-at-veraenderungen/prefilter-sample.json`,
Ergebnis: `logs/spike-prefilter.json`.

| Ergebnis | Anzahl |
| --- | --- |
| **Vollform mit GuV** | **20 / 20** (95 %-Konfidenz: ≥ 83 %) |
| davon v4 mittelgroß (`M`) | 8 |
| davon v4 groß (`G`) | 6 |
| davon BMF Vollform (`JAB`) | 6 |
| **EBITDA im Mandatsband 1,5–5 Mio. €** | **9 / 20** |

**Befund für das Mandat — Rohergebnis statt Umsatz:** 13 der 14
mittelgroßen Abschlüsse (7 von 8 v4-M, alle 6 BMF-JAB) weisen **nur das
Rohergebnis** aus, keinen Umsatz. Alle 6 großen nennen den Umsatz.
- **EBITDA ist bei allen 20 berechenbar.** Die **EBITDA-Marge** (Mandat
  ≥ 15 %) ist es bei den mittelgroßen aber nicht ohne Umsatzschätzung.
- Bester Schätz-Input: Umsatz ≈ Rohergebnis / Rohertragsquote der Branche
  (Großhandel niedrig, Dienstleistung hoch), als Spanne je Cluster
  (Plan § 4).
- Alternativ als robuste Qualitätskennzahl: EBITDA / Rohergebnis.

**Parser-Fixes aus dieser Stichprobe:** Die 20 Vollform-Dateien deckten
zwei Lücken auf, beide behoben und von `npm run check:jab` (jetzt
35 Dateien) abgedeckt:
1. Neuere v4-Abschlüsse benennen die sonstigen betrieblichen Erträge nach
   der Darstellung (`…_ZU_ROHERGEBNIS`, `…_ZU_UMSATZERLOESE`).
2. **Vorzeichen sind nicht einheitlich:** Manche Einreich-Software meldet
   Aufwendungen positiv. Der Parser normalisiert jetzt auf „Aufwand < 0“;
   Ertragsteuern werden aus Ergebnis nach minus vor Steuern hergeleitet,
   weil sie auch eine Erstattung sein können.

EBITDA und Betriebserfolg waren von beidem nicht betroffen (direkt gelesen
bzw. mit |AfA| berechnet).

**Nebenbefund Dateigröße:** Vollform-XMLs sind 0,2–7 MB groß, kleine
Abschlüsse 6–25 KB. Wer das Roh-XML für ~6 000 Vollform-Firmen pro Jahr
speichert, sollte komprimieren.
