// Cash-flow derivation from one Jahresabschluss: its balance sheet, its GuV
// and the Vorjahr column of the same filing (same accounting basis — firms
// may restate the prior year). Indirect method, simplified; inputs are the
// rows produced by jab-parser.js. See plans/investor-screening.md, Phase 3.
//
//   CFO   = Jahresüberschuss + Abschreibungen + ΔRückstellungen − ΔNWC(operativ)
//   CapEx = Δ(immaterielle + Sachanlagen) + Abschreibungen
//   FCF   = CFO − CapEx                     (after interest and taxes, incl.
//                                            Finanzerfolg such as dividends)
//   FCF operativ = EBIT × (1 − KöSt) + AfA + ΔRückstellungen − ΔNWC − CapEx
//                  (unlevered, without Finanzerfolg — the mandate's "operativer
//                  Free Cashflow nach Steuern"; notional tax on EBIT)
//   Cash Conversion = FCF operativ / EBITDA
//   Net Debt = Anleihen + Bankverbindlichkeiten − Kasse − Wertpapiere (UV)
//
// Operating NWC = Vorräte + Forderungen − Konzernforderungen
//               − (Verbindlichkeiten − Finanzschulden − Konzernverbindlichkeiten).
// Built from totals minus the separately disclosed financing/group lines, so
// it also works for mittelgroße filers that lump the rest together.
//
// Cross-check via the financing side (balance-sheet identity):
//   FCF = −ΔNetDebt − ΔKonzernsaldo + ΔFinanzanlagen + Netto-Ausschüttung − ΔÜbrige
// `residual` is ΔÜbrige: balance-sheet lines the model ignores (RAP,
// Investitionszuschüsse, unversteuerte Rücklagen, latente Steuern, …). A large
// residual means the derived FCF should be read with care.

const TAX_RATE = 0.23;            // KöSt since 2024, notional tax on EBIT
const RESIDUAL_OK = 0.05;         // |residual| ≤ 5 % of Bilanzsumme → "ok"

const z = (x) => (x == null ? 0 : x);
const ratio = (num, den) => (num == null || den == null || den <= 0 ? null : num / den);

function positions(bs) {
  const a = bs?.aktiva || {}, p = bs?.passiva || {};
  const av = a.anlagevermoegen || {}, uv = a.umlaufvermoegen || {}, vb = p.verbindlichkeiten || {};
  const sachImmat = av.immaterielle != null || av.sachanlagen != null
    ? z(av.immaterielle) + z(av.sachanlagen)
    : (av.total != null ? av.total - z(av.finanzanlagen) : null);
  const cash = z(uv.kassenbestand) + z(uv.wertpapiere);
  const fordKonzern = z(uv.forderungenVerbundene) + z(uv.forderungenBeteiligung);
  const forderungen = uv.forderungen != null ? uv.forderungen
    : (uv.total != null ? uv.total - z(uv.vorraete) - cash : null);
  const finSchulden = z(vb.anleihen) + z(vb.kreditinstitute);
  const verbKonzern = z(vb.verbundene) + z(vb.beteiligung) + z(vb.gesellschafter);
  return {
    bilanzsumme: a.total ?? p.total ?? null,
    sachImmat,
    finanzanlagen: z(av.finanzanlagen),
    nwc: (forderungen == null || vb.total == null) ? null
      : z(uv.vorraete) + (forderungen - fordKonzern) - (vb.total - finSchulden - verbKonzern),
    rueckstellungen: z(p.rueckstellungen),
    eigenkapital: p.eigenkapital?.total ?? null,
    netDebt: finSchulden - cash,
    konzernsaldo: verbKonzern - fordKonzern,  // > 0: net payable to group / shareholders
    finSchuldenShown: vb.anleihen != null || vb.kreditinstitute != null,
  };
}

function monthsBetween(a, b) {
  const [ya, ma] = String(a).split('-').map(Number), [yb, mb] = String(b).split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/**
 * @param cur   row from parseJAb (current year)
 * @param prior its `priorYear` (same filing)
 * @returns cash-flow record, or null without a prior-year balance sheet
 */
export function computeCashflow(cur, prior) {
  if (!cur?.balanceSheet || !prior?.balanceSheet) return null;
  const t = positions(cur.balanceSheet), v = positions(prior.balanceSheet);
  const guv = cur.guv || null;
  const warnings = [];

  const jue = guv?.jahresueberschuss ?? cur.jahresergebnis ?? null;
  const afa = guv?.abschreibungen != null ? Math.abs(guv.abschreibungen) : null;
  const ebitda = guv?.ebitda ?? null;
  const tier = guv && afa != null ? 'A' : jue != null ? 'B' : null;
  if (!tier) return null;

  const dRueck = t.rueckstellungen - v.rueckstellungen;
  const dNwc = t.nwc != null && v.nwc != null ? t.nwc - v.nwc : null;
  const dSachImmat = t.sachImmat != null && v.sachImmat != null ? t.sachImmat - v.sachImmat : null;
  if (dNwc == null) warnings.push('Working Capital nicht ableitbar');
  if (dSachImmat == null) warnings.push('Anlagevermögen nicht aufgeschlüsselt');

  // FCF needs no Abschreibungen (they cancel), so tier B still gets one.
  const fcf = dNwc == null || dSachImmat == null ? null : jue + dRueck - dNwc - dSachImmat;
  const cfo = tier === 'A' && dNwc != null ? jue + afa + dRueck - dNwc : null;
  const capex = tier === 'A' && dSachImmat != null ? dSachImmat + afa : null;
  const ebit = guv?.betriebserfolg ?? null;
  const fcfOperativ = ebit != null && afa != null && dNwc != null && capex != null
    ? ebit - Math.max(0, ebit) * TAX_RATE + afa + dRueck - dNwc - capex
    : null;

  const ausschuettungNetto = t.eigenkapital != null && v.eigenkapital != null ? v.eigenkapital + jue - t.eigenkapital : null;
  const dFinanzanlagen = t.finanzanlagen - v.finanzanlagen;
  const residual = fcf == null || ausschuettungNetto == null ? null
    : (-(t.netDebt - v.netDebt) - (t.konzernsaldo - v.konzernsaldo) + dFinanzanlagen + ausschuettungNetto) - fcf;
  const residualQuote = residual != null && t.bilanzsumme ? Math.abs(residual) / t.bilanzsumme : null;

  // A balance sheet that changes size by more than 5× (Neugründung,
  // Umgründung, Verschmelzung) makes the year-over-year deltas meaningless.
  const strukturbruch = t.bilanzsumme > 0 && v.bilanzsumme > 0
    && (t.bilanzsumme / v.bilanzsumme > 5 || t.bilanzsumme / v.bilanzsumme < 0.2);
  if (strukturbruch) warnings.push('Strukturbruch: Bilanzsumme ändert sich um mehr als Faktor 5 (Neu-/Umgründung?)');
  if (prior.einheitKorrigiert) warnings.push('Einheit der Vorjahresspalte korrigiert (TEUR deklariert, Euro eingetragen)');

  const months = monthsBetween(prior.stichtag, cur.stichtag);
  if (months !== 12) warnings.push(`Geschäftsjahr ${months} statt 12 Monate`);
  if (t.bilanzsumme && Math.abs(dFinanzanlagen) > 0.2 * t.bilanzsumme) warnings.push('große Veränderung der Finanzanlagen (Beteiligungskauf/-verkauf?)');
  if (t.bilanzsumme && Math.abs(t.konzernsaldo) > 0.2 * t.bilanzsumme) warnings.push('hoher Konzern-/Gesellschaftersaldo (Cash-Pooling?)');
  if (ausschuettungNetto != null && ausschuettungNetto < 0) warnings.push('Kapitalzufuhr im Jahr');
  if (ebitda != null && ebitda <= 0) warnings.push('EBITDA nicht positiv');
  if (ebitda != null && ebitda > 0 && dNwc != null && Math.abs(dNwc) > ebitda) warnings.push('Working-Capital-Veränderung größer als EBITDA (einmalig?)');
  if (guv?.finanzerfolg != null && guv.finanzerfolg > Math.max(0, ebit ?? 0)) warnings.push('Ergebnis überwiegend aus Finanzerfolg (Holding?)');
  if (!t.finSchuldenShown) warnings.push('keine Finanzschulden ausgewiesen');

  return {
    stichtag: cur.stichtag,
    priorStichtag: prior.stichtag,
    tier,
    jahresueberschuss: jue,
    abschreibungen: afa,
    ebitda,
    deltaRueckstellungen: dRueck,
    deltaNwc: dNwc,
    cfo,
    capex,
    maintenanceCapex: afa,
    growthCapex: capex != null && afa != null ? Math.max(0, capex - afa) : null,
    fcf,
    fcfOperativ,
    cashConversion: ratio(fcfOperativ, ebitda),
    netDebt: t.netDebt,
    netDebtEbitda: ratio(t.netDebt, ebitda),
    konzernsaldo: t.konzernsaldo,
    ausschuettungNetto,
    finanzinvestitionen: dFinanzanlagen,
    residual,
    quality: residualQuote == null ? null : residualQuote <= RESIDUAL_OK && !strukturbruch ? 'ok' : 'pruefen',
    warnings,
  };
}

// ─── Multi-year series ──────────────────────────────────────────────────
// `filings`: [{ docKey, row }] — parsed Jahresabschlüsse of one firm. Each
// filing yields its own year (balance sheet + Vorjahr column). A year that
// no filing covers on its own — the Vorjahr of a newer filing whose
// predecessor balance sheet sits in an older filing — is bridged across the
// two documents and marked as such.
export function cashflowSeries(filings) {
  const byYear = new Map();
  for (const { docKey, row } of filings) {
    const cf = row && computeCashflow(row, row.priorYear);
    if (cf) byYear.set(cf.stichtag, { ...cf, sourceRef: docKey });
  }
  for (const { docKey, row } of filings) {
    const p = row?.priorYear;
    if (!p?.balanceSheet || byYear.has(p.stichtag)) continue;
    const older = filings.find((f) => f.row?.balanceSheet && monthsBetween(f.row.stichtag, p.stichtag) === 12);
    if (!older) continue;
    const cf = computeCashflow(
      { stichtag: p.stichtag, balanceSheet: p.balanceSheet, guv: p.guv, jahresergebnis: p.jahresergebnis },
      { stichtag: older.row.stichtag, balanceSheet: older.row.balanceSheet },
    );
    if (!cf) continue;
    cf.warnings.push('aus zwei Abschlüssen abgeleitet (Vorjahresspalte + älterer Abschluss)');
    byYear.set(cf.stichtag, { ...cf, sourceRef: `${docKey}+${older.docKey}` });
  }
  return [...byYear.values()].sort((a, b) => b.stichtag.localeCompare(a.stichtag));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Aggregate over the most recent `maxYears` fiscal years (by Stichtag,
// newest first). Only years whose financing-side cross-check closes count.
export function summarizeCashflows(series, maxYears = 3) {
  if (!series.length) return null;
  const newest = series[0].stichtag;
  const window = series.filter((cf) => monthsBetween(cf.stichtag, newest) < maxYears * 12);
  const ok = window.filter((cf) => cf.quality === 'ok' && cf.fcfOperativ != null);
  const ebitdaSum = ok.reduce((s, cf) => s + (cf.ebitda > 0 ? cf.ebitda : 0), 0);
  return {
    years: ok.length,
    vonStichtag: ok.length ? ok[ok.length - 1].stichtag : null,
    bisStichtag: ok.length ? ok[0].stichtag : null,
    fcfOperativMedian: median(ok.map((cf) => cf.fcfOperativ)),
    cashConversionMedian: median(ok.map((cf) => cf.cashConversion).filter((x) => x != null)),
    cashConversionKumuliert: ebitdaSum > 0 ? ok.reduce((s, cf) => s + cf.fcfOperativ, 0) / ebitdaSum : null,
    fcfPositivJahre: ok.filter((cf) => cf.fcfOperativ > 0).length,
    ebitdaMedian: median(ok.map((cf) => cf.ebitda).filter((x) => x != null)),
    jahre: window.map((cf) => ({
      stichtag: cf.stichtag, fcfOperativ: cf.fcfOperativ, cashConversion: cf.cashConversion,
      ebitda: cf.ebitda, quality: cf.quality, zweiAbschluesse: String(cf.sourceRef || '').includes('+'),
    })),
  };
}
