// LBO model: a financial sponsor buys the company mostly with debt, pays the
// debt down with the company's cash flow and sells at the end of the holding
// period. Built on the three-statement model — the operating case (growth,
// margins, working capital, capex) is the one the user set there.
//
//   Entry:  EV = EBITDA(LTM) × Entry-Multiple, cash-free / debt-free
//           Sources: Senior + Mezzanine + übernommene Kasse + Sponsor-EK
//           Uses:    Kaufpreis EK + Ablöse Finanzschulden + Kosten + Mindestkasse
//   Pro-forma-Eröffnungsbilanz: alte Kasse und Finanzschulden raus, neue
//           Tranchen und Mindestkasse rein, Goodwill = EV − (Buch-EK + Net Debt),
//           Transaktionskosten mindern das Eigenkapital.
//   Hold:   no distributions; Senior amortises and takes the cash sweep,
//           Mezzanine is bullet with optional PIK interest.
//   Exit:   EV = EBITDA(exit year) × Exit-Multiple − Net Debt → Sponsor-EK
//           IRR and MOIC on the sponsor cash flows.
//
// Group balances (Konzernforderungen / -verbindlichkeiten) stay on the balance
// sheet; only bank debt and bonds count as refinanced net debt.
import { projectThreeStatement } from './three-statement.js';

export function defaultLboAssumptions() {
  // Mandate frame of plans/investor-screening.md: EV 4–7x, acquisition debt 2–3x.
  return {
    entryMultiple: 6.0,
    exitMultiple: 6.0,
    holdYears: 5,
    feesPct: 0.03,
    seniorMultiple: 2.5,
    seniorRate: 0.065,
    seniorAmortPct: 0.10,
    mezzMultiple: 0.5,
    mezzRate: 0.11,
    mezzPik: true,
    sweepPct: 1.0,
  };
}

/** IRR of yearly cash flows (index = year), by bisection. Null without a sign change. */
export function irr(flows) {
  const npv = (r) => flows.reduce((s, cf, t) => s + cf / (1 + r) ** t, 0);
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * @param base  from buildBase
 * @param ts    three-statement drivers (operating case)
 * @param l     LBO assumptions (defaultLboAssumptions shape)
 * @param opts  { sensitivity: false } skips the IRR grid (used inside it)
 */
export function runLbo(base, ts, l, { sensitivity = true } = {}) {
  const ebitda = base.is.ebitda ?? base.is.revenue * ts.ebitdaMargin;
  if (!(ebitda > 0)) return { error: 'EBITDA ist nicht positiv — ein LBO lässt sich nicht über Schulden finanzieren.' };
  const bs = base.bs;
  const ev = ebitda * l.entryMultiple;
  const netDebt = bs.debt - bs.cash;
  const equityPrice = ev - netDebt;
  const fees = ev * l.feesPct;
  const minCash = base.is.revenue * ts.minCashPct;
  const senior = ebitda * l.seniorMultiple;
  const mezz = ebitda * l.mezzMultiple;
  const sponsorEquity = ev + fees + minCash - senior - mezz;

  const sources = [
    { label: 'Senior-Darlehen', amount: senior, multiple: l.seniorMultiple },
    { label: 'Mezzanine', amount: mezz, multiple: l.mezzMultiple },
    { label: 'Übernommene Kasse', amount: bs.cash },
    { label: 'Sponsor-Eigenkapital', amount: sponsorEquity, multiple: sponsorEquity / ebitda },
  ];
  const uses = [
    { label: 'Kaufpreis Eigenkapital', amount: equityPrice },
    { label: 'Ablöse Finanzschulden', amount: bs.debt },
    { label: 'Transaktionskosten', amount: fees },
    { label: 'Mindestkasse', amount: minCash },
  ];
  const total = sources.reduce((s, x) => s + x.amount, 0);

  const goodwill = ev - (bs.equity + netDebt);
  const opening = {
    ...bs, cash: minCash, debt: senior + mezz, revolver: 0,
    goodwill: bs.goodwill + goodwill, equity: sponsorEquity - fees,
  };
  const tranches = [
    { key: 'senior', label: 'Senior-Darlehen', amount: senior, rate: l.seniorRate, amortPct: l.seniorAmortPct, sweep: true, pik: false },
    { key: 'mezz', label: 'Mezzanine', amount: mezz, rate: l.mezzRate, amortPct: 0, sweep: false, pik: !!l.mezzPik },
  ];
  const model = projectThreeStatement(base, ts, {
    opening, tranches, payoutRatio: 0, sweepPct: l.sweepPct, years: l.holdYears,
  });

  const n = model.years.length;
  const exitYear = model.years[n - 1];
  const exitEbitda = exitYear.is.ebitda;
  const exitEv = exitEbitda * l.exitMultiple;
  const exitNetDebt = exitYear.bs.debt + exitYear.bs.revolver - exitYear.bs.cash;
  const exitEquity = exitEv - exitNetDebt;
  const flows = [-sponsorEquity, ...Array(n - 1).fill(0), Math.max(0, exitEquity)];
  const moic = sponsorEquity > 0 ? Math.max(0, exitEquity) / sponsorEquity : null;
  const result = {
    entry: { ebitda, ev, netDebt, equityPrice, fees, minCash, goodwill, sponsorEquity, leverage: (senior + mezz) / ebitda },
    sources, uses, total,
    model,
    credit: model.years.map((y) => {
      const totalDebt = y.bs.debt + y.bs.revolver;
      return {
        label: y.label,
        totalDebt,
        netDebtEbitda: (totalDebt - y.bs.cash) / y.is.ebitda,
        interestCoverage: y.debt.cashInterest > 0 ? y.is.ebitda / y.debt.cashInterest : null,
        paidDown: senior + mezz > 0 ? 1 - totalDebt / (senior + mezz) : null,
      };
    }),
    exit: { year: exitYear.label, ebitda: exitEbitda, ev: exitEv, netDebt: exitNetDebt, equity: exitEquity },
    // Limited liability: a wiped-out sponsor loses its equity, nothing more.
    returns: { irr: sponsorEquity > 0 ? (exitEquity > 0 ? irr(flows) : -1) : null, moic, flows },
    // Bridge entry equity → exit equity; the four parts add up exactly.
    valueCreation: [
      { label: 'EBITDA-Wachstum', amount: (exitEbitda - ebitda) * l.entryMultiple },
      { label: 'Multiple-Veränderung', amount: (l.exitMultiple - l.entryMultiple) * exitEbitda },
      { label: 'Entschuldung', amount: senior + mezz - minCash - exitNetDebt },
      { label: 'Transaktionskosten', amount: -fees },
    ],
    warnings: [],
  };
  if (sponsorEquity <= 0) result.warnings.push('Die Fremdfinanzierung übersteigt den Kapitalbedarf — kein Sponsor-Eigenkapital nötig.');
  if (goodwill < 0) result.warnings.push('Kaufpreis unter Buchwert: negativer Goodwill (Badwill).');
  if (exitEquity <= 0) result.warnings.push('Eigenkapital beim Exit aufgezehrt — Totalverlust für den Sponsor.');
  if (model.years.some((y) => y.bs.revolver > 0)) result.warnings.push('Der Cashflow deckt den Schuldendienst nicht: Revolver wird gezogen.');

  if (sensitivity) {
    const steps = [-1, -0.5, 0, 0.5, 1];
    const entries = steps.map((d) => l.entryMultiple + d).filter((m) => m > 0);
    const exits = steps.map((d) => l.exitMultiple + d).filter((m) => m > 0);
    result.sensitivity = {
      rows: entries,
      cols: exits,
      irr: entries.map((em) => exits.map((xm) => {
        const r = runLbo(base, ts, { ...l, entryMultiple: em, exitMultiple: xm }, { sensitivity: false });
        return r.error ? null : r.returns.irr;
      })),
    };
  }
  return result;
}
