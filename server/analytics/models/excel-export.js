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
// circuit breaker (1 = Durchschnitt, 0 = Anfangsbestand).
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
 *   open       [{ label, kind: 'hist', data: { is, bs } } | { label, kind: 'pf', cell(key) }]
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
 * `h` = { X(key, j), P(key, j), O(key) } — cell refs within the block.
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
  const h = { X, P, O };
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
      case 'intinc': return [`${X('d_cr', j)}*MAX(0,IF(${circ}=1,(${P('cash', j)}+${X('cash', j)})/2,${P('cash', j)}))`, y.is.interestIncome];
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
        return [`${t.rate(j, h)}*IF(${circ}=1,(${open}+${close})/2,${open})`, d.interest];
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
      case 'r_int': return [`(${X('d_ir', j)}+${cfg.spreadRef})*IF(${circ}=1,(${X('r_open', j)}+${X('r_close', j)})/2,${X('r_open', j)})`, rv.interest];
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
      const cell = isDriver ? null : o.kind === 'hist' ? histCell(key, o.data, col) : o.cell(key);
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
    base_: (key) => at(key, block.openCol),                   // base-year (opening) cell
    year: (key, j) => sheetRef(name, cellRef(block.rowOf[key], block.fcol(j))),
    check: { label: `Bilanzcheck ${name}`, ref: sheetRef(name, cellRef(4, 1, true)), value: block.balancedValue },
  };
}
