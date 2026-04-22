// Bilanz‑Kennzahlen — computed from the v4 Bilanzstruktur extracted by
// jab-parser. Every ratio is null‑safe: if an input is missing or zero in
// the denominator, the result is null and the UI shows "Nicht verfügbar".
// Methodology follows Austrian UGB-standard definitions (WU Wien,
// Abteilung für Unternehmensrechnung und Revision).

const pct = (num, den) => (num == null || !den) ? null : num / den;

/**
 * Compute all Bilanz-based ratios from a `balanceSheet` object (see
 * jab-parser.extractBalanceSheet). `jahresergebnis` is optional — if the
 * filing lacks a full GuV, ROE / ROA come back as null.
 */
export function computeRatios(balanceSheet, jahresergebnis = null) {
  if (!balanceSheet) return null;

  const a = balanceSheet.aktiva || {};
  const p = balanceSheet.passiva || {};
  const av = a.anlagevermoegen || {};
  const uv = a.umlaufvermoegen || {};
  const ek = p.eigenkapital || {};
  const vb = p.verbindlichkeiten || {};

  const bilanzsumme   = a.total ?? p.total ?? null;
  const eigenkapital  = ek.total ?? null;
  const anlagever     = av.total ?? null;
  const umlaufver     = uv.total ?? null;
  // Sub-positions: preserve null-vs-0 distinction (null = not reported by source,
  // 0 = reported as zero). Ratios that depend on a sub-position return null when
  // the source doesn't break it out (e.g. Brreg roll-ups).
  const vorraete      = uv.vorraete ?? null;
  const forderungen   = uv.forderungen ?? null;
  const wertpapiere   = uv.wertpapiere ?? null;
  const kassenbestand = uv.kassenbestand ?? null;
  const rueckstellung = p.rueckstellungen ?? null;
  const verbTotal     = vb.total ?? null;
  const verbLang      = vb.langfristig ?? 0;

  // Sum a set of sub-positions only if at least one is reported; else null.
  const sumIfAny = (...xs) => xs.some((x) => x != null)
    ? xs.reduce((s, x) => s + (x ?? 0), 0)
    : null;

  // Fremdkapital = alles außer Eigenkapital (inkl. Rückstellungen, RAP).
  const fremdkapital = (bilanzsumme != null && eigenkapital != null)
    ? bilanzsumme - eigenkapital
    : null;

  // Kurzfristiges Fremdkapital = kurzfristige Verbindlichkeiten (ohne
  // Rückstellungen). Rückstellungen gelten analytisch als langfristig
  // (WU‑Methodik) — sie fließen in `langfristKapital` ein, nicht hier.
  const kurzfristFK = (verbTotal != null) ? verbTotal - (verbLang || 0) : null;

  const liquiditaet1 = pct(sumIfAny(kassenbestand, wertpapiere), kurzfristFK);
  const liquiditaet2 = pct(sumIfAny(kassenbestand, wertpapiere, forderungen), kurzfristFK);
  const liquiditaet3 = pct(umlaufver, kurzfristFK);

  const workingCapital = (umlaufver != null && kurzfristFK != null)
    ? umlaufver - kurzfristFK
    : null;

  return {
    // Kapitalstruktur
    ekQuote:          pct(eigenkapital, bilanzsumme),
    fkQuote:          pct(fremdkapital, bilanzsumme),
    anlagenintensitaet: pct(anlagever, bilanzsumme),
    umlaufintensitaet:  pct(umlaufver, bilanzsumme),
    verschuldungsgrad:  pct(fremdkapital, eigenkapital), // FK / EK — matches 15.3% bei 86.7/13.3% EK/FK-Quote

    // Liquidität
    liquiditaet1Grad: liquiditaet1,
    liquiditaet2Grad: liquiditaet2,
    liquiditaet3Grad: liquiditaet3,
    workingCapital,

    // Kapitalrendite (nur wenn GuV-Ergebnis verfügbar)
    roe: pct(jahresergebnis, eigenkapital),
    roa: pct(jahresergebnis, bilanzsumme),
    // Anlagendeckungsgrad I = EK / Anlagevermögen (WU‑Methodik).
    anlagendeckungsgrad: pct(eigenkapital, anlagever),
    // Investiertes Kapital = Bilanzsumme − nicht‑betriebsnotw. Vermögen (Kasse)
    //   − unverzinsliches FK (Rückstellungen). Entspricht der WU‑Lesart.
    //   Sub-positions default to 0 if not reported so we still get a usable
    //   value for sources that only expose roll-ups (e.g. Norway/Brreg).
    investiertesKapital: (bilanzsumme != null)
      ? bilanzsumme - (kassenbestand ?? 0) - (rueckstellung ?? 0)
      : null,
  };
}
