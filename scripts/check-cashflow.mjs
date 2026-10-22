#!/usr/bin/env node
// Unit checks for server/analytics/cashflow.js on hand-computed examples.
// Usage: node scripts/check-cashflow.mjs        (exit code 1 on failure)

import { computeCashflow } from '../server/analytics/cashflow.js';

let failures = 0;
const eq = (actual, expected, label, tol = 0.01) => {
  const ok = expected === null ? actual === null : Math.abs(actual - expected) <= tol;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${actual}${ok ? '' : ` (erwartet ${expected})`}`);
  if (!ok) failures++;
};

// Balance sheet builder (values in T€ for readability).
function bs({ immat = 0, sach = 0, fin = 0, vorraete = 0, ford = 0, fordVu = 0, kasse = 0, wp = 0, rap = 0,
  ek = 0, rueck = 0, bank = 0, anleihen = 0, verbVu = 0, verbRest = 0, pRap = 0 }) {
  const av = immat + sach + fin, uv = vorraete + ford + kasse + wp;
  const verb = bank + anleihen + verbVu + verbRest;
  return {
    aktiva: {
      total: av + uv + rap,
      anlagevermoegen: { total: av, immaterielle: immat, sachanlagen: sach, finanzanlagen: fin },
      umlaufvermoegen: { total: uv, vorraete, forderungen: ford, forderungenVerbundene: fordVu, kassenbestand: kasse, wertpapiere: wp },
      rechnungsabgrenzung: rap,
    },
    passiva: {
      total: ek + rueck + verb + pRap,
      eigenkapital: { total: ek },
      rueckstellungen: rueck,
      verbindlichkeiten: { total: verb, kreditinstitute: bank, anleihen, verbundene: verbVu },
      rechnungsabgrenzung: pRap,
    },
  };
}

// Example firm. Prior year (t−1) balances:  1 000 = 1 000
const prior = { stichtag: '2024-12-31', balanceSheet: bs({
  sach: 400, fin: 50, vorraete: 150, ford: 200, fordVu: 20, kasse: 180, wp: 20,
  ek: 500, rueck: 100, bank: 250, verbVu: 30, verbRest: 120,
}) };
// Year t: JÜ 120, AfA 60, EBITDA 200, Zinsen 10, Ausschüttung 70, capex 90,
// Vorräte +20, Forderungen +30 (davon Konzern +5), Lieferanten +10,
// Rückstellungen +15, Bank −50, Finanzanlagen +10, Konzernverb. +5.
const cur = {
  stichtag: '2025-12-31',
  guv: { jahresueberschuss: 120, abschreibungen: -60, ebitda: 200, betriebserfolg: 140, zinsaufwand: -10 },
  balanceSheet: bs({
    sach: 430, fin: 60, vorraete: 170, ford: 230, fordVu: 25, kasse: 120, wp: 20,
    ek: 550, rueck: 115, bank: 200, verbVu: 35, verbRest: 130,
  }),
};
// Hand calculation:
//   NWC(t−1) = 150 + (200−20) − 120 = 210 ; NWC(t) = 170 + (230−25) − 130 = 245 → ΔNWC = 35
//   CFO = 120 + 60 + 15 − 35 = 160 ; CapEx = (430−400) + 60 = 90 ; FCF = 70
//   Kasse(t) follows from the flows: 200 + FCF 70 − Ausschüttung 70 − Bank 50 − ΔFinanzanlagen 10 = 140
//   Net Debt(t) = 200 − 140 = 60 ; Net Debt(t−1) = 250 − 200 = 50
//   Konzernsaldo(t) = 35 − 25 = 10 ; (t−1) = 30 − 20 = 10
//   Ausschüttung netto = 500 + 120 − 550 = 70 ; ΔFinanzanlagen = 10
//   Gegenprobe: −(60−50) − 0 + 10 + 70 = 70 = FCF → Residual 0
const r = computeCashflow(cur, prior);
console.log('\nBeispiel A — Standardfall');
eq(r.cfo, 160, 'CFO');
eq(r.capex, 90, 'CapEx');
eq(r.fcf, 70, 'FCF');
eq(r.netDebt, 60, 'Net Debt');
eq(r.netDebtEbitda, 0.3, 'Net Debt / EBITDA');
// FCF operativ = EBIT 140 × 0,77 + AfA 60 + ΔRückst 15 − ΔNWC 35 − CapEx 90 = 57,8
eq(r.fcfOperativ, 57.8, 'FCF operativ (unlevered, nach Steuern)');
eq(r.cashConversion, 0.289, 'Cash Conversion (FCF operativ / EBITDA)', 0.001);
eq(r.ausschuettungNetto, 70, 'Netto-Ausschüttung');
// Both balance sheets balance, so the identity must close exactly: the
// residual is the change in the lines the model leaves out (none here).
const t = cur.balanceSheet, v = prior.balanceSheet;
eq(t.aktiva.total - t.passiva.total, 0, 'Bilanz t ausgeglichen');
eq(v.aktiva.total - v.passiva.total, 0, 'Bilanz t−1 ausgeglichen');
eq(r.residual, 0, 'Gegenprobe Finanzierungsseite (Residual)');
eq(r.quality === 'ok' ? 1 : 0, 1, 'Qualität ok');

// Example B — a RAP of 40 builds up and is financed by the bank: the model
// does not cover RAP, so exactly that amount must show up as residual.
const curB = structuredClone(cur);
curB.balanceSheet = bs({
  sach: 430, fin: 60, vorraete: 170, ford: 230, fordVu: 25, kasse: 120, wp: 20, rap: 40,
  ek: 550, rueck: 115, bank: 240, verbVu: 35, verbRest: 130,
});
const rB = computeCashflow(curB, prior);
console.log('\nBeispiel B — nicht modellierte Position (aktive RAP +40)');
eq(rB.fcf, 70, 'FCF unverändert');
eq(rB.residual, -40, 'Residual = −ΔRAP');

// Example C — no GuV (small form): FCF still derivable (tier B), CFO not.
const curC = { stichtag: '2025-12-31', jahresergebnis: 120, balanceSheet: cur.balanceSheet };
const rC = computeCashflow(curC, prior);
console.log('\nBeispiel C — Kurzform ohne GuV');
eq(rC.tier === 'B' ? 1 : 0, 1, 'Tier B');
eq(rC.fcf, 70, 'FCF aus Bilanzen + JÜ');
eq(rC.cfo, null, 'CFO nicht ableitbar');

// Example D — expenses reported positive by the filing software.
const curD = structuredClone(cur);
curD.guv.abschreibungen = 60;
console.log('\nBeispiel D — positive AfA-Vorzeichen');
eq(computeCashflow(curD, prior).cfo, 160, 'CFO unverändert');

// Example F — holding: dividends from subsidiaries dominate the result.
// Total FCF jumps with the dividend, the operating FCF does not.
const curF = structuredClone(cur);
curF.guv = { ...cur.guv, jahresueberschuss: 1120, finanzerfolg: 1000 };
curF.balanceSheet.passiva.eigenkapital.total += 1000;
curF.balanceSheet.aktiva.umlaufvermoegen.kassenbestand += 1000;
const rF = computeCashflow(curF, prior);
console.log('\nBeispiel F — Holding mit Beteiligungserträgen');
eq(rF.fcf, 1070, 'FCF gesamt inkl. Dividende');
eq(rF.fcfOperativ, 57.8, 'FCF operativ unverändert');
eq(rF.warnings.some((w) => w.includes('Holding')) ? 1 : 0, 1, 'Warnung Holding');

// Example G — Neugründung: tiny prior year, deltas are meaningless.
const priorG = { stichtag: '2024-12-31', balanceSheet: bs({ sach: 10, kasse: 40, ek: 35, verbRest: 15 }) };
const rG = computeCashflow(cur, priorG);
console.log('\nBeispiel G — Strukturbruch (Vorjahr 50 vs. 1 030)');
eq(rG.quality === 'pruefen' ? 1 : 0, 1, 'Qualität „prüfen“');
eq(rG.warnings.some((w) => w.startsWith('Strukturbruch')) ? 1 : 0, 1, 'Warnung Strukturbruch');

// Example E — Rumpfgeschäftsjahr gets a warning.
const rE = computeCashflow({ ...cur, stichtag: '2025-06-30' }, prior);
console.log('\nBeispiel E — Rumpfgeschäftsjahr');
eq(rE.warnings.some((w) => w.includes('6 statt 12')) ? 1 : 0, 1, 'Warnung Rumpf-GJ');

console.log(failures ? `\n✗ ${failures} Problem(e)` : '\n✓ alle Cashflow-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
