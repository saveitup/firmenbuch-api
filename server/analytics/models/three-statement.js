// Three-statement model: income statement, balance sheet and cash-flow
// statement, linked and projected forward from the latest filing. Change one
// driver and all three statements move; the balance sheet balances by
// construction and `check` proves it year by year.
//
// Pure ES module without Node APIs. The browser imports this very file
// (served at /lib/models/) so the UI recalculates on every keystroke, and
// lbo.js / merger.js build on `projectThreeStatement`.
//
// Condensed balance sheet, mapped from the UGB tree of jab-parser.js:
//   cash              Kassenbestand + Wertpapiere (UV)
//   receivables       Forderungen − Konzernforderungen           → DSO
//   inventory         Vorräte                                    → DIO
//   fixedAssets       Immaterielle + Sachanlagen                 + Capex − AfA
//   financialAssets   Finanzanlagen                              flat
//   groupReceivables  Forderungen ggü. Verbundenen/Beteiligungen flat
//   goodwill          pro forma only (LBO / merger)              flat
//   otherAssets       Rest (aktive RAP, …)                       flat
//   payables          Verbindlichkeiten aus L&L                  → DPO
//   otherLiabilities  übrige operative Verbindlichkeiten         → % Umsatz
//   provisions        Rückstellungen                             → % Umsatz
//   groupLiabilities  Verbindlichkeiten ggü. Konzern/Gesellschaftern flat
//   otherPassiva      Rest (unversteuerte Rücklagen, passive RAP) flat
//   debt (tranches)   Anleihen + Bankverbindlichkeiten           Tilgungsplan
//   revolver          draws whenever cash would fall below the minimum
//   equity            + Jahresüberschuss − Ausschüttung
//
// Working-capital days are measured on revenue (DSO/DIO/DPO = Position /
// Umsatz × 365) because the Rohergebnis form hides the Materialaufwand.
// Interest runs on average balances; the circularity (interest → net income
// → cash → debt paydown → interest) is solved by fixed-point iteration
// instead of Excel's iterative-calculation switch.

export const TAX_RATES = {
  AT: 0.23, DE: 0.30, FR: 0.25, UK: 0.25, NL: 0.258, BE: 0.25, LU: 0.249,
  IT: 0.24, ES: 0.25, PT: 0.21, IE: 0.125, DK: 0.22, SE: 0.206, FI: 0.20,
  NO: 0.22, PL: 0.19, CZ: 0.21, CH: 0.15, EE: 0.22, LV: 0.20,
};

const z = (x) => (x == null || !Number.isFinite(x) ? 0 : x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, step) => Math.round(x / step) * step;
// A driver is either one value for every year or a per-year array.
const at = (v, i) => (Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v);

function monthsBetween(a, b) {
  const [ya, ma] = String(a).split('-').map(Number), [yb, mb] = String(b).split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** Income-statement lines of one financials row (GuV where filed, else scalars). */
export function incomeOf(row) {
  const g = row?.guv || {};
  let revenue = g.umsatzerloese ?? row?.umsatzerloese ?? null;
  let revenueBasis = 'umsatz';
  // Mittelgroße GmbHs may report the Rohergebnis instead of Umsatz … Material.
  if (revenue == null && g.rohergebnis != null) { revenue = g.rohergebnis; revenueBasis = 'rohergebnis'; }
  const da = g.abschreibungen != null ? Math.abs(g.abschreibungen) : null;
  const ebit = g.betriebserfolg ?? row?.betriebsergebnis ?? null;
  const ebitda = g.ebitda ?? (ebit != null && da != null ? ebit + da : null);
  const interestExpense = g.zinsaufwand != null ? Math.abs(g.zinsaufwand) : null;
  const netIncome = g.jahresueberschuss ?? g.ergebnisNachSteuern ?? row?.jahresergebnis ?? null;
  const ebt = g.ergebnisVorSteuern ?? null;
  const taxes = g.steuernEinkommen != null ? -g.steuernEinkommen
    : (ebt != null && netIncome != null ? ebt - netIncome : null);
  // Finanzerfolg without the interest expense: Beteiligungs-, Wertpapier- and
  // Zinserträge, net of write-downs on Finanzanlagen.
  const otherFinancial = g.finanzerfolg != null ? g.finanzerfolg + z(interestExpense) : null;
  return { revenue, revenueBasis, ebitda, da, ebit, interestExpense, otherFinancial, ebt, taxes, netIncome };
}

/** Condensed balance sheet of one financials row, or null without a Bilanzsumme. */
export function condenseBalance(row) {
  const bs = row?.balanceSheet;
  const total = bs?.aktiva?.total ?? bs?.passiva?.total ?? row?.bilanzsumme ?? null;
  if (total == null) return null;
  const equity = z(bs?.passiva?.eigenkapital?.total ?? row?.eigenkapital);
  const blank = {
    cash: 0, receivables: 0, inventory: 0, fixedAssets: 0, financialAssets: 0, groupReceivables: 0,
    goodwill: 0, otherAssets: 0, payables: 0, otherLiabilities: 0, provisions: 0, groupLiabilities: 0,
    otherPassiva: 0, debt: 0, revolver: 0, equity,
  };
  // Roll-up sources (UK iXBRL, FR, NO) carry no Gliederung: working capital
  // and debt stay unknown, everything sits in the flat rest positions.
  if (!bs) return { ...blank, otherAssets: total, otherPassiva: total - equity, simplified: true };

  const a = bs.aktiva || {}, p = bs.passiva || {};
  const av = a.anlagevermoegen || {}, uv = a.umlaufvermoegen || {}, vb = p.verbindlichkeiten || {};
  const cash = z(uv.kassenbestand) + z(uv.wertpapiere);
  const inventory = z(uv.vorraete);
  const groupReceivables = z(uv.forderungenVerbundene) + z(uv.forderungenBeteiligung);
  const forderungen = uv.forderungen ?? (uv.total != null ? uv.total - inventory - cash : 0);
  const receivables = Math.max(0, forderungen - groupReceivables);
  const fixedAssets = av.immaterielle != null || av.sachanlagen != null
    ? z(av.immaterielle) + z(av.sachanlagen)
    : Math.max(0, z(av.total) - z(av.finanzanlagen));
  const financialAssets = z(av.finanzanlagen);
  const debt = z(vb.anleihen) + z(vb.kreditinstitute);
  const groupLiabilities = z(vb.verbundene) + z(vb.beteiligung) + z(vb.gesellschafter);
  const payables = z(vb.lieferungenLeistungen);
  const otherLiabilities = Math.max(0, z(vb.total) - debt - groupLiabilities - payables);
  const provisions = z(p.rueckstellungen);
  return {
    ...blank,
    cash, receivables, inventory, fixedAssets, financialAssets, groupReceivables,
    otherAssets: total - cash - receivables - inventory - fixedAssets - financialAssets - groupReceivables,
    payables, otherLiabilities, provisions, groupLiabilities, debt,
    otherPassiva: total - payables - otherLiabilities - provisions - groupLiabilities - debt - equity,
  };
}

export function balanceTotals(bs) {
  const totalAssets = bs.cash + bs.receivables + bs.inventory + bs.fixedAssets + bs.financialAssets
    + bs.groupReceivables + bs.goodwill + bs.otherAssets;
  const totalLiabilities = bs.payables + bs.otherLiabilities + bs.provisions + bs.groupLiabilities
    + bs.otherPassiva + bs.debt + bs.revolver;
  return { totalAssets, totalLiabilities, totalLiabEquity: totalLiabilities + bs.equity };
}

/**
 * Historical base of the model: the latest year with revenue and a balance
 * sheet, plus the year before it for calibrating the default drivers.
 * Returns `{ error }` when the filings don't carry enough to model.
 */
export function buildBase(financials, { country = null } = {}) {
  const rows = (financials || []).filter((r) => incomeOf(r).revenue > 0 && condenseBalance(r));
  if (!rows.length) return { error: 'Für ein Modell fehlen Umsatz und Bilanz in den Jahresabschlüssen.' };
  const latest = rows[rows.length - 1];
  const priorRow = rows.length > 1 ? rows[rows.length - 2] : null;
  const year = (row) => Number(String(row.stichtag).slice(0, 4));
  const pack = (row) => ({ stichtag: row.stichtag, year: year(row), is: incomeOf(row), bs: condenseBalance(row) });

  const base = { country, currency: latest.currency || 'EUR', ...pack(latest), warnings: [] };
  if (priorRow) {
    const months = monthsBetween(priorRow.stichtag, latest.stichtag);
    const prior = pack(priorRow);
    // Revenue moving by more than 5× is a unit mix-up or a Umgründung, not
    // a trend — calibrating growth or capex on it would mislead.
    const ratio = base.is.revenue / prior.is.revenue;
    if (ratio > 5 || ratio < 0.2) base.warnings.push(`Vorjahr ${prior.year} nicht vergleichbar (Umsatz ändert sich um mehr als Faktor 5) — Standardannahmen ohne Vorjahr.`);
    else if (months >= 9 && months <= 15) base.prior = prior;
  }
  base.simplified = !!base.bs.simplified;
  if (base.simplified) base.warnings.push('Keine Bilanzgliederung verfügbar: Working Capital und Finanzschulden werden nicht modelliert.');
  if (base.is.revenueBasis === 'rohergebnis') base.warnings.push('Umsatz nicht ausgewiesen: Modell läuft auf dem Rohergebnis.');
  if (base.is.ebitda == null) base.warnings.push('EBITDA nicht ausgewiesen: Marge aus Ergebnis geschätzt.');
  return base;
}

/** Default drivers calibrated on the base year (and the prior year where filed). */
export function defaultAssumptions(base) {
  const { is, bs, prior } = base;
  const rev = is.revenue;
  const share = (x) => (rev > 0 && x != null ? x / rev : null);
  const days = (x) => (rev > 0 ? round((z(x) / rev) * 365, 1) : 0);
  const taxRate = TAX_RATES[base.country] ?? 0.25;

  const daPct = share(is.da) ?? 0.03;
  const ebitdaMargin = share(is.ebitda)
    ?? (is.ebit != null ? share(is.ebit) + daPct
      : is.netIncome != null ? share(is.netIncome) / (1 - taxRate) + daPct : 0.08);
  const histGrowth = prior?.is.revenue > 0 ? rev / prior.is.revenue - 1 : null;

  // Capex: midpoint of last year's investment and AfA — one year of capex is
  // noisy (a new plant would otherwise repeat for five years).
  let capexPct = daPct;
  if (prior && !base.simplified) {
    const capex = bs.fixedAssets - prior.bs.fixedAssets + z(is.da);
    if (capex >= 0) capexPct = clamp((capex / rev + daPct) / 2, 0, 0.25);
  }

  // Zinsaufwand also covers group and shareholder loans, so the implied rate
  // on bank debt overshoots for group companies — hence the tight band.
  const avgDebt = prior ? (bs.debt + prior.bs.debt) / 2 : bs.debt;
  const interestRate = avgDebt > rev * 0.01 && is.interestExpense != null
    ? clamp(is.interestExpense / avgDebt, 0.015, 0.09) : 0.05;

  // Ausschüttung implied by the equity roll-forward: EK(t−1) + JÜ − EK(t).
  let payoutRatio = 0.3;
  if (prior && is.netIncome > 0) {
    payoutRatio = clamp((prior.bs.equity + is.netIncome - bs.equity) / is.netIncome, 0, 1);
  }

  return {
    years: 5,
    revenueGrowth: round(clamp(histGrowth ?? 0.03, -0.05, 0.10), 0.005),
    ebitdaMargin: round(ebitdaMargin, 0.001),
    daPct: round(daPct, 0.001),
    capexPct: round(capexPct, 0.001),
    dso: days(bs.receivables),
    dio: days(bs.inventory),
    dpo: days(bs.payables),
    otherLiabPct: round(share(bs.otherLiabilities) ?? 0, 0.001),
    provisionsPct: round(share(bs.provisions) ?? 0, 0.001),
    taxRate,
    interestRate: round(interestRate, 0.0025),
    cashRate: 0.01,
    payoutRatio: round(payoutRatio, 0.05),
    debtAmortPct: 0.10,
    minCashPct: 0.02,
  };
}

/**
 * Project the three statements.
 *
 * @param base  from buildBase
 * @param a     drivers (defaultAssumptions shape; each may be a per-year array)
 * @param opts  overrides the LBO / merger models use:
 *   opening      condensed opening balance sheet (default: base year)
 *   tranches     [{ key, label, amount, rate, amortPct, sweep, pik }] — amortPct
 *                is a share of the original principal per year
 *   payoutRatio  share of positive net income distributed
 *   sweepPct     share of cash above the minimum used to prepay sweep tranches
 *   years        projection horizon (1–10)
 */
export function projectThreeStatement(base, a, opts = {}) {
  const n = Math.max(1, Math.min(10, Math.round(opts.years ?? a.years ?? 5)));
  const opening = { ...(opts.opening || base.bs) };
  const tranches = (opts.tranches || [{
    key: 'debt', label: 'Finanzschulden', amount: opening.debt,
    rate: a.interestRate, amortPct: a.debtAmortPct, sweep: false, pik: false,
  }]).map((t) => ({ ...t, original: t.amount }));
  const payout = opts.payoutRatio ?? a.payoutRatio;
  const sweepPct = opts.sweepPct ?? 0;
  const revolverRate = a.interestRate + 0.01;
  // Recurring financial income is held flat; a negative base (write-downs on
  // Finanzanlagen) is treated as a one-off.
  const otherFinancial = Math.max(0, z(base.is.otherFinancial));

  let prevRevenue = base.is.revenue;
  let prev = { ...opening, tranche: Object.fromEntries(tranches.map((t) => [t.key, t.amount])) };
  const years = [];

  for (let i = 0; i < n; i++) {
    const revenue = prevRevenue * (1 + at(a.revenueGrowth, i));
    const ebitda = revenue * at(a.ebitdaMargin, i);
    const da = revenue * at(a.daPct, i);
    const ebit = ebitda - da;
    const capex = revenue * at(a.capexPct, i);
    const receivables = (revenue * at(a.dso, i)) / 365;
    const inventory = (revenue * at(a.dio, i)) / 365;
    const payables = (revenue * at(a.dpo, i)) / 365;
    const otherLiabilities = revenue * at(a.otherLiabPct, i);
    const provisions = revenue * at(a.provisionsPct, i);
    const fixedAssets = prev.fixedAssets + capex - da;
    const nwc = receivables + inventory - payables - otherLiabilities;
    const prevNwc = prev.receivables + prev.inventory - prev.payables - prev.otherLiabilities;
    const deltaNwc = nwc - prevNwc;
    const deltaProvisions = provisions - prev.provisions;
    const minCash = revenue * at(a.minCashPct, i);
    const taxRate = at(a.taxRate, i);

    // One pass of the financing waterfall given an estimate of the closing
    // balances (null → interest on opening balances).
    const financeYear = (est) => {
      const avg = (open, close) => (est ? (open + close) / 2 : open);
      const debtRows = tranches.map((t) => ({
        t, open: prev.tranche[t.key],
        interest: t.rate * avg(prev.tranche[t.key], est ? est.tranche[t.key] : 0),
      }));
      const pik = debtRows.reduce((s, d) => s + (d.t.pik ? d.interest : 0), 0);
      const revolverInterest = revolverRate * avg(prev.revolver, est ? est.revolver : 0);
      const interestExpense = debtRows.reduce((s, d) => s + d.interest, 0) + revolverInterest;
      const interestIncome = at(a.cashRate, i) * Math.max(0, avg(prev.cash, est ? est.cash : 0));
      const ebt = ebit + otherFinancial + interestIncome - interestExpense;
      const taxes = Math.max(0, ebt) * taxRate;
      const netIncome = ebt - taxes;
      const dividends = payout * Math.max(0, netIncome);
      const cfo = netIncome + da + pik + deltaProvisions - deltaNwc;
      const cfi = -capex;

      let cash = prev.cash + cfo + cfi - dividends;
      for (const d of debtRows) {
        d.balance = d.open + (d.t.pik ? d.interest : 0);
        d.mandatory = Math.min(d.balance, d.t.amortPct * d.t.original);
        d.balance -= d.mandatory;
        cash -= d.mandatory;
      }
      let draw = 0, repay = 0;
      if (cash < minCash) draw = minCash - cash;
      else repay = Math.min(prev.revolver, cash - minCash);
      cash += draw - repay;
      let excess = Math.max(0, cash - minCash) * sweepPct;
      for (const d of debtRows) {
        d.sweep = d.t.sweep ? Math.min(d.balance, excess) : 0;
        d.balance -= d.sweep;
        excess -= d.sweep;
        cash -= d.sweep;
      }
      const repayment = debtRows.reduce((s, d) => s + d.mandatory + d.sweep, 0);
      return {
        debtRows, pik, revolverInterest, interestExpense, interestIncome, ebt, taxes, netIncome, dividends,
        cfo, cfi, draw, repay, repayment, cash,
        revolver: prev.revolver + draw - repay,
        tranche: Object.fromEntries(debtRows.map((d) => [d.t.key, d.balance])),
      };
    };

    let y = financeYear(null);
    for (let iter = 0; iter < 50; iter++) {
      const next = financeYear(y);
      const converged = Math.abs(next.interestExpense - y.interestExpense) < 1e-6 * revenue + 1e-6
        && Math.abs(next.interestIncome - y.interestIncome) < 1e-6 * revenue + 1e-6;
      y = next;
      if (converged) break;
    }

    const debt = Object.values(y.tranche).reduce((s, v) => s + v, 0);
    const bs = {
      cash: y.cash, receivables, inventory, fixedAssets,
      financialAssets: prev.financialAssets, groupReceivables: prev.groupReceivables,
      goodwill: prev.goodwill, otherAssets: prev.otherAssets,
      payables, otherLiabilities, provisions,
      groupLiabilities: prev.groupLiabilities, otherPassiva: prev.otherPassiva,
      debt, revolver: y.revolver, tranche: y.tranche,
      equity: prev.equity + y.netIncome - y.dividends,
    };
    const totals = balanceTotals(bs);
    const cff = -y.dividends - y.repayment + y.draw - y.repay;
    years.push({
      label: `${base.year + i + 1}E`,
      year: base.year + i + 1,
      actual: false,
      is: {
        revenue, growth: revenue / prevRevenue - 1, ebitda, ebitdaMargin: ebitda / revenue, da, ebit,
        interestExpense: y.interestExpense, interestIncome: y.interestIncome, otherFinancial,
        ebt: y.ebt, taxes: y.taxes, netIncome: y.netIncome,
      },
      cf: {
        netIncome: y.netIncome, da, pik: y.pik, deltaProvisions, deltaNwc: -deltaNwc, cfo: y.cfo,
        capex: -capex, cfi: y.cfi,
        dividends: -y.dividends, debtRepayment: -y.repayment, revolverNet: y.draw - y.repay, cff,
        netChange: y.cfo + y.cfi + cff,
        fcf: y.cfo + y.cfi,
      },
      bs: { ...bs, ...totals },
      debt: {
        tranches: y.debtRows.map((d) => ({
          key: d.t.key, label: d.t.label, open: d.open, interest: d.interest, pik: d.t.pik ? d.interest : 0,
          mandatory: d.mandatory, sweep: d.sweep, close: d.balance,
        })),
        revolver: { open: prev.revolver, draw: y.draw, repay: y.repay, close: y.revolver, interest: y.revolverInterest },
        cashInterest: y.interestExpense - y.pik,
      },
      minCash,
      check: totals.totalAssets - totals.totalLiabEquity,
    });
    prevRevenue = revenue;
    prev = bs;
  }

  const actual = (p, label) => p && {
    label, year: p.year, actual: true,
    is: { ...p.is, ebitdaMargin: p.is.ebitda != null ? p.is.ebitda / p.is.revenue : null },
    bs: { ...p.bs, ...balanceTotals(p.bs) },
  };
  const actuals = [actual(base.prior, `${base.prior?.year}A`), actual(base, `${base.year}A`)].filter(Boolean);
  if (actuals.length === 2) actuals[1].is.growth = base.is.revenue / base.prior.is.revenue - 1;
  const openingTotals = balanceTotals(opening);
  const tolerance = Math.max(1, Math.abs(openingTotals.totalAssets) * 1e-9);
  return {
    years,
    actuals,
    opening: { ...opening, ...openingTotals },
    balanced: years.every((y) => Math.abs(y.check) <= tolerance),
    maxCheck: years.reduce((m, y) => Math.max(m, Math.abs(y.check)), 0),
  };
}
