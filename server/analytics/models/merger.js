// Merger model: does buying the target raise or lower the acquirer's earnings
// per share? Both companies are projected standalone with the three-statement
// model; the deal adjustments sit on top:
//
//   Kaufpreis:   EV = EBITDA_Ziel(LTM) × Angebots-Multiple; EK-Kaufpreis = EV − Net Debt
//   Finanzierung: Anteile Kasse / neue Aktien / neue Schulden am EK-Kaufpreis;
//                Transaktionskosten aus der Kasse, bei Closing als Aufwand
//   Kaufpreisallokation: Überschuss über Buch-EK → aufgedeckte stille Reserven
//                (Abschreibung über n Jahre) + latente Steuern + Goodwill
//   Pro-forma-Ergebnis = JÜ_Käufer + JÜ_Ziel + (Synergien − Integrationskosten
//                − entgangene Zinsen auf Kasse − Zinsen neue Schulden
//                − Abschreibung stille Reserven) × (1 − Steuersatz)
//   EPS = Ergebnis / Anteile; neue Anteile = Aktienkomponente / Kurs des Käufers
//
// Private companies have no share price: the acquirer's equity is valued at a
// P/E multiple and the share count is normalised. Accretion/dilution depends
// only on that equity value, not on the absolute share count.
// Acquisition debt is interest-only over the horizon, target debt is assumed.
import { projectThreeStatement } from './three-statement.js';

const z = (x) => (x == null || !Number.isFinite(x) ? 0 : x);

export function defaultMergerAssumptions(acq, tgt) {
  const ebitda = tgt.base.is.ebitda ?? 0;
  const offerMultiple = 7.0;
  const equityPrice = ebitda * offerMultiple - (tgt.base.bs.debt - tgt.base.bs.cash);
  // Pay cash as far as the acquirer holds cash above its minimum, the rest in debt.
  const cashAvailable = acq.base.bs.cash - acq.base.is.revenue * acq.assumptions.minCashPct;
  const pctCash = equityPrice > 0
    ? Math.floor(Math.min(1, Math.max(0, cashAvailable / (equityPrice * 1.02))) * 20) / 20 : 0;
  return {
    offerMultiple,
    pctCash,
    pctStock: 0,
    pctDebt: Math.round((1 - pctCash) * 100) / 100,
    acquirerPe: 12,
    acquirerShares: 1_000_000,
    costOfDebt: 0.06,
    interestOnCash: 0.02,
    synergiesPct: 0.02,
    phaseIn: [0.5, 1, 1],
    integrationCostPct: 1.0,
    feesPct: 0.02,
    writeUpPct: 0.25,
    writeUpYears: 10,
    years: 3,
  };
}

/**
 * @param acq  { base, assumptions } of the acquirer (three-statement)
 * @param tgt  { base, assumptions } of the target
 * @param m    merger assumptions (defaultMergerAssumptions shape)
 */
export function runMerger(acq, tgt, m, { sensitivity = true } = {}) {
  const tgtEbitda = tgt.base.is.ebitda;
  if (!(tgtEbitda > 0)) return { error: 'EBITDA des Zielunternehmens ist nicht positiv — Kaufpreis über Multiple nicht ableitbar.' };
  const n = Math.max(1, Math.min(5, Math.round(m.years)));
  const acqModel = projectThreeStatement(acq.base, acq.assumptions, { years: n });
  const tgtModel = projectThreeStatement(tgt.base, tgt.assumptions, { years: n });
  const taxRate = acq.assumptions.taxRate;
  const A = acq.base.bs, T = tgt.base.bs;

  // Purchase price and how it is paid.
  const ev = tgtEbitda * m.offerMultiple;
  const tgtNetDebt = T.debt - T.cash;
  const equityPrice = ev - tgtNetDebt;
  const fees = ev * m.feesPct;
  const mixTotal = m.pctCash + m.pctStock + m.pctDebt;
  const mix = mixTotal > 0
    ? { cash: m.pctCash / mixTotal, stock: m.pctStock / mixTotal, debt: m.pctDebt / mixTotal }
    : { cash: 0, stock: 0, debt: 1 };
  const cashUsed = equityPrice * mix.cash;
  const stockIssued = equityPrice * mix.stock;
  const newDebt = equityPrice * mix.debt;

  const acqNi0 = acq.base.is.netIncome;
  const equityValue = acqNi0 > 0 ? acqNi0 * m.acquirerPe : null;
  const shares = m.acquirerShares;
  const sharePrice = equityValue != null ? equityValue / shares : null;
  const newShares = sharePrice > 0 ? stockIssued / sharePrice : 0;
  const pfShares = shares + newShares;

  // Purchase price allocation. Write-ups are book-only in a share deal and
  // create a deferred tax liability; goodwill is the remainder.
  const excess = equityPrice - T.equity;
  const writeUp = Math.max(0, excess) * m.writeUpPct;
  const dtl = writeUp * taxRate;
  const goodwill = excess - writeUp + dtl;
  const writeUpAmort = m.writeUpYears > 0 ? writeUp / m.writeUpYears : 0;

  const years = acqModel.years.map((ay, i) => {
    const ty = tgtModel.years[i];
    const runRate = ty.is.revenue * m.synergiesPct;
    const synergies = runRate * (m.phaseIn[Math.min(i, m.phaseIn.length - 1)] ?? 1);
    const integrationCosts = i === 0 ? runRate * m.integrationCostPct : 0;
    const foregoneInterest = (cashUsed + fees) * m.interestOnCash;
    const debtInterest = newDebt * m.costOfDebt;
    const pretaxAdj = synergies - integrationCosts - foregoneInterest - debtInterest - writeUpAmort;
    const pfNetIncome = ay.is.netIncome + ty.is.netIncome + pretaxAdj * (1 - taxRate);
    const eps = ay.is.netIncome / shares;
    const pfEps = pfNetIncome / pfShares;
    // Pre-tax synergies at which pro-forma EPS equals standalone EPS.
    const breakEvenSynergies = (eps * pfShares - (ay.is.netIncome + ty.is.netIncome)) / (1 - taxRate)
      + integrationCosts + foregoneInterest + debtInterest + writeUpAmort;
    return {
      label: ay.label,
      acqNetIncome: ay.is.netIncome, tgtNetIncome: ty.is.netIncome,
      synergies, integrationCosts: -integrationCosts, foregoneInterest: -foregoneInterest,
      debtInterest: -debtInterest, writeUpAmort: -writeUpAmort,
      taxOnAdjustments: -pretaxAdj * taxRate,
      pfNetIncome, shares, pfShares, eps, pfEps,
      accretion: eps > 0 ? pfEps / eps - 1 : null,
      accretionAbs: pfEps - eps,
      breakEvenSynergies: Math.max(0, breakEvenSynergies),
      pfEbitda: ay.is.ebitda + ty.is.ebitda + synergies,
      acqRevenue: ay.is.revenue, tgtRevenue: ty.is.revenue, acqEbitda: ay.is.ebitda, tgtEbitda: ty.is.ebitda,
    };
  });

  // Combined balance sheet at closing (base-year balances).
  const line = (label, key, adj = 0, cls) => ({ label, acq: z(A[key]), tgt: z(T[key]), adj, cls });
  const sumRows = (rows) => rows.reduce((s, r) => ({ acq: s.acq + r.acq, tgt: s.tgt + r.tgt, adj: s.adj + r.adj }), { acq: 0, tgt: 0, adj: 0 });
  const assets = [
    line('Kasse & Wertpapiere', 'cash', -(cashUsed + fees)),
    { label: 'Forderungen & Vorräte', acq: A.receivables + A.inventory, tgt: T.receivables + T.inventory, adj: 0 },
    { label: 'Anlagevermögen', acq: A.fixedAssets + A.financialAssets, tgt: T.fixedAssets + T.financialAssets, adj: 0 },
    { label: 'Aufgedeckte stille Reserven', acq: 0, tgt: 0, adj: writeUp },
    line('Goodwill', 'goodwill', goodwill),
    { label: 'Sonstige Aktiva', acq: A.groupReceivables + A.otherAssets, tgt: T.groupReceivables + T.otherAssets, adj: 0 },
  ];
  const liabilities = [
    { label: 'Finanzschulden', acq: A.debt + A.revolver, tgt: T.debt + T.revolver, adj: 0 },
    { label: 'Akquisitionsfinanzierung', acq: 0, tgt: 0, adj: newDebt },
    { label: 'Operative Verbindlichkeiten & Rückstellungen', acq: A.payables + A.otherLiabilities + A.provisions, tgt: T.payables + T.otherLiabilities + T.provisions, adj: 0 },
    { label: 'Latente Steuern (PPA)', acq: 0, tgt: 0, adj: dtl },
    { label: 'Sonstige Passiva', acq: A.groupLiabilities + A.otherPassiva, tgt: T.groupLiabilities + T.otherPassiva, adj: 0 },
    // Target equity is eliminated; new shares and the expensed fees hit the acquirer's equity.
    line('Eigenkapital', 'equity', stockIssued - fees - T.equity),
  ];
  const withPf = (r) => ({ ...r, pf: r.acq + r.tgt + r.adj });
  const totalAssets = withPf({ label: 'Summe Aktiva', ...sumRows(assets), cls: 'total' });
  const totalLiab = withPf({ label: 'Summe Passiva', ...sumRows(liabilities), cls: 'total' });
  const pfCash = A.cash + T.cash - cashUsed - fees;
  const pfDebt = A.debt + A.revolver + T.debt + T.revolver + newDebt;

  const y1 = years[0];
  const result = {
    price: { ev, tgtEbitda, tgtNetDebt, equityPrice, fees, offerMultiple: m.offerMultiple, impliedPe: tgt.base.is.netIncome > 0 ? equityPrice / tgt.base.is.netIncome : null },
    financing: { mix, cashUsed, stockIssued, newDebt, sharePrice, equityValue, newShares, pfShares },
    ppa: { equityPrice, bookEquity: T.equity, excess, writeUp, dtl, goodwill, writeUpAmort },
    years,
    closing: {
      rows: [...assets.map(withPf), totalAssets, ...liabilities.map(withPf), totalLiab],
      check: totalAssets.pf - totalLiab.pf,
    },
    credit: {
      pfNetDebt: pfDebt - pfCash,
      pfNetDebtEbitda: y1.pfEbitda > 0 ? (pfDebt - pfCash) / y1.pfEbitda : null,
      acqNetDebtEbitda: acq.base.is.ebitda > 0 ? (A.debt + A.revolver - A.cash) / acq.base.is.ebitda : null,
    },
    contribution: [
      { label: 'Umsatz', acq: y1.acqRevenue, tgt: y1.tgtRevenue },
      { label: 'EBITDA', acq: y1.acqEbitda, tgt: y1.tgtEbitda },
      { label: 'Jahresüberschuss', acq: y1.acqNetIncome, tgt: y1.tgtNetIncome },
      { label: 'Anteile pro forma', acq: shares, tgt: newShares },
    ],
    warnings: [],
  };
  if (pfCash < 0) result.warnings.push('Die Barkomponente übersteigt die Kasse beider Unternehmen — mehr Schulden oder Aktien nötig.');
  if (!(acqNi0 > 0)) result.warnings.push('Käufer ohne positiven Jahresüberschuss: kein Aktienkurs über KGV ableitbar, EPS-Effekt nicht aussagekräftig.');
  if (equityPrice <= 0) result.warnings.push('Net Debt des Ziels übersteigt den Unternehmenswert — EK-Kaufpreis nicht positiv.');
  if (Math.abs(mixTotal - 1) > 0.005) result.warnings.push('Finanzierungsmix ergibt nicht 100 % — Anteile wurden normiert.');

  if (sensitivity) {
    const multiples = [-2, -1, 0, 1, 2].map((d) => m.offerMultiple + d).filter((x) => x > 0);
    const stockShares = [0, 0.25, 0.5, 0.75, 1];
    const rest = mix.cash + mix.debt;
    result.sensitivity = {
      rows: multiples,
      cols: stockShares,
      accretion: multiples.map((om) => stockShares.map((s) => {
        const cashShare = rest > 0 ? (1 - s) * (mix.cash / rest) : 0;
        const r = runMerger(acq, tgt, { ...m, offerMultiple: om, pctStock: s, pctCash: cashShare, pctDebt: 1 - s - cashShare }, { sensitivity: false });
        return r.error ? null : r.years[0].accretion;
      })),
    };
  }
  return result;
}
