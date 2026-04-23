# Härtungs-Plan: neue Adapter (DK, SK, EE, SI)

**Zweck.** Die vier frisch gebauten Adapter auf echte Register-Responses
härten, bis jeder die Exit-Kriterien erreicht oder klar dokumentiert,
warum nicht.

**Single-Click-Trigger.**
```
/loop node --env-file-if-exists=.env scripts/eval-new-adapters.mjs && cat plans/harden-adapters.md
```
Die Loop-Skill erkennt diesen Plan als autonome Aufgabe und arbeitet ihn
Iteration für Iteration ab. Claude liest vor jedem Schritt den aktuellen
Eval-Report und entscheidet anhand der unten stehenden Fix-Regeln.

Falls kein Loop-Skill verfügbar ist, alternativ:
```
claude "Arbeite plans/harden-adapters.md bis zu den Exit-Kriterien ab."
```

## Exit-Kriterien (global)

Der Plan ist fertig, wenn **eine** dieser Bedingungen für jeden konfigurierten
Adapter gilt:

- `stammCoverage ≥ 80 %` UND (wenn `hasFinancials: true`) `kpiCoverage ≥ 60 %`
- ODER **3 aufeinanderfolgende Fix-Runden ohne Verbesserung** für genau
  diesen Adapter — dann „bekannte offene Bugs" dokumentieren und weiter
- ODER der Adapter ist `configured: false` → automatisch übersprungen

Wenn alle Länder PASS oder ausgeschöpft → finale Zusammenfassung committen,
STOP.

## Ablauf pro Iteration

1. **Eval laufen lassen:**
   ```
   npm run eval:new
   ```
   Report: `logs/harden-new.json` · Markdown-Tabelle: stdout.

2. **Entscheiden:**
   - Alle Länder PASS → Exit. Committen und fertig.
   - Mindestens ein FAIL → weiter zu (3).

3. **Ein Land pro Iteration härten.** Wähle das mit der niedrigsten
   `kpiCoverage` (Tiebreaker: niedrigste `stammCoverage`).

4. **Fehlerquelle isolieren:**
   - Pick die erste FAIL-Fixture aus `logs/harden-new.json` für das Land.
   - Für `stammError`/`financialsError`: die Stack-Message zeigt, ob es
     HTTP 4xx/5xx, Parse-Fehler oder Timeout ist — Root-Cause-First.
   - Für „KPI leer, aber Company OK": Roh-Response ziehen (ad-hoc):
     ```
     # DK — iXBRL-Instance:
     node -e "import('./server/adapters/dk.js').then(async m => { const a = m.default; console.log(JSON.stringify(await a.getFinancials('<CVR>'), null, 2)); })"

     # SK — RUZ-JSON:
     curl -s "https://www.registeruz.sk/cruz-public/api/uctovne-jednotky?zmenaOd=2000-01-01&ico=<ICO>"
     curl -s "https://www.registeruz.sk/cruz-public/api/uctovna-jednotka?id=<id>"

     # EE — Annual-reports-Listing + XBRL:
     curl -s "https://ariregister.rik.ee/est/company/<code>/annual_reports" | head -c 2000
     curl -s "https://ariregister.rik.ee/aruanded/xbrl/<reportId>" | head -c 4000
     ```

5. **Fix anwenden** (genau eine Datei pro Runde bevorzugt — halte Diffs
   klein und committbar):
   - **Tag-Namen falsch** → Map in `server/<cc>-(i)xbrl-parser.js` ergänzen.
     Nicht umbenennen was funktioniert, nur addieren.
   - **HTML-Selektor stimmt nicht** → Regex in `server/adapters/<cc>.js`
     nachjustieren. Immer `cleanText(...)` dahinter.
   - **API-Endpoint anders** (z. B. falscher Query-Param) → URL in
     `server/adapters/<cc>.js` korrigieren.
   - **Auth-Fehler** → NICHT auto-fixen. Melde dem User, STOP.
   - **Komplette Upstream-Datenlücke** (Firma hat keinen Abschluss) →
     Fixture austauschen, nicht Code ändern. Kommentiere den Austausch.

6. **Re-eval nur für das betroffene Land:**
   ```
   npm run eval:new -- --country=<CC>
   ```

7. **Outcome bewerten:**
   - Coverage gestiegen → commit-Worthy-Fix. Auto-commit per Stop-Hook
     erledigt das. Gehe zu (1), nächste Runde.
   - Coverage gleich oder gesunken → als „Failed Round" für dieses Land
     markieren. Wenn 3 Failed Rounds in Folge → Land als „Exhausted"
     flaggen und in zukünftigen Iterationen überspringen.

8. **Nach jeder 3. Iteration** gesamten Harness laufen lassen
   (`npm run eval:new` ohne Filter), um Regressions in bereits
   bestandenen Ländern sofort zu sehen.

## Loop-State

Zustand wird in `logs/harden-new.loop.json` gehalten — Struktur:

```json
{
  "iteration": 7,
  "failedRounds": { "DK": 0, "SK": 1, "EE": 0, "SI": 3 },
  "exhausted": ["SI"],
  "lastCoverage": { "DK": {...}, ... }
}
```

Wenn die Datei fehlt, mit leerem State starten. Claude schreibt sie am
Ende jeder Iteration.

## Bekannte Stolpersteine pro Land

### DK
- iXBRL-Tags aus dem FSA-Taxonomie-Core. Bei Banken fehlt `fsa:Revenue`
  — Fallback `fsa:InterestIncome` oder `fsa:ProfitLossBeforeTax` als
  Umsatz-Proxy NICHT hinzufügen, stattdessen Umsatz = null lassen und
  in den Kommentar schreiben.
- `_liabEq` als Bilanzsumme-Fallback ist gewollt, nicht entfernen.
- Wenn `offentliggoerelser`-Response leer: Filing-Dokumenttyp stimmt
  evtl. nicht. `AARSRAPPORT` ist der Standard; in seltenen Fällen
  `SAMMENLAGT_AARSRAPPORT`. Beides akzeptieren.

### SK
- RUZ war während Erstbau offline. Erwartbar, dass einige `kod`-Namen
  (`VZS_T1`, `SUV_R01` …) neu gemappt werden müssen. Die Konstante
  `TAG_TO_KPI` im Adapter liegt in `kpisForZavierka` — dort ergänzen.
- Wenn `priloha-zavierky-kpi` 404 liefert: Fallback-Endpoint
  `/priloha-zavierky-udaje?id=...` versuchen.
- Banken liegen teils in RUZ nicht strukturiert → Fixture austauschen
  statt Code ändern.

### EE
- HTML-Selektoren (`RE_NAME`, `RE_STATUS`, …) gegen aktuelle RIK-Seite
  diffen. Wenn die Seite komplett umgebaut wurde → einzelne Regexe
  neu schreiben, NICHT auf cheerio/jsdom umsteigen (kein neuer Dep).
- `extractReportIds` greift auf Textlabel-Nähe zurück. Falls Jahre nicht
  erkannt werden, statt Regex den ersten-match Fallback-Pfad bevorzugen
  und Reports nach ID-Größe (höher = neuer) sortieren.

### SI
- Stub bleibt Stub, bis JOLP-AOP-Scraper gebaut wird. Solange
  `configured: false` gesetzt ist, zählt SI als "skipped", nicht FAIL.
- Wenn der User den Scraper aufgebaut haben möchte: separate Aufgabe,
  nicht Teil dieses Plans.

## Was NICHT zu tun ist

- Keine neuen Adapter in diesem Loop anlegen.
- Keinen OCR-Fallback für DK/EE/SI hinzufügen (das ist FR/UK-Territorium).
- Keine neuen npm-Dependencies.
- Keine parallelen Adapter-Ports (z.B. "alternativ über Proxy X") — wenn
  das nötig wird, STOP und User fragen.
- Kein Auto-Upgrade von Fixtures (falsche IDs), ohne zu kommentieren
  warum — sonst verliert der Plan seine Aussagekraft.

## Protokoll

Jede Iteration schreibt eine einzeilige Zusammenfassung nach
`logs/harden-new.log`:

```
2026-04-23T15:02:11Z  iter=3  country=DK  stamm=80%→100%  kpi=40%→60%  PASS
2026-04-23T15:08:44Z  iter=4  country=SK  stamm=60%→60%   kpi=40%→40%  (round-fail 1/3)
```

Am Ende: Finale Tabelle im gleichen Format als Commit-Body, Plan STOP.
