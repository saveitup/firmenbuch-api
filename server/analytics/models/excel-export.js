// Excel export of the three models with live formulas. Every model line is a
// formula, so a changed input in Excel moves the linked statements exactly as
// in the web view. Each formula cell also carries the engine's result as its
// cached value: previews without a calc engine (iOS, Quick Look) show the
// numbers, and a recalculation in Excel must reproduce them.
//
//   Annahmen        operative drivers (this company, counterparty), switches,
//                   summary of all checks
//   3-Statement     GuV, Bilanz, Kapitalflussrechnung, Tilgungsplan
//   LBO             LBO inputs, Sources & Uses, pro-forma 3-Statement with
//                   tranches, returns, value-creation bridge, IRR data table
//   3-Statement …   counterparty of the merger (Ziel or Käufer)
//   Merger          inputs, price, PPA, EPS accretion/dilution, closing
//                   balance sheet, contribution, EPS data table
//
// Structure is fixed at export (horizons, tranches, columns): to change it,
// adjust in the web view and export again. Interest on average balances is
// circular; the workbook enables iterative calculation and Annahmen has a
// circuit breaker (1 = Durchschnitt, 0 = Anfangsbestand). Every average-
// balance term falls back to the opening balance while the closing balance is
// an error, so an error can't lock itself into the loop.
import { Workbook, cellRef, sheetRef } from './xlsx-writer.js';
import { projectThreeStatement } from './three-statement.js';
import { runLbo } from './lbo.js';
import { runMerger } from './merger.js';

const COLOR = { input: '0000FF', link: '008000', inputFill: 'FFF2CC', histFill: 'F3F4F6', headFill: 'E5E7EB', muted: '6B7280', title: '111827', ok: '00804D' };
const SHEET_INPUTS = 'Annahmen';
const SHEET_TS = '3-Statement';

// [row key, assumption field, label, number kind]
const DRIVERS = [
  ['d_g', 'revenueGrowth', 'Umsatzwachstum', 'pct'],
  ['d_m', 'ebitdaMargin', 'EBITDA-Marge', 'pct'],
  ['d_da', 'daPct', 'Abschreibungen (% Umsatz)', 'pct'],
  ['d_capex', 'capexPct', 'Capex (% Umsatz)', 'pct'],
  ['d_dso', 'dso', 'Forderungen (Tage Umsatz)', 'days'],
  ['d_dio', 'dio', 'Vorräte (Tage Umsatz)', 'days'],
  ['d_dpo', 'dpo', 'Verbindlichkeiten L&L (Tage Umsatz)', 'days'],
  ['d_oth', 'otherLiabPct', 'Sonstige Verbindlichkeiten (% Umsatz)', 'pct'],
  ['d_prov', 'provisionsPct', 'Rückstellungen (% Umsatz)', 'pct'],
  ['d_tax', 'taxRate', 'Steuersatz', 'pct'],
  ['d_ir', 'interestRate', 'Zins Finanzschulden', 'pct'],
  ['d_cr', 'cashRate', 'Zins auf Kasse', 'pct'],
  ['d_payout', 'payoutRatio', 'Ausschüttungsquote', 'pct'],
  ['d_amort', 'debtAmortPct', 'Tilgung p. a. (% Anfangsbestand)', 'pct'],
  ['d_min', 'minCashPct', 'Mindestkasse (% Umsatz)', 'pct'],
];
// The LBO block takes its own tranches and pays no dividends.
const LBO_DRIVERS = DRIVERS.filter(([key]) => key !== 'd_payout' && key !== 'd_amort');
const UNIT = { pct: '%', days: 'Tage', mult: 'x', flag: '1 / 0', years: 'Jahre', int: 'Stück', amt: '' };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (fin(v) ? v : null);
const shortName = (c) => String(c?.legalName || c?.nationalId || '').slice(0, 40);

function numberFormats(base) {
  const big = Math.abs(base.is.revenue) >= 1e9;
  return {
    unit: `${big ? 'Mio.' : 'Tsd.'} ${base.currency || 'EUR'}`,
    amt: big ? '#,##0.0,,;(#,##0.0,,);"–"' : '#,##0,;(#,##0,);"–"',
    pct: '0.0%',
    mult: '0.0"x"',
    days: '0.0',
    eps: '#,##0.00',
    int: '#,##0',
    flag: '0',
    years: '0',
    check: '#,##0.00;(#,##0.00);"✓ 0"',
  };
}

function styler(wb, F) {
  const roleStyle = {
    calc: {},
    input: { color: COLOR.input, fill: COLOR.inputFill },
    hist: { color: COLOR.input, fill: COLOR.histFill },
    histCalc: { fill: COLOR.histFill },
    link: { color: COLOR.link },
    histLink: { color: COLOR.link, fill: COLOR.histFill },
  };
  const weightStyle = { '': {}, bold: { bold: true }, total: { bold: true, border: 'total' }, muted: { italic: true, color: COLOR.muted } };
  return {
    num: (kind, role = 'calc', weight = '') => wb.style({ numFmt: F[kind], ...roleStyle[role], ...weightStyle[weight] }),
    label: (weight = '') => wb.style({ ...(weight === '' ? { indent: 1 } : {}), ...weightStyle[weight], ...(weight === 'muted' ? { indent: 1 } : {}) }),
    title: wb.style({ bold: true, size: 14, color: COLOR.title }),
    sub: wb.style({ color: COLOR.muted }),
    note: wb.style({ italic: true, color: COLOR.muted }),
    section: wb.style({ bold: true, fill: COLOR.headFill }),
    sectionFill: wb.style({ fill: COLOR.headFill }),
    subhead: wb.style({ bold: true, italic: true }),
    colHead: wb.style({ bold: true, align: 'right', border: 'bottom' }),
    colHeadHist: wb.style({ bold: true, align: 'right', border: 'bottom', fill: COLOR.histFill }),
    colHeadLeft: wb.style({ bold: true, border: 'bottom', color: COLOR.muted }),
    unit: wb.style({ color: COLOR.muted }),
    legendInput: wb.style({ color: COLOR.input, fill: COLOR.inputFill }),
    legendLink: wb.style({ color: COLOR.link }),
    ok: wb.style({ bold: true, color: COLOR.ok }),
    sensHead: wb.style({ numFmt: F.mult, bold: true, align: 'right', fill: COLOR.headFill }),
    sensHeadPct: wb.style({ numFmt: F.pct, bold: true, align: 'right', fill: COLOR.headFill }),
    sensCell: wb.style({ numFmt: F.pct, border: 'box' }),
    sensCorner: wb.style({ numFmt: F.pct, italic: true, color: COLOR.muted, fill: COLOR.headFill }),
  };
}

// Section header across `width` columns.
function section(ws, S, row, title, width) {
  ws.set(row, 0, { v: title, s: S.section });
  for (let c = 1; c < width; c++) ws.set(row, c, { v: null, s: S.sectionFill });
}

function header(ws, S, title, sub, note) {
  ws.set(1, 0, { v: title, s: S.title });
  ws.set(2, 0, { v: sub, s: S.sub });
  if (note) ws.set(3, 0, { v: note, s: S.note });
}

/**
 * Three-statement block — the layout and formulas shared by the standalone
 * sheets and the LBO's pro-forma model.
 *
 * cfg: {
 *   startRow   header row of the block
 *   open       [{ label, kind: 'hist', data: { is, bs } } | { label, kind: 'pf', cell(key, h) }]
 *              — the last entry is the opening balance sheet
 *   model      engine projection (values cached in the formula cells)
 *   labels     forecast column labels
 *   drivers    DRIVERS subset; driverCell(key, field, j, h) → { f, v, role }
 *   tranches   [{ key, label, rate(j, h) → expr, amort(j, h) → expr, sweep, pik: flag ref | null }]
 *   payout     true → dividends by d_payout, false → none
 *   sweepRef, sweepValue  share of excess cash swept (expr and value) — when a tranche sweeps
 *   circRef, spreadRef    switch and revolver spread
 *   othFinRef(h)          base-year other financial result, held flat
 * }
 * `h` = { X(key, j), P(key, j), O(key), at(key) } — cell refs within the block
 * (forecast year j, its previous column, opening column absolute / relative).
 */
function threeStatementBlock(ctx, ws, cfg) {
  const { S } = ctx;
  const { tranches, model } = cfg;
  const hasPik = tranches.some((t) => t.pik);
  const hasSweep = tranches.some((t) => t.sweep);
  const n = cfg.labels.length;

  const layout = [{ head: true }];
  const sec = (title) => layout.push({ section: title });
  const sub = (title) => layout.push({ subhead: title });
  const row = (key, label, kind = 'amt', weight = '') => layout.push({ key, label, kind, weight });

  sec('Annahmen je Jahr');
  for (const [key, , label, kind] of cfg.drivers) row(key, label, kind);
  sec('Gewinn- und Verlustrechnung');
  row('rev', 'Umsatzerlöse', 'amt', 'bold');
  row('ebitda', 'EBITDA', 'amt', 'bold');
  row('margin', 'EBITDA-Marge', 'pct', 'muted');
  row('da', 'Abschreibungen');
  row('ebit', 'EBIT', 'amt', 'total');
  row('intexp', 'Zinsaufwand');
  row('intinc', 'Zinserträge auf Kasse');
  row('othfin', 'Übriges Finanzergebnis');
  row('ebt', 'Ergebnis vor Steuern', 'amt', 'total');
  row('tax', 'Ertragsteuern');
  row('ni', 'Jahresüberschuss', 'amt', 'total');
  sec('Bilanz');
  row('cash', 'Kasse & Wertpapiere');
  row('ar', 'Forderungen');
  row('inv', 'Vorräte');
  row('fa', 'Sach- & immaterielle Anlagen');
  row('fin', 'Finanzanlagen');
  row('grec', 'Konzernforderungen');
  row('gw', 'Goodwill');
  row('oa', 'Sonstige Aktiva');
  row('ta', 'Summe Aktiva', 'amt', 'total');
  row('ap', 'Verbindlichkeiten L&L');
  row('ol', 'Sonstige Verbindlichkeiten');
  row('prov', 'Rückstellungen');
  row('gl', 'Konzernverbindlichkeiten');
  for (const t of tranches) row(`bs:${t.key}`, t.label);
  row('rv', 'Revolver');
  row('op', 'Sonstige Passiva');
  row('eq', 'Eigenkapital', 'amt', 'bold');
  row('tle', 'Summe Passiva', 'amt', 'total');
  row('chk', 'Bilanzcheck (Aktiva − Passiva)', 'check', 'muted');
  sec('Kapitalflussrechnung');
  row('cf_ni', 'Jahresüberschuss');
  row('cf_da', '+ Abschreibungen');
  if (hasPik) row('cf_pik', '+ PIK-Zinsen (unbar)');
  row('cf_dprov', '± Veränderung Rückstellungen');
  row('cf_dnwc', '± Veränderung Working Capital');
  row('cfo', 'Operativer Cashflow', 'amt', 'total');
  row('cf_capex', 'Investitionen (Capex)');
  row('fcf', 'Free Cashflow', 'amt', 'total');
  row('cf_div', 'Ausschüttung');
  row('cf_rep', 'Tilgung Finanzschulden');
  row('cf_rev', 'Revolver (Ziehung − Rückführung)');
  row('cf_net', 'Veränderung Kasse', 'amt', 'total');
  sec('Finanzierung & Tilgungsplan');
  row('w_pre', 'Kasse vor Schuldendienst');
  row('w_min', 'Mindestkasse');
  for (const t of tranches) {
    sub(t.label);
    row(`t_open:${t.key}`, 'Anfangsbestand');
    row(`t_int:${t.key}`, 'Zinsaufwand');
    if (t.pik) row(`t_pik:${t.key}`, '+ PIK-Zinsen');
    row(`t_mand:${t.key}`, 'Pflichttilgung');
    if (t.sweep) row(`t_sweep:${t.key}`, 'Cash Sweep');
    row(`t_close:${t.key}`, 'Endbestand', 'amt', 'total');
  }
  row('w_after', 'Kasse nach Pflichttilgung');
  sub('Revolver');
  row('r_open', 'Anfangsbestand');
  row('r_draw', 'Ziehung');
  row('r_repay', 'Rückführung');
  row('r_close', 'Endbestand', 'amt', 'total');
  row('r_int', 'Zinsaufwand');
  if (hasSweep) row('w_excess', 'Überschuss für Cash Sweep');

  const rowOf = {};
  layout.forEach((item, i) => { if (item.key) rowOf[item.key] = cfg.startRow + i; });
  const openCol = cfg.open.length;                  // column B = 1
  const fcol = (j) => openCol + 1 + j;
  const width = fcol(n - 1) + 1;

  const X = (key, j) => cellRef(rowOf[key], fcol(j));
  const P = (key, j) => cellRef(rowOf[key], j === 0 ? openCol : fcol(j - 1));
  const O = (key) => cellRef(rowOf[key], openCol, true);
  const sum = (keys, j) => keys.map((k) => X(k, j)).join('+') || '0';
  const circ = cfg.circRef;
  const h = { X, P, O, at: (key) => cellRef(rowOf[key], openCol) };
  const othFinRef = cfg.othFinRef(h);

  // Historical columns: reported values, sums and checks as formulas.
  const histCell = (key, d, col) => {
    const { is, bs } = d;
    const at = (k) => cellRef(rowOf[k], col);
    const vals = {
      rev: is.revenue, ebitda: is.ebitda, da: is.da != null ? -is.da : null, ebit: is.ebit,
      intexp: is.interestExpense != null ? -is.interestExpense : null, othfin: is.otherFinancial,
      ebt: is.ebt, tax: is.taxes != null ? -is.taxes : null, ni: is.netIncome,
      cash: bs.cash, ar: bs.receivables, inv: bs.inventory, fa: bs.fixedAssets, fin: bs.financialAssets,
      grec: bs.groupReceivables, gw: bs.goodwill, oa: bs.otherAssets, ap: bs.payables, ol: bs.otherLiabilities,
      prov: bs.provisions, gl: bs.groupLiabilities, op: bs.otherPassiva, eq: bs.equity, rv: bs.revolver || 0,
      [`bs:${tranches[0].key}`]: bs.debt,
    };
    if (key in vals) return { v: num(vals[key]), role: 'hist' };
    if (key === 'margin') return is.ebitda != null ? { f: `IF(${at('rev')}=0,0,${at('ebitda')}/${at('rev')})`, v: is.ebitda / is.revenue, role: 'histCalc' } : null;
    if (key === 'ta') return { f: `SUM(${at('cash')}:${at('oa')})`, v: bs.totalAssets, role: 'histCalc' };
    if (key === 'tle') return { f: `SUM(${at('ap')}:${at('eq')})`, v: bs.totalLiabEquity, role: 'histCalc' };
    if (key === 'chk') return { f: `ROUND(${at('ta')}-${at('tle')},2)`, v: Math.round((bs.totalAssets - bs.totalLiabEquity) * 100) / 100, role: 'histCalc' };
    return null;
  };

  // Forecast columns: [formula, cached value].
  const fwdCell = (key, j) => {
    const y = model.years[j];
    const prevCash = j === 0 ? model.opening.cash : model.years[j - 1].bs.cash;
    const [kind, tk] = key.split(':');
    const t = tk ? tranches.find((x) => x.key === tk) : null;
    const d = t ? y.debt.tranches.find((x) => x.key === tk) : null;
    const pikPlus = t?.pik ? `+${X(`t_pik:${tk}`, j)}` : '';
    const mands = tranches.map((x) => `t_mand:${x.key}`);
    const sweeps = tranches.filter((x) => x.sweep).map((x) => `t_sweep:${x.key}`);
    const mandatoryTotal = y.debt.tranches.reduce((s, x) => s + x.mandatory, 0);
    const wAfter = prevCash + y.cf.cfo + y.cf.capex + y.cf.dividends - mandatoryTotal;
    const rv = y.debt.revolver;
    switch (kind) {
      case 'rev': return [`${P('rev', j)}*(1+${X('d_g', j)})`, y.is.revenue];
      case 'ebitda': return [`${X('rev', j)}*${X('d_m', j)}`, y.is.ebitda];
      case 'margin': return [`IF(${X('rev', j)}=0,0,${X('ebitda', j)}/${X('rev', j)})`, y.is.ebitdaMargin];
      case 'da': return [`-${X('rev', j)}*${X('d_da', j)}`, -y.is.da];
      case 'ebit': return [`${X('ebitda', j)}+${X('da', j)}`, y.is.ebit];
      case 'intexp': return [`-(${sum([...tranches.map((x) => `t_int:${x.key}`), 'r_int'], j)})`, -y.is.interestExpense];
      case 'intinc': return [`${X('d_cr', j)}*MAX(0,IF(${circ}=1,(${P('cash', j)}+IFERROR(${X('cash', j)},${P('cash', j)}))/2,${P('cash', j)}))`, y.is.interestIncome];
      case 'othfin': return [`MAX(0,${othFinRef})`, y.is.otherFinancial];
      case 'ebt': return [`${X('ebit', j)}+${X('intexp', j)}+${X('intinc', j)}+${X('othfin', j)}`, y.is.ebt];
      case 'tax': return [`-MAX(0,${X('ebt', j)})*${X('d_tax', j)}`, -y.is.taxes];
      case 'ni': return [`${X('ebt', j)}+${X('tax', j)}`, y.is.netIncome];
      case 'cash': return [`${P('cash', j)}+${X('cf_net', j)}`, y.bs.cash];
      case 'ar': return [`${X('rev', j)}*${X('d_dso', j)}/365`, y.bs.receivables];
      case 'inv': return [`${X('rev', j)}*${X('d_dio', j)}/365`, y.bs.inventory];
      case 'fa': return [`${P('fa', j)}-${X('cf_capex', j)}+${X('da', j)}`, y.bs.fixedAssets];
      case 'fin': return [P('fin', j), y.bs.financialAssets];
      case 'grec': return [P('grec', j), y.bs.groupReceivables];
      case 'gw': return [P('gw', j), y.bs.goodwill];
      case 'oa': return [P('oa', j), y.bs.otherAssets];
      case 'ta': return [`SUM(${X('cash', j)}:${X('oa', j)})`, y.bs.totalAssets];
      case 'ap': return [`${X('rev', j)}*${X('d_dpo', j)}/365`, y.bs.payables];
      case 'ol': return [`${X('rev', j)}*${X('d_oth', j)}`, y.bs.otherLiabilities];
      case 'prov': return [`${X('rev', j)}*${X('d_prov', j)}`, y.bs.provisions];
      case 'gl': return [P('gl', j), y.bs.groupLiabilities];
      case 'bs': return [X(`t_close:${tk}`, j), y.bs.tranche[tk]];
      case 'rv': return [X('r_close', j), y.bs.revolver];
      case 'op': return [P('op', j), y.bs.otherPassiva];
      case 'eq': return [`${P('eq', j)}+${X('ni', j)}+${X('cf_div', j)}`, y.bs.equity];
      case 'tle': return [`SUM(${X('ap', j)}:${X('eq', j)})`, y.bs.totalLiabEquity];
      case 'chk': return [`ROUND(${X('ta', j)}-${X('tle', j)},2)`, Math.round(y.check * 100) / 100];
      case 'cf_ni': return [X('ni', j), y.cf.netIncome];
      case 'cf_da': return [`-${X('da', j)}`, y.cf.da];
      case 'cf_pik': return [sum(tranches.filter((x) => x.pik).map((x) => `t_pik:${x.key}`), j), y.cf.pik];
      case 'cf_dprov': return [`${X('prov', j)}-${P('prov', j)}`, y.cf.deltaProvisions];
      case 'cf_dnwc': return [`-((${X('ar', j)}+${X('inv', j)}-${X('ap', j)}-${X('ol', j)})-(${P('ar', j)}+${P('inv', j)}-${P('ap', j)}-${P('ol', j)}))`, y.cf.deltaNwc];
      case 'cfo': return [`SUM(${X('cf_ni', j)}:${X('cf_dnwc', j)})`, y.cf.cfo];
      case 'cf_capex': return [`-${X('rev', j)}*${X('d_capex', j)}`, y.cf.capex];
      case 'fcf': return [`${X('cfo', j)}+${X('cf_capex', j)}`, y.cf.fcf];
      case 'cf_div': return cfg.payout ? [`-${X('d_payout', j)}*MAX(0,${X('ni', j)})`, y.cf.dividends] : [null, 0];
      case 'cf_rep': return [`-(${sum([...mands, ...sweeps], j)})`, y.cf.debtRepayment];
      case 'cf_rev': return [`${X('r_draw', j)}-${X('r_repay', j)}`, y.cf.revolverNet];
      case 'cf_net': return [`${X('fcf', j)}+${X('cf_div', j)}+${X('cf_rep', j)}+${X('cf_rev', j)}`, y.cf.netChange];
      case 'w_pre': return [`${P('cash', j)}+${X('cfo', j)}+${X('cf_capex', j)}+${X('cf_div', j)}`, prevCash + y.cf.cfo + y.cf.capex + y.cf.dividends];
      case 'w_min': return [`${X('rev', j)}*${X('d_min', j)}`, y.minCash];
      case 't_open': return [j === 0 ? O(`bs:${tk}`) : P(`t_close:${tk}`, j), d.open];
      case 't_int': {
        const open = X(`t_open:${tk}`, j), close = X(`t_close:${tk}`, j);
        return [`${t.rate(j, h)}*IF(${circ}=1,(${open}+IFERROR(${close},${open}))/2,${open})`, d.interest];
      }
      case 't_pik': return [`IF(${t.pik}=1,${X(`t_int:${tk}`, j)},0)`, d.pik];
      case 't_mand': return [`MIN(${X(`t_open:${tk}`, j)}${pikPlus},${t.amort(j, h)}*${O(`bs:${tk}`)})`, d.mandatory];
      case 't_sweep': {
        const before = sweeps.slice(0, sweeps.indexOf(`t_sweep:${tk}`)).map((k) => `-${X(k, j)}`).join('');
        return [`MAX(0,MIN(${X(`t_open:${tk}`, j)}${pikPlus}-${X(`t_mand:${tk}`, j)},${X('w_excess', j)}${before}))`, d.sweep];
      }
      case 't_close': return [`${X(`t_open:${tk}`, j)}${pikPlus}-${X(`t_mand:${tk}`, j)}${t.sweep ? `-${X(`t_sweep:${tk}`, j)}` : ''}`, d.close];
      case 'w_after': return [`${X('w_pre', j)}-(${sum(mands, j)})`, wAfter];
      case 'r_open': return [j === 0 ? O('rv') : P('r_close', j), rv.open];
      case 'r_draw': return [`MAX(0,${X('w_min', j)}-${X('w_after', j)})`, rv.draw];
      case 'r_repay': return [`IF(${X('w_after', j)}<${X('w_min', j)},0,MIN(${X('r_open', j)},${X('w_after', j)}-${X('w_min', j)}))`, rv.repay];
      case 'r_close': return [`${X('r_open', j)}+${X('r_draw', j)}-${X('r_repay', j)}`, rv.close];
      case 'r_int': return [`(${X('d_ir', j)}+${cfg.spreadRef})*IF(${circ}=1,(${X('r_open', j)}+IFERROR(${X('r_close', j)},${X('r_open', j)}))/2,${X('r_open', j)})`, rv.interest];
      case 'w_excess': return [`MAX(0,${X('w_after', j)}+${X('r_draw', j)}-${X('r_repay', j)}-${X('w_min', j)})*${cfg.sweepRef}`, Math.max(0, wAfter + rv.draw - rv.repay - y.minCash) * cfg.sweepValue];
      default: throw new Error(`no formula for ${key}`);
    }
  };

  layout.forEach((item, i) => {
    const r = cfg.startRow + i;
    if (item.head) {
      ws.set(r, 0, { v: `Beträge in ${ctx.F.unit}`, s: S.colHeadLeft });
      cfg.open.forEach((o, c) => ws.set(r, 1 + c, { v: o.label, s: S.colHeadHist }));
      cfg.labels.forEach((l, j) => ws.set(r, fcol(j), { v: l, s: S.colHead }));
      return;
    }
    if (item.section) { section(ws, S, r, item.section, width); return; }
    if (item.subhead) { ws.set(r, 0, { v: item.subhead, s: S.subhead }); return; }
    const { key, kind, weight } = item;
    ws.set(r, 0, { v: item.label, s: S.label(weight) });
    const isDriver = key.startsWith('d_');
    cfg.open.forEach((o, c) => {
      const col = 1 + c;
      const cell = isDriver ? null : o.kind === 'hist' ? histCell(key, o.data, col) : o.cell(key, h);
      ws.set(r, col, cell
        ? { f: cell.f, v: cell.v, s: S.num(kind, cell.role, weight) }
        : { v: null, s: S.num(kind, 'histCalc', weight) });
    });
    for (let j = 0; j < n; j++) {
      if (isDriver) {
        const field = cfg.drivers.find(([k]) => k === key)[1];
        const cell = cfg.driverCell(key, field, j, h);
        ws.set(r, fcol(j), { f: cell.f, v: cell.v, s: S.num(kind, cell.role) });
        continue;
      }
      const [f, v] = fwdCell(key, j);
      ws.set(r, fcol(j), f ? { f, v, s: S.num(kind, 'calc', weight) } : { v, s: S.num(kind, 'calc', weight) });
    }
  });

  // Balance check across all forecast years, for the summary cells.
  const chkRange = `${X('chk', 0)}:${X('chk', n - 1)}`;
  return {
    rowOf, openCol, fcol, n, width, endRow: cfg.startRow + layout.length - 1,
    X, O,
    balancedFormula: `IF(SUMPRODUCT(ABS(${chkRange}))<1,"✓ ausgeglichen","✗ nicht ausgeglichen")`,
    balancedValue: model.balanced ? '✓ ausgeglichen' : '✗ nicht ausgeglichen',
  };
}

// ─── Annahmen ───
function inputsSheet(ctx) {
  const { wb, S, company, base, ts, cp, F } = ctx;
  const ws = wb.addSheet(SHEET_INPUTS, { widths: [52, 18, 18, 46], tabColor: COLOR.input, freeze: { row: 6, col: 1 } });
  header(ws, S, `Kontur Bewertungsmodell · ${shortName(company)}`,
    `${company.country} ${company.nationalId} · Basis GJ ${base.year} (Stichtag ${base.stichtag}) · Beträge in ${F.unit} · Export ${ctx.date}`,
    'Blau auf Gelb = Eingabe · Schwarz = Formel · Grün = Verweis auf ein anderes Blatt. Ist-Werte stammen aus dem Jahresabschluss (grau hinterlegt).');
  ws.set(5, 0, { v: 'Operative Annahmen (Basis für alle Modelle)', s: S.section });
  ws.set(5, 1, { v: shortName(company), s: S.section });
  ws.set(5, 2, { v: cp ? shortName(cp.company) : '', s: S.section });
  ws.set(5, 3, { v: 'Einheit / Hinweis', s: S.section });
  const rows = {};
  let r = 6;
  for (const [key, field, label, kind] of DRIVERS) {
    rows[key] = r;
    ws.set(r, 0, { v: label, s: S.label() });
    ws.set(r, 1, { v: ts[field], s: S.num(kind, 'input') });
    if (cp) ws.set(r, 2, { v: cp.assumptions[field], s: S.num(kind, 'input') });
    ws.set(r, 3, { v: kind === 'days' ? 'Tage auf Umsatzbasis' : '%', s: S.unit });
    r++;
  }
  r++;
  section(ws, S, r++, 'Modell-Schalter', 4);
  rows.circ = r;
  ws.set(r, 0, { v: 'Zinsen auf Durchschnittsbeständen (1 = ja, 0 = Anfangsbestand)', s: S.label() });
  ws.set(r, 1, { v: 1, s: S.num('flag', 'input') });
  ws.set(r++, 3, { v: 'Zirkularität — iterative Berechnung ist aktiviert', s: S.unit });
  rows.spread = r;
  ws.set(r, 0, { v: 'Aufschlag Revolver auf Zins Finanzschulden', s: S.label() });
  ws.set(r, 1, { v: 0.01, s: S.num('pct', 'input') });
  ws.set(r++, 3, { v: '%', s: S.unit });
  ws.set(r, 0, { v: 'Planjahre 3-Statement', s: S.label() });
  ws.set(r, 1, { v: ctx.tsYears, s: S.num('years') });
  ws.set(r++, 3, { v: 'Struktur: im Web-Tool ändern und neu exportieren', s: S.unit });
  r++;
  section(ws, S, r++, 'Prüfungen', 4);
  ctx.checkRow = r;              // filled once the model sheets exist
  return { ws, rows, ref: (key, col = 1) => sheetRef(SHEET_INPUTS, cellRef(rows[key], col, true)) };
}

// ─── 3-Statement (standalone) ───
function standaloneSheet(ctx, { name, base, assumptions, years, inputsCol, title }) {
  const { wb, S, inputs } = ctx;
  const model = projectThreeStatement(base, assumptions, { years });
  const labels = model.years.map((y) => y.label);
  const open = [
    ...(base.prior ? [{ label: `${base.prior.year}A`, kind: 'hist', data: { is: base.prior.is, bs: base.prior.bs } }] : []),
    { label: `${base.year}A`, kind: 'hist', data: { is: base.is, bs: base.bs } },
  ];
  const ws = wb.addSheet(name, { widths: [44, ...Array(open.length + labels.length).fill(13)], freeze: { row: 7, col: 1 } });
  header(ws, S, title, `Basis GJ ${base.year} · Beträge in ${ctx.F.unit} · A = Ist laut Jahresabschluss, E = Plan`,
    'Treiber je Jahr verweisen auf Annahmen und lassen sich pro Jahr überschreiben. Working-Capital-Tage auf Umsatzbasis.');
  const block = threeStatementBlock(ctx, ws, {
    startRow: 6,
    open,
    model,
    labels,
    drivers: DRIVERS,
    // First plan year links to Annahmen, later years carry the previous year forward.
    driverCell: (key, field, j, h) => (j === 0
      ? { f: inputs.ref(key, inputsCol), v: assumptions[field], role: 'link' }
      : { f: h.P(key, j), v: assumptions[field], role: 'calc' }),
    tranches: [{
      key: 'debt', label: 'Finanzschulden', sweep: false, pik: null,
      rate: (j, h) => h.X('d_ir', j),
      amort: (j, h) => h.X('d_amort', j),
    }],
    payout: true,
    circRef: inputs.ref('circ'),
    spreadRef: inputs.ref('spread'),
    othFinRef: (h) => h.O('othfin'),
  });
  ws.set(4, 0, { v: 'Bilanzcheck alle Planjahre', s: S.label('bold') });
  ws.set(4, 1, { f: block.balancedFormula, v: block.balancedValue, s: S.ok });
  const at = (key, col) => sheetRef(name, cellRef(block.rowOf[key], col, true));
  return {
    name, ws, block, model, base, assumptions,
    baseCell: (key) => at(key, block.openCol),
    year: (key, j) => sheetRef(name, cellRef(block.rowOf[key], block.fcol(j))),
    check: { label: `Bilanzcheck ${name}`, ref: sheetRef(name, cellRef(4, 1, true)), value: block.balancedValue },
  };
}

// Label / value rows in columns A–C, keyed for formulas (`B(key)`).
function valueRows(ws, S, startRow) {
  const R = {};
  const w = {
    R,
    row: startRow,
    B: (key) => cellRef(R[key], 1, true),
    put(key, label, kind, cell, weight = '', unit = null) {
      R[key] = w.row;
      ws.set(w.row, 0, { v: label, s: S.label(weight) });
      ws.set(w.row, 1, { f: cell.f, v: cell.v, s: S.num(kind, cell.role || 'calc', weight) });
      if (unit) ws.set(w.row, 2, { v: unit, s: S.unit });
      w.row++;
    },
    section(title, width = 3) { section(ws, S, w.row++, title, width); },
    sub(title) { ws.set(w.row++, 0, { v: title, s: S.subhead }); },
  };
  return w;
}

// 2D Excel data table: corner = output formula, top row = values for the row
// input cell, left column = values for the column input cell.
function dataTable(ws, S, { top, left, corner, rows, cols, values, rowInput, colInput, colKind }) {
  ws.set(top, left, { ...corner, s: S.sensCorner });
  cols.forEach((c, j) => ws.set(top, left + 1 + j, { v: c, s: colKind === 'pct' ? S.sensHeadPct : S.sensHead }));
  rows.forEach((rv, i) => {
    ws.set(top + 1 + i, left, { v: rv, s: S.sensHead });
    cols.forEach((_, j) => {
      const v = values[i][j] ?? '#N/A';
      const cell = { v, s: S.sensCell };
      if (i === 0 && j === 0) {
        cell.dataTable = {
          ref: `${cellRef(top + 1, left + 1)}:${cellRef(top + rows.length, left + cols.length)}`,
          r1: rowInput, r2: colInput,
        };
      }
      ws.set(top + 1 + i, left + 1 + j, cell);
    });
  });
}

const BS_FIELD = {
  cash: 'cash', ar: 'receivables', inv: 'inventory', fa: 'fixedAssets', fin: 'financialAssets',
  grec: 'groupReceivables', gw: 'goodwill', oa: 'otherAssets', ap: 'payables', ol: 'otherLiabilities',
  prov: 'provisions', gl: 'groupLiabilities', op: 'otherPassiva', eq: 'equity', rv: 'revolver',
};

// ─── LBO ───
function lboSheet(ctx, ts, l) {
  const { wb, S, inputs, F } = ctx;
  const r = runLbo(ts.base, ts.assumptions, l);
  const name = 'LBO';
  const n = Math.max(1, Math.min(10, Math.round(l.holdYears)));
  const ws = wb.addSheet(name, { widths: [46, 14, ...Array(n + 1).fill(13)], freeze: { row: 1, col: 1 } });
  header(ws, S, `LBO · ${shortName(ctx.company)}`, `Entry auf Basis GJ ${ts.base.year} · Exit nach ${n} Jahren · Beträge in ${F.unit}`,
    'Operative Treiber verweisen auf das Blatt 3-Statement. Cash-free/debt-free: bestehende Finanzschulden werden abgelöst, übernommene Kasse finanziert mit.');
  if (r.error) {
    ws.set(5, 0, { v: r.error, s: S.note });
    return { check: null };
  }
  const e = r.entry;
  const tsb = (key) => ts.baseCell(key);
  const w = valueRows(ws, S, 5);
  const { B } = w;

  w.section('Annahmen LBO');
  w.put('entry', 'Entry-Multiple (EV / EBITDA LTM)', 'mult', { v: l.entryMultiple, role: 'input' });
  w.put('exit', 'Exit-Multiple (EV / EBITDA Exit-Jahr)', 'mult', { v: l.exitMultiple, role: 'input' });
  w.put('fees', 'Transaktionskosten (% EV)', 'pct', { v: l.feesPct, role: 'input' });
  w.put('sMult', 'Senior-Darlehen (x EBITDA)', 'mult', { v: l.seniorMultiple, role: 'input' });
  w.put('sRate', 'Zins Senior', 'pct', { v: l.seniorRate, role: 'input' });
  w.put('sAmort', 'Pflichttilgung Senior p. a. (% Ursprungsbetrag)', 'pct', { v: l.seniorAmortPct, role: 'input' });
  w.put('sweep', 'Cash Sweep (% Überschusskasse)', 'pct', { v: l.sweepPct, role: 'input' });
  w.put('mMult', 'Mezzanine (x EBITDA)', 'mult', { v: l.mezzMultiple, role: 'input' });
  w.put('mRate', 'Zins Mezzanine', 'pct', { v: l.mezzRate, role: 'input' });
  w.put('mPik', 'Mezzanine-Zinsen als PIK (1 = ja, 0 = bar)', 'flag', { v: l.mezzPik ? 1 : 0, role: 'input' });
  w.put('hold', 'Haltedauer (Struktur: im Web-Tool ändern, neu exportieren)', 'years', { v: n });
  w.row++;

  w.section('Transaktion');
  w.put('ebitda', 'EBITDA LTM', 'amt', ts.base.is.ebitda != null
    ? { f: tsb('ebitda'), v: e.ebitda, role: 'link' }
    : { f: `${tsb('rev')}*${inputs.ref('d_m')}`, v: e.ebitda });
  w.put('ev', 'Enterprise Value', 'amt', { f: `${B('ebitda')}*${B('entry')}`, v: e.ev }, 'bold');
  w.put('nd', 'Net Debt (Finanzschulden − Kasse)', 'amt', { f: `${tsb('bs:debt')}-${tsb('cash')}`, v: e.netDebt });
  w.put('eqPrice', 'Kaufpreis Eigenkapital', 'amt', { f: `${B('ev')}-${B('nd')}`, v: e.equityPrice });
  w.put('feesAmt', 'Transaktionskosten', 'amt', { f: `${B('ev')}*${B('fees')}`, v: e.fees });
  w.put('minCash', 'Mindestkasse bei Closing', 'amt', { f: `${tsb('rev')}*${inputs.ref('d_min')}`, v: e.minCash });
  w.put('senior', 'Senior-Darlehen', 'amt', { f: `${B('ebitda')}*${B('sMult')}`, v: r.sources[0].amount });
  w.put('mezz', 'Mezzanine', 'amt', { f: `${B('ebitda')}*${B('mMult')}`, v: r.sources[1].amount });
  w.put('sponsor', 'Sponsor-Eigenkapital', 'amt', { f: `${B('ev')}+${B('feesAmt')}+${B('minCash')}-${B('senior')}-${B('mezz')}`, v: e.sponsorEquity }, 'total');
  w.put('goodwill', 'Goodwill (EV − Buch-EK − Net Debt)', 'amt', { f: `${B('ev')}-(${tsb('eq')}+${B('nd')})`, v: e.goodwill });
  w.put('lev', 'Leverage (Fremdkapital / EBITDA)', 'mult', { f: `(${B('senior')}+${B('mezz')})/${B('ebitda')}`, v: e.leverage });
  w.row++;

  w.section('Sources & Uses', 4);
  ['Betrag', 'x EBITDA', '% Summe'].forEach((t, i) => ws.set(w.row, 1 + i, { v: t, s: S.colHead }));
  w.row++;
  const table = (title, items, totalKey) => {
    w.sub(title);
    const first = w.row, totalRow = first + items.length;
    for (const it of items) {
      ws.set(w.row, 0, { v: it.label, s: S.label() });
      ws.set(w.row, 1, { f: it.f, v: it.v, s: S.num('amt', it.role || 'calc') });
      ws.set(w.row, 2, { f: `${cellRef(w.row, 1)}/${B('ebitda')}`, v: it.v / e.ebitda, s: S.num('mult') });
      ws.set(w.row, 3, { f: `${cellRef(w.row, 1)}/${cellRef(totalRow, 1)}`, v: it.v / r.total, s: S.num('pct') });
      w.row++;
    }
    w.R[totalKey] = w.row;
    ws.set(w.row, 0, { v: 'Summe', s: S.label('total') });
    ws.set(w.row, 1, { f: `SUM(${cellRef(first, 1)}:${cellRef(totalRow - 1, 1)})`, v: r.total, s: S.num('amt', 'calc', 'total') });
    ws.set(w.row, 2, { f: `${cellRef(w.row, 1)}/${B('ebitda')}`, v: r.total / e.ebitda, s: S.num('mult', 'calc', 'total') });
    ws.set(w.row, 3, { f: `${cellRef(w.row, 1)}/${cellRef(totalRow, 1)}`, v: 1, s: S.num('pct', 'calc', 'total') });
    w.row++;
  };
  table('Mittelherkunft (Sources)', [
    { label: 'Senior-Darlehen', f: B('senior'), v: r.sources[0].amount },
    { label: 'Mezzanine', f: B('mezz'), v: r.sources[1].amount },
    { label: 'Übernommene Kasse', f: tsb('cash'), v: r.sources[2].amount, role: 'link' },
    { label: 'Sponsor-Eigenkapital', f: B('sponsor'), v: r.sources[3].amount },
  ], 'srcTotal');
  table('Mittelverwendung (Uses)', [
    { label: 'Kaufpreis Eigenkapital', f: B('eqPrice'), v: r.uses[0].amount },
    { label: 'Ablöse Finanzschulden', f: tsb('bs:debt'), v: r.uses[1].amount, role: 'link' },
    { label: 'Transaktionskosten', f: B('feesAmt'), v: r.uses[2].amount },
    { label: 'Mindestkasse', f: B('minCash'), v: r.uses[3].amount },
  ], 'useTotal');
  w.put('suCheck', 'Sources − Uses', 'check', { f: `ROUND(${B('srcTotal')}-${B('useTotal')},2)`, v: 0 }, 'muted');
  w.row++;

  // Pro-forma three statements: closing balance sheet + holding period.
  const checkRow = w.row;
  const opening = r.model.opening;
  const pfCell = (key, h) => {
    if (key === 'rev') return { f: tsb('rev'), v: ts.base.is.revenue, role: 'histLink' };
    if (key === 'cash') return { f: B('minCash'), v: opening.cash, role: 'histCalc' };
    if (key === 'gw') return { f: `${tsb('gw')}+${B('goodwill')}`, v: opening.goodwill, role: 'histCalc' };
    if (key === 'bs:senior') return { f: B('senior'), v: opening.tranche?.senior ?? r.sources[0].amount, role: 'histCalc' };
    if (key === 'bs:mezz') return { f: B('mezz'), v: r.sources[1].amount, role: 'histCalc' };
    if (key === 'rv') return { v: 0, role: 'histCalc' };
    if (key === 'eq') return { f: `${B('sponsor')}-${B('feesAmt')}`, v: opening.equity, role: 'histCalc' };
    if (key === 'ta') return { f: `SUM(${h.at('cash')}:${h.at('oa')})`, v: opening.totalAssets, role: 'histCalc' };
    if (key === 'tle') return { f: `SUM(${h.at('ap')}:${h.at('eq')})`, v: opening.totalLiabEquity, role: 'histCalc' };
    if (key === 'chk') return { f: `ROUND(${h.at('ta')}-${h.at('tle')},2)`, v: 0, role: 'histCalc' };
    if (BS_FIELD[key]) return { f: tsb(key), v: opening[BS_FIELD[key]], role: 'histLink' };
    return null;
  };
  const block = threeStatementBlock(ctx, ws, {
    startRow: checkRow + 2,
    open: [{ label: 'Closing PF', kind: 'pf', cell: pfCell }],
    model: r.model,
    labels: r.model.years.map((y) => y.label),
    drivers: LBO_DRIVERS,
    driverCell: (key, field, j) => ({ f: ts.year(key, Math.min(j, ts.block.n - 1)), v: ts.assumptions[field], role: 'link' }),
    tranches: [
      { key: 'senior', label: 'Senior-Darlehen', sweep: true, pik: null, rate: () => B('sRate'), amort: () => B('sAmort') },
      { key: 'mezz', label: 'Mezzanine', sweep: false, pik: B('mPik'), rate: () => B('mRate'), amort: () => '0' },
    ],
    payout: false,
    sweepRef: B('sweep'),
    sweepValue: l.sweepPct,
    circRef: inputs.ref('circ'),
    spreadRef: inputs.ref('spread'),
    othFinRef: () => tsb('othfin'),
  });
  const chkRange = `${cellRef(block.rowOf.chk, block.openCol)}:${cellRef(block.rowOf.chk, block.fcol(n - 1))}`;
  const balancedValue = r.model.balanced ? '✓ ausgeglichen' : '✗ nicht ausgeglichen';
  ws.set(checkRow, 0, { v: 'Bilanzcheck Closing + alle Jahre', s: S.label('bold') });
  ws.set(checkRow, 1, { f: `IF(SUMPRODUCT(ABS(${chkRange}))<1,"✓ ausgeglichen","✗ nicht ausgeglichen")`, v: balancedValue, s: S.ok });

  // Exit and returns.
  const last = n - 1;
  const XL = (key) => block.X(key, last);
  w.row = block.endRow + 2;
  w.section('Exit & Rendite', block.width);
  w.put('xEbitda', `EBITDA ${r.exit.year}`, 'amt', { f: XL('ebitda'), v: r.exit.ebitda });
  w.put('xMult', '× Exit-Multiple', 'mult', { f: B('exit'), v: l.exitMultiple });
  w.put('xEv', 'Enterprise Value Exit', 'amt', { f: `${B('xEbitda')}*${B('xMult')}`, v: r.exit.ev }, 'bold');
  w.put('xNd', 'Net Debt bei Exit', 'amt', { f: `${XL('bs:senior')}+${XL('bs:mezz')}+${XL('rv')}-${XL('cash')}`, v: r.exit.netDebt });
  w.put('xEq', 'Eigenkapital Exit', 'amt', { f: `${B('xEv')}-${B('xNd')}`, v: r.exit.equity }, 'total');
  w.put('moic', 'MOIC', 'mult', { f: `IF(${B('sponsor')}>0,MAX(0,${B('xEq')})/${B('sponsor')},NA())`, v: r.returns.moic ?? '#N/A' }, 'bold');
  const flowRow = w.row++;
  ws.set(flowRow, 0, { v: 'Sponsor-Cashflows (Closing … Exit)', s: S.label() });
  ws.set(flowRow, block.openCol, { f: `-${B('sponsor')}`, v: -e.sponsorEquity, s: S.num('amt') });
  for (let j = 0; j < n; j++) {
    ws.set(flowRow, block.fcol(j), j === last
      ? { f: `MAX(0,${B('xEq')})`, v: Math.max(0, r.exit.equity), s: S.num('amt') }
      : { v: 0, s: S.num('amt') });
  }
  w.put('irr', 'IRR', 'pct', {
    f: `IF(${B('sponsor')}<=0,NA(),IF(${B('xEq')}<=0,-1,IRR(${cellRef(flowRow, block.openCol)}:${cellRef(flowRow, block.fcol(last))})))`,
    v: r.returns.irr ?? '#N/A',
  }, 'total');
  w.row++;

  w.section('Wertbeitrag (Entry-EK → Exit-EK)', block.width);
  const vc = r.valueCreation.map((x) => x.amount);
  w.put('vc1', 'EBITDA-Wachstum', 'amt', { f: `(${B('xEbitda')}-${B('ebitda')})*${B('entry')}`, v: vc[0] });
  w.put('vc2', 'Multiple-Veränderung', 'amt', { f: `(${B('exit')}-${B('entry')})*${B('xEbitda')}`, v: vc[1] });
  w.put('vc3', 'Entschuldung', 'amt', { f: `${B('senior')}+${B('mezz')}-${B('minCash')}-${B('xNd')}`, v: vc[2] });
  w.put('vc4', 'Transaktionskosten', 'amt', { f: `-${B('feesAmt')}`, v: vc[3] });
  w.put('vcSum', 'Wertzuwachs Eigenkapital', 'amt', { f: `SUM(${B('vc1')}:${B('vc4')})`, v: vc.reduce((a, b) => a + b, 0) }, 'total');
  w.put('vcChk', 'Abgleich mit Exit-EK − Sponsor-EK', 'check', { f: `ROUND(${B('vcSum')}-(${B('xEq')}-${B('sponsor')}),2)`, v: 0 }, 'muted');
  w.row++;

  w.section('Kreditkennzahlen', block.width);
  const credit = [
    ['Gesamtverschuldung', 'amt', (j) => `${block.X('bs:senior', j)}+${block.X('bs:mezz', j)}+${block.X('rv', j)}`, (c) => c.totalDebt],
    ['Net Debt / EBITDA', 'mult', (j, t) => `(${t}-${block.X('cash', j)})/${block.X('ebitda', j)}`, (c) => c.netDebtEbitda],
    ['EBITDA / Cash-Zinsen', 'mult', (j) => {
      const ci = `${block.X('t_int:senior', j)}+${block.X('t_int:mezz', j)}-${block.X('t_pik:mezz', j)}+${block.X('r_int', j)}`;
      return `IF(${ci}>0,${block.X('ebitda', j)}/(${ci}),NA())`;
    }, (c) => c.interestCoverage ?? '#N/A'],
    ['Schulden abgebaut (kumuliert)', 'pct', (j, t) => `1-${t}/(${B('senior')}+${B('mezz')})`, (c) => c.paidDown ?? '#N/A'],
  ];
  const totalRow = w.row;
  for (const [label, kind, f, v] of credit) {
    ws.set(w.row, 0, { v: label, s: S.label() });
    for (let j = 0; j < n; j++) {
      ws.set(w.row, block.fcol(j), { f: f(j, cellRef(totalRow, block.fcol(j))), v: v(r.credit[j]), s: S.num(kind) });
    }
    w.row++;
  }
  w.row++;

  w.section('IRR-Sensitivität · Excel-Datentabelle (Entry-Multiple ↓, Exit-Multiple →)', block.width);
  const sens = r.sensitivity;
  dataTable(ws, S, {
    top: w.row, left: 1,
    corner: { f: B('irr'), v: r.returns.irr ?? '#N/A' },
    rows: sens.rows, cols: sens.cols, values: sens.irr,
    rowInput: cellRef(w.R.exit, 1), colInput: cellRef(w.R.entry, 1), colKind: 'mult',
  });

  return {
    check: { label: 'Bilanzcheck LBO', ref: sheetRef(name, cellRef(checkRow, 1, true)), value: balancedValue },
    extra: { label: 'Sources − Uses (LBO)', ref: sheetRef(name, B('suCheck')), value: 0, kind: 'check' },
  };
}

// ─── Merger ───
function mergerSheet(ctx, self, cpSheet, merger) {
  const { wb, S, inputs, F } = ctx;
  const m = merger.assumptions;
  const acqIsSelf = merger.role === 'acquirer';
  const acq = acqIsSelf ? self : cpSheet, tgt = acqIsSelf ? cpSheet : self;
  const acqCompany = acqIsSelf ? ctx.company : merger.counterparty.company;
  const tgtCompany = acqIsSelf ? merger.counterparty.company : ctx.company;
  const r = runMerger({ base: acq.base, assumptions: acq.assumptions }, { base: tgt.base, assumptions: tgt.assumptions }, m);
  const name = 'Merger';
  const n = r.years?.length || 1;
  const ws = wb.addSheet(name, { widths: [48, 15, 15, 15, 15, 15, 15], freeze: { row: 1, col: 1 } });
  header(ws, S, `Merger · ${shortName(acqCompany)} übernimmt ${shortName(tgtCompany)}`,
    `Standalone-Prognosen aus ${acq.name} (Käufer) und ${tgt.name} (Ziel) · Beträge in ${F.unit}`,
    'Aktienanteil wie eingegeben; Kasse und neue Schulden teilen den Rest im Verhältnis ihrer Eingaben. Akquisitionsschulden tilgungsfrei.');
  if (r.error) {
    ws.set(5, 0, { v: r.error, s: S.note });
    return { check: null };
  }
  const acqTax = inputs.ref('d_tax', acqIsSelf ? 1 : 2);
  const A = (key) => acq.baseCell(key), T = (key) => tgt.baseCell(key);
  const w = valueRows(ws, S, 5);
  const { B } = w;
  const fz = r.financing;

  w.section('Annahmen Merger');
  w.put('offer', 'Angebot (EV / EBITDA LTM Ziel)', 'mult', { v: m.offerMultiple, role: 'input' });
  w.put('stock', 'Anteil neue Aktien am EK-Kaufpreis', 'pct', { v: m.pctStock, role: 'input' });
  w.put('cash', 'Anteil Kasse (teilt den Rest mit Schulden)', 'pct', { v: m.pctCash, role: 'input' });
  w.put('debt', 'Anteil neue Schulden (teilt den Rest mit Kasse)', 'pct', { v: m.pctDebt, role: 'input' });
  w.put('fees', 'Transaktionskosten (% EV)', 'pct', { v: m.feesPct, role: 'input' });
  w.put('pe', 'KGV Käufer (bewertet sein Eigenkapital)', 'mult', { v: m.acquirerPe, role: 'input' });
  w.put('shares', 'Anteile Käufer (normiert)', 'int', { v: m.acquirerShares, role: 'input' });
  w.put('cod', 'Zins neue Schulden', 'pct', { v: m.costOfDebt, role: 'input' });
  w.put('ioc', 'Entgangener Zins auf eingesetzte Kasse', 'pct', { v: m.interestOnCash, role: 'input' });
  w.put('syn', 'Synergien (% Umsatz Ziel, volle Rate)', 'pct', { v: m.synergiesPct, role: 'input' });
  w.put('integ', 'Integrationskosten (% der vollen Synergien, Jahr 1)', 'pct', { v: m.integrationCostPct, role: 'input' });
  w.put('wu', 'Stille Reserven (% Unterschiedsbetrag)', 'pct', { v: m.writeUpPct, role: 'input' });
  w.put('wuY', 'Abschreibungsdauer stille Reserven (Jahre)', 'years', { v: m.writeUpYears, role: 'input' });
  w.row++;

  w.section('Kaufpreis');
  w.put('tEbitda', 'EBITDA LTM Ziel', 'amt', { f: T('ebitda'), v: r.price.tgtEbitda, role: 'link' });
  w.put('ev', 'Enterprise Value', 'amt', { f: `${B('tEbitda')}*${B('offer')}`, v: r.price.ev }, 'bold');
  w.put('tNd', 'Net Debt Ziel', 'amt', { f: `${T('bs:debt')}-${T('cash')}`, v: r.price.tgtNetDebt });
  w.put('eqPrice', 'Kaufpreis Eigenkapital', 'amt', { f: `${B('ev')}-${B('tNd')}`, v: r.price.equityPrice }, 'total');
  w.put('feesAmt', 'Transaktionskosten (aus Kasse, Aufwand bei Closing)', 'amt', { f: `${B('ev')}*${B('fees')}`, v: r.price.fees });
  w.put('impPe', 'Implizites KGV Ziel', 'mult', { f: `IF(${T('ni')}>0,${B('eqPrice')}/${T('ni')},NA())`, v: r.price.impliedPe ?? '#N/A' });
  w.row++;

  w.section('Finanzierung');
  w.put('sStock', 'Aktienanteil', 'pct', { f: `MIN(1,MAX(0,${B('stock')}))`, v: fz.mix.stock });
  w.put('sCash', 'Kassenanteil', 'pct', { f: `IF(${B('cash')}+${B('debt')}>0,(1-${B('sStock')})*${B('cash')}/(${B('cash')}+${B('debt')}),0)`, v: fz.mix.cash });
  w.put('sDebt', 'Schuldenanteil', 'pct', { f: `1-${B('sStock')}-${B('sCash')}`, v: fz.mix.debt });
  w.put('cashUsed', 'Eingesetzte Kasse', 'amt', { f: `${B('eqPrice')}*${B('sCash')}`, v: fz.cashUsed });
  w.put('stockIssued', 'Neue Aktien (Wert)', 'amt', { f: `${B('eqPrice')}*${B('sStock')}`, v: fz.stockIssued });
  w.put('newDebt', 'Akquisitionsschulden', 'amt', { f: `${B('eqPrice')}*${B('sDebt')}`, v: fz.newDebt });
  w.put('acqNi0', 'Jahresüberschuss Käufer (Basisjahr)', 'amt', { f: A('ni'), v: acq.base.is.netIncome, role: 'link' });
  w.put('eqVal', 'Eigenkapitalwert Käufer (KGV × JÜ)', 'amt', { f: `IF(${B('acqNi0')}>0,${B('acqNi0')}*${B('pe')},NA())`, v: fz.equityValue ?? '#N/A' });
  w.put('price', 'Aktienkurs Käufer', 'eps', { f: `${B('eqVal')}/${B('shares')}`, v: fz.sharePrice ?? '#N/A' });
  w.put('newShares', 'Neue Anteile', 'int', { f: `IFERROR(IF(${B('price')}>0,${B('stockIssued')}/${B('price')},0),0)`, v: fz.newShares });
  w.put('pfShares', 'Anteile pro forma', 'int', { f: `${B('shares')}+${B('newShares')}`, v: fz.pfShares }, 'bold');
  w.row++;

  w.section('Kaufpreisallokation');
  w.put('bookEq', 'Buch-Eigenkapital Ziel', 'amt', { f: T('eq'), v: r.ppa.bookEquity, role: 'link' });
  w.put('excess', 'Unterschiedsbetrag', 'amt', { f: `${B('eqPrice')}-${B('bookEq')}`, v: r.ppa.excess });
  w.put('writeUp', 'Aufgedeckte stille Reserven', 'amt', { f: `MAX(0,${B('excess')})*${B('wu')}`, v: r.ppa.writeUp });
  w.put('dtl', 'Latente Steuern darauf', 'amt', { f: `${B('writeUp')}*${acqTax}`, v: r.ppa.dtl });
  w.put('gwPpa', 'Goodwill', 'amt', { f: `${B('excess')}-${B('writeUp')}+${B('dtl')}`, v: r.ppa.goodwill }, 'total');
  w.put('wuAmort', 'Abschreibung stille Reserven p. a.', 'amt', { f: `IF(${B('wuY')}>0,${B('writeUp')}/${B('wuY')},0)`, v: r.ppa.writeUpAmort });
  w.row++;

  // Year block: accretion / dilution.
  w.section('Ergebnis je Anteil (Accretion / Dilution)', 1 + n);
  ws.set(w.row, 0, { v: `Beträge in ${F.unit}`, s: S.colHeadLeft });
  r.years.forEach((y, j) => ws.set(w.row, 1 + j, { v: y.label, s: S.colHead }));
  w.row++;
  const Y = {};
  const yr = (key, label, kind, f, v, weight = '', role = 'calc') => {
    Y[key] = w.row;
    ws.set(w.row, 0, { v: label, s: S.label(weight) });
    r.years.forEach((y, j) => {
      const fx = f(j);
      ws.set(w.row, 1 + j, fx == null ? { v: v(y, j), s: S.num(kind, role, weight) } : { f: fx, v: v(y, j), s: S.num(kind, role, weight) });
    });
    w.row++;
  };
  const C = (key, j) => cellRef(Y[key], 1 + j);
  const phaseIn = (j) => m.phaseIn[Math.min(j, m.phaseIn.length - 1)] ?? 1;
  yr('phase', 'Synergie-Einphasung', 'pct', () => null, (y, j) => phaseIn(j), '', 'input');
  yr('acqNi', 'Jahresüberschuss Käufer (standalone)', 'amt', (j) => acq.year('ni', j), (y) => y.acqNetIncome, '', 'link');
  yr('tgtNi', 'Jahresüberschuss Ziel (standalone)', 'amt', (j) => tgt.year('ni', j), (y) => y.tgtNetIncome, '', 'link');
  yr('tgtRev', 'Umsatz Ziel', 'amt', (j) => tgt.year('rev', j), (y) => y.tgtRevenue, 'muted', 'link');
  yr('runRate', 'Synergien volle Rate', 'amt', (j) => `${C('tgtRev', j)}*${B('syn')}`, (y) => y.tgtRevenue * m.synergiesPct, 'muted');
  yr('synergies', '+ Synergien', 'amt', (j) => `${C('runRate', j)}*${C('phase', j)}`, (y) => y.synergies);
  yr('integ', '− Integrationskosten', 'amt', (j) => (j === 0 ? `-${C('runRate', j)}*${B('integ')}` : null), (y) => y.integrationCosts);
  yr('foregone', '− Entgangene Zinsen auf Kasse', 'amt', () => `-(${B('cashUsed')}+${B('feesAmt')})*${B('ioc')}`, (y) => y.foregoneInterest);
  yr('debtInt', '− Zinsen Akquisitionsschulden', 'amt', () => `-${B('newDebt')}*${B('cod')}`, (y) => y.debtInterest);
  yr('wuA', '− Abschreibung stille Reserven', 'amt', () => `-${B('wuAmort')}`, (y) => y.writeUpAmort);
  yr('pretax', 'Anpassungen vor Steuern', 'amt', (j) => `SUM(${C('synergies', j)}:${C('wuA', j)})`, (y) => y.synergies + y.integrationCosts + y.foregoneInterest + y.debtInterest + y.writeUpAmort, 'bold');
  yr('taxAdj', '± Steuereffekt der Anpassungen', 'amt', (j) => `-${C('pretax', j)}*${acqTax}`, (y) => y.taxOnAdjustments);
  yr('pfNi', 'Pro-forma-Jahresüberschuss', 'amt', (j) => `${C('acqNi', j)}+${C('tgtNi', j)}+${C('pretax', j)}+${C('taxAdj', j)}`, (y) => y.pfNetIncome, 'total');
  yr('sh', 'Anteile Käufer (standalone)', 'int', () => B('shares'), (y) => y.shares);
  yr('pfSh', 'Anteile pro forma', 'int', () => B('pfShares'), (y) => y.pfShares);
  yr('eps', 'EPS standalone', 'eps', (j) => `${C('acqNi', j)}/${C('sh', j)}`, (y) => y.eps);
  yr('pfEps', 'EPS pro forma', 'eps', (j) => `${C('pfNi', j)}/${C('pfSh', j)}`, (y) => y.pfEps, 'bold');
  yr('acc', 'Accretion / Dilution', 'pct', (j) => `IF(${C('eps', j)}>0,${C('pfEps', j)}/${C('eps', j)}-1,NA())`, (y) => y.accretion ?? '#N/A', 'total');
  yr('be', 'Break-even-Synergien (vor Steuern)', 'amt',
    (j) => `MAX(0,(${C('eps', j)}*${C('pfSh', j)}-(${C('acqNi', j)}+${C('tgtNi', j)}))/(1-${acqTax})-(${C('integ', j)}+${C('foregone', j)}+${C('debtInt', j)}+${C('wuA', j)}))`,
    (y) => y.breakEvenSynergies, 'muted');
  yr('pfEbitda', 'EBITDA pro forma (inkl. Synergien)', 'amt', (j) => `${acq.year('ebitda', j)}+${tgt.year('ebitda', j)}+${C('synergies', j)}`, (y) => y.pfEbitda);
  w.row++;

  // Combined balance sheet at closing.
  w.section('Kombinierte Bilanz bei Closing', 5);
  ['Käufer', 'Ziel', 'Anpassungen', 'Pro forma'].forEach((t, i) => ws.set(w.row, 1 + i, { v: t, s: S.colHead }));
  w.row++;
  const sumRefs = (refs) => (refs.length ? refs.join('+') : '0');
  const lines = [
    ['Kasse & Wertpapiere', ['cash'], `-(${B('cashUsed')}+${B('feesAmt')})`],
    ['Forderungen & Vorräte', ['ar', 'inv'], '0'],
    ['Anlagevermögen', ['fa', 'fin'], '0'],
    ['Aufgedeckte stille Reserven', [], B('writeUp')],
    ['Goodwill', ['gw'], B('gwPpa')],
    ['Sonstige Aktiva', ['grec', 'oa'], '0'],
    null,
    ['Finanzschulden', ['bs:debt', 'rv'], '0'],
    ['Akquisitionsfinanzierung', [], B('newDebt')],
    ['Operative Verbindlichkeiten & Rückstellungen', ['ap', 'ol', 'prov'], '0'],
    ['Latente Steuern (PPA)', [], B('dtl')],
    ['Sonstige Passiva', ['gl', 'op'], '0'],
    ['Eigenkapital', ['eq'], `${B('stockIssued')}-${B('feesAmt')}-${T('eq')}`],
    null,
  ];
  const closingRows = [];
  let groupStart = w.row;
  lines.forEach((line, i) => {
    const jsRow = r.closing.rows[i];
    if (!line) {
      ws.set(w.row, 0, { v: jsRow.label, s: S.label('total') });
      for (let c = 1; c <= 4; c++) {
        ws.set(w.row, c, { f: `SUM(${cellRef(groupStart, c)}:${cellRef(w.row - 1, c)})`, v: [jsRow.acq, jsRow.tgt, jsRow.adj, jsRow.pf][c - 1], s: S.num('amt', 'calc', 'total') });
      }
      closingRows.push(w.row);
      groupStart = w.row + 1;
      w.row++;
      return;
    }
    const [label, keys, adj] = line;
    ws.set(w.row, 0, { v: label, s: S.label() });
    ws.set(w.row, 1, { f: sumRefs(keys.map(A)), v: jsRow.acq, s: S.num('amt', 'link') });
    ws.set(w.row, 2, { f: sumRefs(keys.map(T)), v: jsRow.tgt, s: S.num('amt', 'link') });
    ws.set(w.row, 3, { f: adj, v: jsRow.adj, s: S.num('amt') });
    ws.set(w.row, 4, { f: `SUM(${cellRef(w.row, 1)}:${cellRef(w.row, 3)})`, v: jsRow.pf, s: S.num('amt') });
    w.R[`cl:${label}`] = w.row;
    w.row++;
  });
  const closingCheckRow = w.row;
  ws.set(w.row, 0, { v: 'Bilanzcheck (Aktiva − Passiva)', s: S.label('muted') });
  ws.set(w.row, 4, { f: `ROUND(${cellRef(closingRows[0], 4)}-${cellRef(closingRows[1], 4)},2)`, v: Math.round(r.closing.check * 100) / 100, s: S.num('check', 'calc', 'muted') });
  w.row += 2;

  w.section('Kreditkennzahlen', 5);
  const pf = (label) => cellRef(w.R[`cl:${label}`], 4, true);
  w.put('pfNd', 'Net Debt pro forma bei Closing', 'amt', { f: `${pf('Finanzschulden')}+${pf('Akquisitionsfinanzierung')}-${pf('Kasse & Wertpapiere')}`, v: r.credit.pfNetDebt });
  w.put('pfNdE', `Net Debt / EBITDA pro forma (${r.years[0].label})`, 'mult', { f: `IF(${C('pfEbitda', 0)}>0,${B('pfNd')}/${C('pfEbitda', 0)},NA())`, v: r.credit.pfNetDebtEbitda ?? '#N/A' });
  w.put('acqNdE', 'Net Debt / EBITDA Käufer vorher', 'mult', { f: `IF(${A('ebitda')}>0,(${A('bs:debt')}+${A('rv')}-${A('cash')})/${A('ebitda')},NA())`, v: r.credit.acqNetDebtEbitda ?? '#N/A' });
  w.row++;

  w.section(`Beitragsanalyse ${r.years[0].label}`, 5);
  ['Käufer', 'Ziel', 'Anteil Käufer', 'Anteil Ziel'].forEach((t, i) => ws.set(w.row, 1 + i, { v: t, s: S.colHead }));
  w.row++;
  const contrib = [
    ['Umsatz', acq.year('rev', 0), tgt.year('rev', 0), 'amt'],
    ['EBITDA', acq.year('ebitda', 0), tgt.year('ebitda', 0), 'amt'],
    ['Jahresüberschuss', acq.year('ni', 0), tgt.year('ni', 0), 'amt'],
    ['Anteile pro forma', B('shares'), B('newShares'), 'int'],
  ];
  contrib.forEach(([label, fa, ft, kind], i) => {
    const c = r.contribution[i];
    const share = c.acq >= 0 && c.tgt >= 0 && c.acq + c.tgt > 0 ? c.acq / (c.acq + c.tgt) : null;
    const b = cellRef(w.row, 1), t = cellRef(w.row, 2), d = cellRef(w.row, 3);
    ws.set(w.row, 0, { v: label, s: S.label() });
    ws.set(w.row, 1, { f: fa, v: c.acq, s: S.num(kind, kind === 'int' ? 'calc' : 'link') });
    ws.set(w.row, 2, { f: ft, v: c.tgt, s: S.num(kind, kind === 'int' ? 'calc' : 'link') });
    ws.set(w.row, 3, { f: `IF(AND(${b}>=0,${t}>=0,${b}+${t}>0),${b}/(${b}+${t}),NA())`, v: share ?? '#N/A', s: S.num('pct') });
    ws.set(w.row, 4, { f: `IF(ISNUMBER(${d}),1-${d},NA())`, v: share == null ? '#N/A' : 1 - share, s: S.num('pct') });
    w.row++;
  });
  w.row++;

  w.section(`EPS-Sensitivität ${r.years[0].label} · Excel-Datentabelle (Angebot ↓, Aktienanteil →)`, 7);
  dataTable(ws, S, {
    top: w.row, left: 1,
    corner: { f: C('acc', 0), v: r.years[0].accretion ?? '#N/A' },
    rows: r.sensitivity.rows, cols: r.sensitivity.cols, values: r.sensitivity.accretion,
    rowInput: cellRef(w.R.stock, 1), colInput: cellRef(w.R.offer, 1), colKind: 'pct',
  });

  return { check: { label: 'Closing-Bilanz Merger', ref: sheetRef(name, cellRef(closingCheckRow, 4, true)), value: 0, kind: 'check' } };
}

/**
 * Build the workbook.
 * @param company  { legalName, nationalId, country }
 * @param base     buildBase result of this company
 * @param ts       its three-statement assumptions
 * @param lbo      LBO assumptions
 * @param merger   null | { role: 'acquirer' | 'target', assumptions, counterparty: { company, base, assumptions } }
 * @returns Uint8Array (.xlsx)
 */
export function buildModelWorkbook({ company, base, ts, lbo, merger = null, exportedAt = new Date() }) {
  const wb = new Workbook({ iterate: true, title: `Kontur Bewertungsmodell ${shortName(company)}` });
  const F = numberFormats(base);
  const S = styler(wb, F);
  const tsYears = Math.max(1, Math.min(10, Math.round(ts.years ?? 5)));
  const mYears = merger ? Math.max(1, Math.min(5, Math.round(merger.assumptions.years))) : 0;
  const ctx = { wb, S, F, company, base, ts, cp: merger?.counterparty || null, tsYears, date: exportedAt.toISOString().slice(0, 10) };
  ctx.inputs = inputsSheet(ctx);

  // The merger reads this company's projection, so its sheet spans both horizons.
  const self = standaloneSheet(ctx, {
    name: SHEET_TS, base, assumptions: ts, years: Math.max(tsYears, mYears), inputsCol: 1,
    title: `3-Statement · ${shortName(company)}`,
  });
  const checks = [self.check];
  const lboOut = lboSheet(ctx, self, lbo);
  if (lboOut.check) checks.push(lboOut.check, lboOut.extra);
  if (merger) {
    const cp = merger.counterparty;
    const cpRole = merger.role === 'acquirer' ? 'Ziel' : 'Käufer';
    const cpSheet = standaloneSheet(ctx, {
      name: `3-Statement ${cpRole}`, base: cp.base, assumptions: cp.assumptions, years: mYears, inputsCol: 2,
      title: `3-Statement · ${shortName(cp.company)} (${cpRole})`,
    });
    checks.push(cpSheet.check);
    const mergerOut = mergerSheet(ctx, self, cpSheet, merger);
    if (mergerOut.check) checks.push(mergerOut.check);
  }

  const ws = ctx.inputs.ws;
  let row = ctx.checkRow;
  for (const c of checks) {
    ws.set(row, 0, { v: c.label, s: S.label() });
    ws.set(row, 1, { f: c.ref, v: c.value, s: c.kind === 'check' ? S.num('check', 'link') : S.ok });
    row++;
  }
  return wb.toBytes();
}

export function modelFileName(company, base) {
  const slug = String(company?.legalName || company?.nationalId || 'Firma')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `Kontur-Modell_${slug}_GJ${base.year}.xlsx`;
}
