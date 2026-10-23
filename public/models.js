// Bewertungsmodelle im Firmendetail: 3-Statement, LBO, Merger.
// The engines are the server modules in server/analytics/models/, served at
// /lib/models/ — every input recalculates in the browser without a round
// trip. LBO and merger run on the 3-Statement drivers of this company, so a
// change there carries through to both. The Excel export is built here as
// well, from the current inputs, with live formulas.
import { buildBase, defaultAssumptions, projectThreeStatement } from '/lib/models/three-statement.js';
import { defaultLboAssumptions, runLbo } from '/lib/models/lbo.js';
import { defaultMergerAssumptions, runMerger } from '/lib/models/merger.js';
import { buildModelWorkbook, modelFileName } from '/lib/models/excel-export.js';

const CUR_SYM = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', NOK: 'NOK', SEK: 'SEK', DKK: 'DKK', PLN: 'PLN', CZK: 'CZK' };
const PCT = new Intl.NumberFormat('de-AT', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DEC1 = new Intl.NumberFormat('de-AT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const DEC2 = new Intl.NumberFormat('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INT = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 0 });
const fin = (v) => v != null && Number.isFinite(v);
const canon = (id) => String(id || '').trim().toLowerCase().replace(/\s+/g, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatter(base) {
  const big = Math.abs(base.is.revenue) >= 1e9;
  const div = big ? 1e6 : 1e3;
  const nf = big ? DEC1 : INT;
  const cur = CUR_SYM[base.currency] || base.currency || '€';
  const unit = `${big ? 'Mio.' : 'Tsd.'} ${cur}`;
  const amt = (v) => {
    if (!fin(v)) return '—';
    const s = nf.format(Math.abs(v) / div);
    if (/^[0,.]+$/.test(s)) return '–';
    return v < 0 ? `(${s})` : s;
  };
  return {
    unit, cur, amt,
    amtU: (v) => (fin(v) ? `${amt(v)} ${unit}` : '—'),
    kpiAmt: (v) => (fin(v) ? { text: amt(v), unit } : '—'),
    pct: (v) => (fin(v) ? PCT.format(v) : '—'),
    mult: (v) => (fin(v) ? `${DEC1.format(v)}x` : '—'),
    eps: (v) => (fin(v) ? `${DEC2.format(v)} ${cur}` : '—'),
    int: (v) => (fin(v) ? INT.format(v) : '—'),
  };
}

// ─────────── Input sheet ───────────
// kind: pct (stored as fraction, shown ×100) · days · mult · years · int · bool
const TS_FIELDS = [
  { title: 'Wachstum & Marge', fields: [
    { key: 'revenueGrowth', label: 'Umsatzwachstum p. a.', kind: 'pct' },
    { key: 'ebitdaMargin', label: 'EBITDA-Marge', kind: 'pct' },
    { key: 'daPct', label: 'Abschreibungen (% Umsatz)', kind: 'pct' },
    { key: 'capexPct', label: 'Capex (% Umsatz)', kind: 'pct' },
    { key: 'taxRate', label: 'Steuersatz', kind: 'pct' },
  ] },
  { title: 'Working Capital', fields: [
    { key: 'dso', label: 'Forderungen (Tage Umsatz)', kind: 'days' },
    { key: 'dio', label: 'Vorräte (Tage Umsatz)', kind: 'days' },
    { key: 'dpo', label: 'Verb. L&L (Tage Umsatz)', kind: 'days' },
    { key: 'otherLiabPct', label: 'Sonst. Verb. (% Umsatz)', kind: 'pct' },
    { key: 'provisionsPct', label: 'Rückstellungen (% Umsatz)', kind: 'pct' },
  ] },
  { title: 'Finanzierung', fields: [
    { key: 'interestRate', label: 'Zins Finanzschulden', kind: 'pct' },
    { key: 'debtAmortPct', label: 'Tilgung p. a. (% Anfangsbestand)', kind: 'pct' },
    { key: 'cashRate', label: 'Zins auf Kasse', kind: 'pct' },
    { key: 'payoutRatio', label: 'Ausschüttungsquote', kind: 'pct' },
    { key: 'minCashPct', label: 'Mindestkasse (% Umsatz)', kind: 'pct' },
    { key: 'years', label: 'Planjahre', kind: 'years', max: 10 },
  ] },
];

const LBO_FIELDS = [
  { title: 'Bewertung', fields: [
    { key: 'entryMultiple', label: 'Entry-Multiple (EV/EBITDA)', kind: 'mult' },
    { key: 'exitMultiple', label: 'Exit-Multiple (EV/EBITDA)', kind: 'mult' },
    { key: 'holdYears', label: 'Haltedauer', kind: 'years', max: 10 },
    { key: 'feesPct', label: 'Transaktionskosten (% EV)', kind: 'pct' },
  ] },
  { title: 'Senior-Darlehen', fields: [
    { key: 'seniorMultiple', label: 'Volumen (x EBITDA)', kind: 'mult' },
    { key: 'seniorRate', label: 'Zins', kind: 'pct' },
    { key: 'seniorAmortPct', label: 'Pflichttilgung p. a.', kind: 'pct' },
    { key: 'sweepPct', label: 'Cash Sweep (% Überschuss)', kind: 'pct' },
  ] },
  { title: 'Mezzanine', fields: [
    { key: 'mezzMultiple', label: 'Volumen (x EBITDA)', kind: 'mult' },
    { key: 'mezzRate', label: 'Zins', kind: 'pct' },
    { key: 'mezzPik', label: 'Zinsen als PIK (endfällig)', kind: 'bool' },
  ] },
];

const MERGER_FIELDS = [
  { title: 'Kaufpreis & Finanzierung', fields: [
    { key: 'offerMultiple', label: 'Angebot (EV/EBITDA Ziel)', kind: 'mult' },
    { key: 'pctCash', label: 'Anteil Kasse', kind: 'pct' },
    { key: 'pctStock', label: 'Anteil neue Aktien', kind: 'pct' },
    { key: 'pctDebt', label: 'Anteil neue Schulden', kind: 'pct' },
    { key: 'feesPct', label: 'Transaktionskosten (% EV)', kind: 'pct' },
  ] },
  { title: 'Käufer & Kapitalkosten', fields: [
    { key: 'acquirerPe', label: 'KGV Käufer (Aktienkurs)', kind: 'mult' },
    { key: 'acquirerShares', label: 'Anteile Käufer (normiert)', kind: 'int' },
    { key: 'costOfDebt', label: 'Zins neue Schulden', kind: 'pct' },
    { key: 'interestOnCash', label: 'Entgangener Zins auf Kasse', kind: 'pct' },
  ] },
  { title: 'Synergien & PPA', fields: [
    { key: 'synergiesPct', label: 'Synergien (% Umsatz Ziel)', kind: 'pct' },
    { key: 'integrationCostPct', label: 'Integrationskosten (% Synergien, J1)', kind: 'pct' },
    { key: 'writeUpPct', label: 'Stille Reserven (% Unterschiedsbetrag)', kind: 'pct' },
    { key: 'writeUpYears', label: 'Abschreibung stille Reserven', kind: 'years', max: 40 },
    { key: 'years', label: 'Planjahre', kind: 'years', max: 5 },
  ] },
];

const KIND_SUFFIX = { pct: '%', days: 'Tage', mult: 'x', years: 'J.', int: '' };
const KIND_STEP = { pct: 0.5, days: 1, mult: 0.5, years: 1, int: 1000 };
const shown = (kind, v) => (kind === 'pct' ? +(v * 100).toFixed(2) : +Number(v).toFixed(2));
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

function fieldsHtml(groups, values, defaults) {
  return groups.map((g) => `
    <fieldset class="model-fieldset">
      <legend>${esc(g.title)}</legend>
      ${g.fields.map((fd) => {
        const v = values[fd.key];
        const changed = !same(v, defaults[fd.key]) ? ' is-changed' : '';
        if (fd.kind === 'bool') {
          return `<label class="model-field model-field-bool${changed}"><span>${esc(fd.label)}</span>
            <input type="checkbox" data-key="${fd.key}" data-kind="bool"${v ? ' checked' : ''}></label>`;
        }
        const minMax = fd.kind === 'years' ? ` min="1" max="${fd.max}"` : fd.kind === 'pct' ? '' : ' min="0"';
        return `<label class="model-field${changed}"><span>${esc(fd.label)}</span>
          <span class="model-input"><input type="number" inputmode="decimal" step="${KIND_STEP[fd.kind]}"${minMax}
            data-key="${fd.key}" data-kind="${fd.kind}"${fd.max ? ` data-max="${fd.max}"` : ''} value="${shown(fd.kind, v)}">
          <em>${KIND_SUFFIX[fd.kind]}</em></span></label>`;
      }).join('')}
    </fieldset>`).join('');
}

// Writes each edit into `getTarget()` and calls `onChange`. Getters, because
// a reset swaps the assumption objects.
function bindFields(container, getTarget, getDefaults, onChange) {
  container.addEventListener('input', (ev) => {
    const input = ev.target.closest('input[data-key]');
    if (!input) return;
    const { key, kind } = input.dataset;
    let v;
    if (kind === 'bool') v = input.checked;
    else {
      v = parseFloat(String(input.value).replace(',', '.'));
      if (!Number.isFinite(v)) return;
      if (kind === 'pct') v /= 100;
      if (kind === 'years') v = Math.max(1, Math.min(Number(input.dataset.max) || 10, Math.round(v)));
      if (kind === 'int') v = Math.max(1, Math.round(v));
      if (kind === 'mult' || kind === 'days') v = Math.max(0, v);
    }
    getTarget()[key] = v;
    input.closest('.model-field').classList.toggle('is-changed', !same(v, getDefaults()[key]));
    onChange();
  });
}

// ─────────── Output building blocks ───────────
function gridTable(cols, rows) {
  const head = `<tr><th></th>${cols.map((c) => `<th class="num${c.actual ? ' is-actual' : ''}">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = rows.filter(Boolean).map((r) => (r.section
    ? `<tr class="section"><td colspan="${cols.length + 1}">${esc(r.section)}</td></tr>`
    : `<tr class="${r.cls || ''}"><td>${esc(r.label)}</td>${r.cells.map((v, i) =>
      `<td class="num${cols[i]?.actual ? ' is-actual' : ''}${r.cellCls?.[i] ? ` ${r.cellCls[i]}` : ''}">${esc(v)}</td>`).join('')}</tr>`)).join('');
  return `<div class="model-table-wrap"><table class="model-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

// Row factory over a list of columns; `when: false` drops all-zero rows.
function rowMaker(cols) {
  const row = (label, get, fmt, cls = '', { hideIfZero = false } = {}) => {
    const vals = cols.map((c) => { const v = get(c); return fin(v) ? v : null; });
    if (hideIfZero && vals.every((v) => v == null || Math.abs(v) < 0.5)) return null;
    return { label, cls, cells: vals.map((v) => fmt(v)), vals };
  };
  return row;
}
const neg = (get) => (c) => { const v = get(c); return fin(v) ? -v : v; };

function kpis(items) {
  return `<div class="model-kpis">${items.filter(Boolean).map(([label, value, cls = '', sub = '']) => `
    <div class="model-kpi ${cls}">
      <div class="model-kpi-label">${esc(label)}</div>
      <div class="model-kpi-value">${typeof value === 'object'
        ? `${esc(value.text)}<small>${esc(value.unit)}</small>` : esc(value)}</div>
      ${sub ? `<div class="model-kpi-sub">${esc(sub)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function toolbar(f, resetKey, check, warnings = []) {
  return `
    <div class="model-toolbar">
      ${check ? `<span class="model-check ${check.ok ? 'ok' : 'bad'}">${esc(check.text)}</span>` : '<span></span>'}
      <span class="model-toolbar-right">
        <span class="model-unit">Beträge in ${esc(f.unit)}</span>
        <button type="button" class="model-reset" data-reset="${resetKey}">Annahmen zurücksetzen</button>
        <button type="button" class="model-export" data-export title="Alle drei Modelle mit den aktuellen Annahmen als Excel-Datei mit Formeln">Excel-Export</button>
      </span>
    </div>
    ${warnings.length ? `<ul class="model-warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
}

function simpleTable(rows, head) {
  return `<div class="model-table-wrap"><table class="model-table model-table-compact">
    ${head ? `<thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>` : ''}
    <tbody>${rows.filter(Boolean).map(([label, ...cells]) => {
      const cls = typeof cells[cells.length - 1] === 'object' ? cells.pop().cls : '';
      return `<tr class="${cls}"><td>${esc(label)}</td>${cells.map((c) => `<td class="num">${esc(c)}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
}

function sensitivityTable({ rows, cols, values, rowLabel, colLabel, fmtRow, fmtCol, fmtCell, classify, base }) {
  return `<div class="model-table-wrap"><table class="model-table model-sens">
    <thead>
      <tr><th class="model-sens-axis">${esc(rowLabel)} ↓ · ${esc(colLabel)} →</th>${cols.map((c) => `<th class="num">${esc(fmtCol(c))}</th>`).join('')}</tr>
    </thead>
    <tbody>${rows.map((r, i) => `<tr><td>${esc(fmtRow(r))}</td>${cols.map((c, j) => {
      const v = values[i][j];
      const isBase = Math.abs(r - base[0]) < 1e-9 && Math.abs(c - base[1]) < 1e-9;
      return `<td class="num ${classify(v)}${isBase ? ' is-base' : ''}">${esc(fmtCell(v))}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function bars(items, f, totalLabel) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.amount)));
  const total = items.reduce((s, i) => s + i.amount, 0);
  return `<div class="model-bars">
    ${items.map((i) => `
      <div class="model-bar-row">
        <span class="model-bar-label">${esc(i.label)}</span>
        <span class="model-bar"><span class="model-bar-fill${i.amount < 0 ? ' neg' : ''}" style="width:${((Math.abs(i.amount) / max) * 100).toFixed(1)}%"></span></span>
        <span class="model-bar-value">${esc(f.amt(i.amount))}</span>
      </div>`).join('')}
    <div class="model-bar-row is-total">
      <span class="model-bar-label">${esc(totalLabel)}</span><span></span>
      <span class="model-bar-value">${esc(f.amt(total))}</span>
    </div>
  </div>`;
}

// ─────────── 3-Statement table ───────────
function threeStatementRows(cols, f) {
  const row = rowMaker(cols);
  const check = cols.map((c) => (c.bs ? c.bs.totalAssets - c.bs.totalLiabEquity : null));
  return [
    { section: 'Gewinn- und Verlustrechnung' },
    row('Umsatzerlöse', (c) => c.is?.revenue, f.amt, 'strong'),
    row('Wachstum', (c) => c.is?.growth, f.pct, 'muted'),
    row('EBITDA', (c) => c.is?.ebitda, f.amt, 'strong'),
    row('EBITDA-Marge', (c) => c.is?.ebitdaMargin, f.pct, 'muted'),
    row('Abschreibungen', neg((c) => c.is?.da), f.amt),
    row('EBIT', (c) => c.is?.ebit, f.amt, 'sub'),
    row('Zinsaufwand', neg((c) => c.is?.interestExpense), f.amt),
    row('Zinserträge auf Kasse', (c) => (c.actual ? null : c.is?.interestIncome), f.amt, '', { hideIfZero: true }),
    row('Übriges Finanzergebnis', (c) => c.is?.otherFinancial, f.amt, '', { hideIfZero: true }),
    row('Ergebnis vor Steuern', (c) => c.is?.ebt, f.amt, 'sub'),
    row('Ertragsteuern', neg((c) => c.is?.taxes), f.amt),
    row('Jahresüberschuss', (c) => c.is?.netIncome, f.amt, 'total'),

    { section: 'Bilanz' },
    row('Kasse & Wertpapiere', (c) => c.bs?.cash, f.amt),
    row('Forderungen', (c) => c.bs?.receivables, f.amt, '', { hideIfZero: true }),
    row('Vorräte', (c) => c.bs?.inventory, f.amt, '', { hideIfZero: true }),
    row('Sach- & immaterielle Anlagen', (c) => c.bs?.fixedAssets, f.amt, '', { hideIfZero: true }),
    row('Finanzanlagen', (c) => c.bs?.financialAssets, f.amt, '', { hideIfZero: true }),
    row('Konzernforderungen', (c) => c.bs?.groupReceivables, f.amt, '', { hideIfZero: true }),
    row('Goodwill', (c) => c.bs?.goodwill, f.amt, '', { hideIfZero: true }),
    row('Sonstige Aktiva', (c) => c.bs?.otherAssets, f.amt, '', { hideIfZero: true }),
    row('Summe Aktiva', (c) => c.bs?.totalAssets, f.amt, 'total'),
    row('Verbindlichkeiten L&L', (c) => c.bs?.payables, f.amt, '', { hideIfZero: true }),
    row('Sonstige Verbindlichkeiten', (c) => c.bs?.otherLiabilities, f.amt, '', { hideIfZero: true }),
    row('Rückstellungen', (c) => c.bs?.provisions, f.amt, '', { hideIfZero: true }),
    row('Konzernverbindlichkeiten', (c) => c.bs?.groupLiabilities, f.amt, '', { hideIfZero: true }),
    row('Finanzschulden', (c) => c.bs?.debt, f.amt),
    row('Revolver', (c) => c.bs?.revolver, f.amt, '', { hideIfZero: true }),
    row('Sonstige Passiva', (c) => c.bs?.otherPassiva, f.amt, '', { hideIfZero: true }),
    row('Eigenkapital', (c) => c.bs?.equity, f.amt, 'sub'),
    row('Summe Passiva', (c) => c.bs?.totalLiabEquity, f.amt, 'total'),
    {
      label: 'Bilanzcheck (Aktiva − Passiva)', cls: 'check',
      cells: check.map((d) => (d == null ? '' : Math.abs(d) < 1 ? '✓ 0' : f.amt(d))),
      cellCls: check.map((d) => (d == null || Math.abs(d) < 1 ? 'ok' : 'bad')),
    },

    { section: 'Kapitalflussrechnung' },
    row('Jahresüberschuss', (c) => c.cf?.netIncome, f.amt),
    row('+ Abschreibungen', (c) => c.cf?.da, f.amt),
    row('+ PIK-Zinsen (unbar)', (c) => c.cf?.pik, f.amt, '', { hideIfZero: true }),
    row('± Veränderung Rückstellungen', (c) => c.cf?.deltaProvisions, f.amt),
    row('± Veränderung Working Capital', (c) => c.cf?.deltaNwc, f.amt),
    row('Operativer Cashflow', (c) => c.cf?.cfo, f.amt, 'sub'),
    row('Investitionen (Capex)', (c) => c.cf?.capex, f.amt),
    row('Free Cashflow', (c) => c.cf?.fcf, f.amt, 'sub'),
    row('Ausschüttung', (c) => c.cf?.dividends, f.amt, '', { hideIfZero: true }),
    row('Tilgung Finanzschulden', (c) => c.cf?.debtRepayment, f.amt),
    row('Revolver (Ziehung / Rückführung)', (c) => c.cf?.revolverNet, f.amt, '', { hideIfZero: true }),
    row('Veränderung Kasse', (c) => c.cf?.netChange, f.amt, 'total'),
  ];
}

// ─────────── Entry point ───────────
export function renderModels(section, { company, financials }) {
  if (!section) return;
  const base = buildBase(financials, { country: company.country });
  if (base.error) return;
  section.hidden = false;
  const f = formatter(base);
  const defaults = { ts: defaultAssumptions(base), lbo: defaultLboAssumptions(), merger: null };
  const state = { tab: 'ts', ts: { ...defaults.ts }, lbo: { ...defaults.lbo }, merger: null, role: 'acquirer', cp: null };

  section.innerHTML = `
    <header class="bilanz-head">
      <nav class="bilanz-tabs" role="tablist">
        <button type="button" class="bilanz-tab is-active" data-tab="ts" role="tab">3-Statement</button>
        <button type="button" class="bilanz-tab" data-tab="lbo" role="tab">LBO</button>
        <button type="button" class="bilanz-tab" data-tab="merger" role="tab">Merger</button>
      </nav>
      <span class="bilanz-stichtag"></span>
    </header>
    <div class="model-pane" data-pane="ts">
      <p class="model-lede">GuV, Bilanz und Kapitalflussrechnung verknüpft und fortgeschrieben: jede Annahme bewegt alle drei Rechenwerke, die Bilanz geht in jedem Jahr auf. LBO und Merger bauen auf diesen Annahmen auf.</p>
      <div class="model-fields"></div>
      <div class="model-out"></div>
    </div>
    <div class="model-pane" data-pane="lbo" hidden>
      <p class="model-lede">Kauf durch einen Finanzinvestor, überwiegend fremdfinanziert: der Cashflow tilgt die Schulden, beim Exit entscheiden IRR und MOIC. Operative Annahmen kommen aus dem 3-Statement-Modell.</p>
      <div class="model-fields"></div>
      <div class="model-out"></div>
    </div>
    <div class="model-pane" data-pane="merger" hidden>
      <p class="model-lede">Erhöht oder senkt die Übernahme das Ergebnis je Anteil (EPS) des Käufers? Kaufpreis, Finanzierungsmix, Synergien und Kaufpreisallokation auf Basis beider 3-Statement-Prognosen.</p>
      <div class="model-cp"></div>
      <div class="model-fields"></div>
      <div class="model-out"></div>
    </div>`;
  section.querySelector('.bilanz-stichtag').textContent = `Basis GJ ${base.year} · ${f.unit}`;

  const pane = (key) => section.querySelector(`.model-pane[data-pane="${key}"]`);
  const fieldsOf = (key) => pane(key).querySelector('.model-fields');
  const outOf = (key) => pane(key).querySelector('.model-out');
  const FIELDS = { ts: TS_FIELDS, lbo: LBO_FIELDS, merger: MERGER_FIELDS };

  const drawFields = (key) => {
    if (!state[key]) { fieldsOf(key).innerHTML = ''; return; }
    fieldsOf(key).innerHTML = fieldsHtml(FIELDS[key], state[key], defaults[key]);
  };
  const render = () => ({ ts: renderTs, lbo: renderLbo, merger: renderMerger }[state.tab])();
  for (const key of ['ts', 'lbo', 'merger']) {
    bindFields(fieldsOf(key), () => state[key], () => defaults[key], render);
  }

  section.addEventListener('click', (ev) => {
    const tab = ev.target.closest('.bilanz-tab');
    if (tab) {
      state.tab = tab.dataset.tab;
      section.querySelectorAll('.bilanz-tab').forEach((b) => b.classList.toggle('is-active', b === tab));
      section.querySelectorAll('.model-pane').forEach((p) => { p.hidden = p.dataset.pane !== state.tab; });
      render();
      return;
    }
    const reset = ev.target.closest('[data-reset]');
    if (reset) {
      const key = reset.dataset.reset;
      state[key] = { ...defaults[key] };
      drawFields(key);
      render();
    }
    if (ev.target.closest('[data-export]')) exportExcel();
  });

  // Workbook with all three models as they stand: this company's drivers,
  // the LBO inputs and, once a counterparty is picked, the merger.
  function exportExcel() {
    const merger = state.cp && state.merger
      ? { role: state.role, assumptions: state.merger, counterparty: state.cp }
      : null;
    const bytes = buildModelWorkbook({ company, base, ts: state.ts, lbo: state.lbo, merger });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = modelFileName(company, base);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderTs() {
    const model = projectThreeStatement(base, state.ts);
    const cols = [...model.actuals, ...model.years];
    outOf('ts').innerHTML = `
      ${toolbar(f, 'ts', {
        ok: model.balanced,
        text: model.balanced ? '✓ Bilanz ausgeglichen in allen Planjahren' : `Bilanz nicht ausgeglichen (max. Differenz ${f.amt(model.maxCheck)})`,
      }, base.warnings)}
      ${gridTable(cols, threeStatementRows(cols, f))}
      <p class="model-note">A = Ist laut Jahresabschluss, E = Plan. Working-Capital-Tage auf Umsatzbasis ·
        Zinsen auf Durchschnittsbeständen, Zirkularität iterativ gelöst · übriges Finanzergebnis konstant ·
        Finanzanlagen, Konzernsalden und Restposten konstant · Revolver deckt Unterschreitungen der Mindestkasse.</p>`;
  }

  function renderLbo() {
    const r = runLbo(base, state.ts, state.lbo);
    if (r.error) { outOf('lbo').innerHTML = `<p class="model-empty">${esc(r.error)}</p>`; return; }
    const { entry, exit, returns, model } = r;
    const irrCls = !fin(returns.irr) ? '' : returns.irr >= 0.2 ? 'good' : returns.irr >= 0.12 ? 'warn' : 'bad';
    const pctOf = (x) => f.pct(r.total ? x / r.total : null);
    const years = model.years;
    const row = rowMaker(years);
    const tranches = years[0].debt.tranches;
    const debtRows = [
      { section: 'Operativ (aus 3-Statement)' },
      row('Umsatzerlöse', (y) => y.is.revenue, f.amt),
      row('EBITDA', (y) => y.is.ebitda, f.amt, 'strong'),
      row('Cash-Zinsen', (y) => -y.debt.cashInterest, f.amt),
      row('Free Cashflow nach Zinsen', (y) => y.cf.fcf, f.amt, 'sub'),
      ...tranches.flatMap((t, k) => [
        { section: t.label },
        row('Anfangsbestand', (y) => y.debt.tranches[k].open, f.amt),
        row('+ PIK-Zinsen', (y) => y.debt.tranches[k].pik, f.amt, '', { hideIfZero: true }),
        row('− Pflichttilgung', (y) => -y.debt.tranches[k].mandatory, f.amt, '', { hideIfZero: true }),
        row('− Cash Sweep', (y) => -y.debt.tranches[k].sweep, f.amt, '', { hideIfZero: true }),
        row('Endbestand', (y) => y.debt.tranches[k].close, f.amt, 'sub'),
        row('Zinsaufwand', (y) => y.debt.tranches[k].interest, f.amt, 'muted'),
      ]),
      ...(years.some((y) => y.debt.revolver.close > 0.5 || y.debt.revolver.draw > 0.5) ? [
        { section: 'Revolver' },
        row('Ziehung', (y) => y.debt.revolver.draw, f.amt),
        row('Rückführung', (y) => -y.debt.revolver.repay, f.amt),
        row('Endbestand', (y) => y.debt.revolver.close, f.amt, 'sub'),
      ] : []),
      { section: 'Kreditkennzahlen' },
      row('Gesamtverschuldung', (y) => y.bs.debt + y.bs.revolver, f.amt, 'strong'),
      row('Kasse', (y) => y.bs.cash, f.amt),
      { label: 'Net Debt / EBITDA', cells: r.credit.map((c) => f.mult(c.netDebtEbitda)) },
      { label: 'EBITDA / Cash-Zinsen', cells: r.credit.map((c) => f.mult(c.interestCoverage)) },
      { label: 'Schulden abgebaut (kumuliert)', cells: r.credit.map((c) => f.pct(c.paidDown)) },
    ];
    const pfCols = [{ label: 'Closing', actual: true, bs: model.opening }, ...years];
    const s = r.sensitivity;

    outOf('lbo').innerHTML = `
      ${toolbar(f, 'lbo', {
        ok: model.balanced,
        text: model.balanced ? '✓ Pro-forma-Bilanz ausgeglichen (Closing + alle Jahre)' : `Bilanz nicht ausgeglichen (max. Differenz ${f.amt(model.maxCheck)})`,
      }, r.warnings)}
      ${kpis([
        ['IRR', f.pct(returns.irr), irrCls, `Exit ${exit.year}`],
        ['MOIC', f.mult(returns.moic), irrCls],
        ['Sponsor-Eigenkapital', f.kpiAmt(entry.sponsorEquity), '', `${f.pct(entry.sponsorEquity / r.total)} der Mittel`],
        ['Exit-Eigenkapital', f.kpiAmt(exit.equity)],
        ['Enterprise Value Entry', f.kpiAmt(entry.ev), '', `${f.mult(state.lbo.entryMultiple)} EBITDA ${f.amt(entry.ebitda)}`],
        ['Leverage Entry', f.mult(entry.leverage), '', 'Fremdkapital / EBITDA'],
      ])}
      <div class="model-grid-2">
        <div>
          <h4 class="model-h">Mittelherkunft (Sources)</h4>
          ${simpleTable([
            ...r.sources.map((x) => [x.label, f.amt(x.amount), x.multiple != null ? f.mult(x.multiple) : '', pctOf(x.amount)]),
            ['Summe', f.amt(r.total), f.mult(r.total / entry.ebitda), f.pct(1), { cls: 'total' }],
          ], ['', f.unit, 'x EBITDA', '%'])}
        </div>
        <div>
          <h4 class="model-h">Mittelverwendung (Uses)</h4>
          ${simpleTable([
            ...r.uses.map((x) => [x.label, f.amt(x.amount), f.mult(x.amount / entry.ebitda), pctOf(x.amount)]),
            ['Summe', f.amt(r.total), f.mult(r.total / entry.ebitda), f.pct(1), { cls: 'total' }],
          ], ['', f.unit, 'x EBITDA', '%'])}
        </div>
      </div>
      <h4 class="model-h">Tilgungsplan</h4>
      ${gridTable(years, debtRows)}
      <div class="model-grid-2">
        <div>
          <h4 class="model-h">Exit &amp; Rendite</h4>
          ${simpleTable([
            [`EBITDA ${exit.year}`, f.amt(exit.ebitda)],
            ['× Exit-Multiple', f.mult(state.lbo.exitMultiple)],
            ['= Enterprise Value Exit', f.amt(exit.ev), { cls: 'sub' }],
            ['− Net Debt bei Exit', f.amt(-exit.netDebt)],
            ['= Eigenkapital Exit', f.amt(exit.equity), { cls: 'total' }],
            ['Sponsor-Eigenkapital Entry', f.amt(entry.sponsorEquity)],
            ['MOIC', f.mult(returns.moic)],
            ['IRR', f.pct(returns.irr), { cls: 'total' }],
          ])}
        </div>
        <div>
          <h4 class="model-h">Wertbeitrag (Entry-EK → Exit-EK)</h4>
          ${bars(r.valueCreation, f, 'Wertzuwachs Eigenkapital')}
        </div>
      </div>
      <h4 class="model-h">IRR-Sensitivität</h4>
      ${sensitivityTable({
        rows: s.rows, cols: s.cols, values: s.irr, rowLabel: 'Entry', colLabel: 'Exit',
        fmtRow: f.mult, fmtCol: f.mult, fmtCell: f.pct, base: [state.lbo.entryMultiple, state.lbo.exitMultiple],
        classify: (v) => (!fin(v) ? '' : v >= 0.2 ? 'good' : v >= 0.12 ? 'warn' : 'bad'),
      })}
      <details class="model-details">
        <summary>Pro-forma-3-Statement des LBO</summary>
        ${gridTable(pfCols, threeStatementRows(pfCols, f))}
      </details>
      <p class="model-note">Cash-free/debt-free: der Käufer zahlt den EV, bestehende Bankschulden und Anleihen werden abgelöst,
        übernommene Kasse finanziert mit. Goodwill = EV − (Buch-EK + Net Debt), Transaktionskosten als Aufwand bei Closing.
        Keine Ausschüttungen während der Haltedauer; Senior nimmt den Cash Sweep, Mezzanine endfällig. IRR-Ampel: ≥ 20 % grün, ≥ 12 % gelb.</p>`;
  }

  // ── Merger: counterparty picker + model ──
  const cpWrap = pane('merger').querySelector('.model-cp');
  function drawPicker() {
    const name = esc(company.legalName || company.nationalId);
    const cpName = state.cp ? esc(state.cp.company.legalName || state.cp.company.nationalId) : null;
    cpWrap.innerHTML = `
      <div class="model-cp-row">
        <label class="model-cp-role">Diese Firma ist
          <select data-role>
            <option value="acquirer"${state.role === 'acquirer' ? ' selected' : ''}>Käufer</option>
            <option value="target"${state.role === 'target' ? ' selected' : ''}>Zielunternehmen</option>
          </select>
        </label>
        <form class="model-cp-search">
          <input type="search" placeholder="${state.role === 'acquirer' ? 'Zielunternehmen' : 'Käufer'} suchen — Name oder Registernummer" autocomplete="off">
          <button type="submit">Suchen</button>
        </form>
      </div>
      ${state.cp ? `<p class="model-cp-pair"><span>Käufer</span> <strong>${state.role === 'acquirer' ? name : cpName}</strong>
        <span>Ziel</span> <strong>${state.role === 'acquirer' ? cpName : name}</strong></p>` : ''}
      <p class="model-cp-status" aria-live="polite"></p>
      <ul class="model-cp-results"></ul>`;
  }
  drawPicker();

  const cpStatus = (msg) => { cpWrap.querySelector('.model-cp-status').textContent = msg; };
  const self = () => ({ base, assumptions: state.ts });
  const parties = () => (state.role === 'acquirer'
    ? { acq: self(), tgt: state.cp }
    : { acq: state.cp, tgt: self() });
  const resetMerger = () => {
    if (!state.cp) { defaults.merger = null; state.merger = null; return; }
    const { acq, tgt } = parties();
    defaults.merger = defaultMergerAssumptions(acq, tgt);
    state.merger = { ...defaults.merger };
  };

  cpWrap.addEventListener('change', (ev) => {
    if (!ev.target.matches('[data-role]')) return;
    state.role = ev.target.value;
    resetMerger();
    drawPicker();
    drawFields('merger');
    renderMerger();
  });
  cpWrap.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = cpWrap.querySelector('input[type="search"]').value.trim();
    if (!q) return;
    const list = cpWrap.querySelector('.model-cp-results');
    list.innerHTML = '';
    cpStatus('Suche…');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(company.country)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Suche fehlgeschlagen');
      const hits = (data.results || []).flatMap((g) => g.hits || [])
        .filter((h) => !(h.country === company.country && canon(h.nationalId) === canon(company.nationalId)))
        .sort((a, b) => (a.latestFinancials ? 0 : 1) - (b.latestFinancials ? 0 : 1))
        .slice(0, 8);
      cpStatus(hits.length ? '' : 'Keine Treffer.');
      list.innerHTML = hits.map((h, i) => `
        <li><button type="button" data-hit="${i}">
          <span class="model-cp-name">${esc(h.legalName || '(ohne Namen)')}</span>
          <span class="model-cp-meta">${esc(h.country)} · ${esc(h.nationalId)}${h.latestFinancials?.umsatzerloese != null ? ` · Umsatz ${esc(f.amtU(h.latestFinancials.umsatzerloese))}` : ''}</span>
        </button></li>`).join('');
      list.onclick = (e) => {
        const btn = e.target.closest('[data-hit]');
        if (btn) pickCounterparty(hits[Number(btn.dataset.hit)]);
      };
    } catch (err) {
      cpStatus(`Fehler: ${err.message}`);
    }
  });

  async function pickCounterparty(hit) {
    cpWrap.querySelector('.model-cp-results').innerHTML = '';
    cpStatus(`Lade Jahresabschlüsse von ${hit.legalName || hit.nationalId}…`);
    try {
      const res = await fetch(`/api/company/${encodeURIComponent(hit.country)}/${encodeURIComponent(hit.nationalId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Nicht gefunden');
      const cpBase = buildBase(data.financials || [], { country: hit.country });
      if (cpBase.error) { cpStatus(`${data.company?.legalName || hit.legalName}: ${cpBase.error}`); return; }
      state.cp = { company: data.company || hit, base: cpBase, assumptions: defaultAssumptions(cpBase) };
      resetMerger();
      drawPicker();
      drawFields('merger');
      renderMerger();
    } catch (err) {
      cpStatus(`Fehler: ${err.message}`);
    }
  }

  function renderMerger() {
    const out = outOf('merger');
    if (!state.cp) {
      out.innerHTML = `<p class="model-empty">Gegenpartei wählen: Suche oben nach dem ${state.role === 'acquirer' ? 'Zielunternehmen' : 'Käufer'}. Beide Firmen brauchen einen Jahresabschluss mit Umsatz und Bilanz.</p>`;
      return;
    }
    const { acq, tgt } = parties();
    const r = runMerger(acq, tgt, state.merger);
    if (r.error) { out.innerHTML = `<p class="model-empty">${esc(r.error)}</p>`; return; }
    const ys = r.years, first = ys[0], last = ys[ys.length - 1];
    const accCls = (v) => (!fin(v) ? '' : v >= 0 ? 'good' : 'bad');
    const accText = (v) => (fin(v) ? `${v >= 0 ? '+' : ''}${PCT.format(v)}` : 'n/a');
    const row = rowMaker(ys);
    const fin2 = r.financing;

    const accretionRows = [
      { section: 'Pro-forma-Ergebnis' },
      row('Jahresüberschuss Käufer', (y) => y.acqNetIncome, f.amt),
      row('Jahresüberschuss Ziel', (y) => y.tgtNetIncome, f.amt),
      row('+ Synergien', (y) => y.synergies, f.amt),
      row('− Integrationskosten', (y) => y.integrationCosts, f.amt, '', { hideIfZero: true }),
      row('− Entgangene Zinsen auf Kasse', (y) => y.foregoneInterest, f.amt, '', { hideIfZero: true }),
      row('− Zinsen Akquisitionsfinanzierung', (y) => y.debtInterest, f.amt, '', { hideIfZero: true }),
      row('− Abschreibung stille Reserven', (y) => y.writeUpAmort, f.amt, '', { hideIfZero: true }),
      row('± Steuereffekt der Anpassungen', (y) => y.taxOnAdjustments, f.amt),
      row('Pro-forma-Jahresüberschuss', (y) => y.pfNetIncome, f.amt, 'total'),
      { section: 'Ergebnis je Anteil' },
      row('Anteile Käufer (standalone)', (y) => y.shares, f.int),
      row('Anteile pro forma', (y) => y.pfShares, f.int),
      row('EPS standalone', (y) => y.eps, f.eps),
      row('EPS pro forma', (y) => y.pfEps, f.eps, 'strong'),
      { label: 'Accretion / Dilution', cls: 'total', cells: ys.map((y) => accText(y.accretion)), cellCls: ys.map((y) => accCls(y.accretion)) },
      row('Break-even-Synergien (vor Steuern)', (y) => y.breakEvenSynergies, f.amt, 'muted'),
    ];

    const closingCols = [{ label: 'Käufer' }, { label: 'Ziel' }, { label: 'Anpassungen' }, { label: 'Pro forma' }];
    const closingRows = [
      { section: 'Aktiva' },
      ...r.closing.rows.slice(0, 7).map((x) => ({ label: x.label, cls: x.cls || '', cells: [x.acq, x.tgt, x.adj, x.pf].map(f.amt) })),
      { section: 'Passiva' },
      ...r.closing.rows.slice(7).map((x) => ({ label: x.label, cls: x.cls || '', cells: [x.acq, x.tgt, x.adj, x.pf].map(f.amt) })),
      { label: 'Bilanzcheck (Aktiva − Passiva)', cls: 'check', cells: ['', '', '', Math.abs(r.closing.check) < 1 ? '✓ 0' : f.amt(r.closing.check)], cellCls: ['', '', '', Math.abs(r.closing.check) < 1 ? 'ok' : 'bad'] },
    ];

    const s = r.sensitivity;
    out.innerHTML = `
      ${toolbar(f, 'merger', {
        ok: Math.abs(r.closing.check) < 1,
        text: Math.abs(r.closing.check) < 1 ? '✓ Pro-forma-Bilanz bei Closing ausgeglichen' : `Closing-Bilanz nicht ausgeglichen (${f.amt(r.closing.check)})`,
      }, r.warnings)}
      ${kpis([
        [`EPS-Effekt ${first.label}`, accText(first.accretion), accCls(first.accretion), first.accretion >= 0 ? 'accretive' : 'dilutive'],
        [`EPS-Effekt ${last.label}`, accText(last.accretion), accCls(last.accretion), last.accretion >= 0 ? 'accretive' : 'dilutive'],
        [`Break-even-Synergien ${first.label}`, f.kpiAmt(first.breakEvenSynergies), '', `vs. ${f.amt(first.synergies)} geplant`],
        ['Kaufpreis (EV)', f.kpiAmt(r.price.ev), '', `${f.mult(r.price.offerMultiple)} EBITDA · KGV ${f.mult(r.price.impliedPe)}`],
        ['Net Debt / EBITDA pro forma', f.mult(r.credit.pfNetDebtEbitda), r.credit.pfNetDebtEbitda > 4 ? 'bad' : r.credit.pfNetDebtEbitda > 3 ? 'warn' : '', `Käufer vorher ${f.mult(r.credit.acqNetDebtEbitda)}`],
        fin2.newShares > 0 ? ['Anteil Alt-Eigentümer Ziel', f.pct(fin2.newShares / fin2.pfShares), '', `${f.int(fin2.newShares)} neue Anteile`] : null,
      ])}
      ${gridTable(ys, accretionRows)}
      <div class="model-grid-2">
        <div>
          <h4 class="model-h">Kaufpreis &amp; Finanzierung</h4>
          ${simpleTable([
            ['EBITDA Ziel (LTM)', f.amt(r.price.tgtEbitda)],
            ['× Angebots-Multiple', f.mult(r.price.offerMultiple)],
            ['= Enterprise Value', f.amt(r.price.ev), { cls: 'sub' }],
            ['− Net Debt Ziel', f.amt(-r.price.tgtNetDebt)],
            ['= Kaufpreis Eigenkapital', f.amt(r.price.equityPrice), { cls: 'total' }],
            [`Kasse (${f.pct(fin2.mix.cash)})`, f.amt(fin2.cashUsed)],
            [`Neue Aktien (${f.pct(fin2.mix.stock)})`, f.amt(fin2.stockIssued)],
            [`Neue Schulden (${f.pct(fin2.mix.debt)})`, f.amt(fin2.newDebt)],
            ['Transaktionskosten (aus Kasse)', f.amt(r.price.fees)],
            ['Aktienkurs Käufer (KGV × EPS)', f.eps(fin2.sharePrice)],
          ])}
        </div>
        <div>
          <h4 class="model-h">Kaufpreisallokation</h4>
          ${simpleTable([
            ['Kaufpreis Eigenkapital', f.amt(r.ppa.equityPrice)],
            ['− Buch-Eigenkapital Ziel', f.amt(-r.ppa.bookEquity)],
            ['= Unterschiedsbetrag', f.amt(r.ppa.excess), { cls: 'sub' }],
            ['− Aufgedeckte stille Reserven', f.amt(-r.ppa.writeUp)],
            ['+ Latente Steuern darauf', f.amt(r.ppa.dtl)],
            ['= Goodwill', f.amt(r.ppa.goodwill), { cls: 'total' }],
            ['Abschreibung stille Reserven p. a.', f.amt(r.ppa.writeUpAmort)],
          ])}
          <h4 class="model-h">Beitragsanalyse ${esc(first.label)}</h4>
          <div class="model-contrib">
            ${r.contribution.map((c) => {
              const tot = c.acq + c.tgt;
              const share = tot > 0 && c.acq >= 0 && c.tgt >= 0 ? c.acq / tot : null;
              return `<div class="model-contrib-row"><span>${esc(c.label)}</span>
                ${share == null ? '<span class="model-contrib-na">n/a</span>' : `<span class="model-contrib-bar"><span style="width:${(share * 100).toFixed(1)}%"></span></span>`}
                <span class="num">${share == null ? '' : `${PCT.format(share)} / ${PCT.format(1 - share)}`}</span></div>`;
            }).join('')}
            <p class="model-note">Käufer / Ziel — Anteile pro forma zeigen die Eigentümerstruktur nach Aktientausch.</p>
          </div>
        </div>
      </div>
      <h4 class="model-h">Kombinierte Bilanz bei Closing</h4>
      ${gridTable(closingCols, closingRows)}
      <h4 class="model-h">Sensitivität EPS-Effekt ${esc(first.label)}</h4>
      ${sensitivityTable({
        rows: s.rows, cols: s.cols, values: s.accretion, rowLabel: 'Angebot', colLabel: 'Aktienanteil',
        fmtRow: f.mult, fmtCol: (c) => PCT.format(c), fmtCell: accText,
        base: [state.merger.offerMultiple, fin2.mix.stock], classify: accCls,
      })}
      <p class="model-note">Prognosen beider Firmen aus ihren 3-Statement-Modellen (Gegenpartei mit kalibrierten Standardannahmen).
        Synergien werden über ${state.merger.phaseIn.map((p) => PCT.format(p)).join(' / ')} eingephast; Akquisitionsschulden tilgungsfrei,
        Schulden des Ziels werden übernommen. Ohne Börsenkurs bewertet ein KGV das Eigenkapital des Käufers; der EPS-Effekt
        hängt davon ab, nicht von der normierten Anteilszahl.</p>`;
  }

  drawFields('ts');
  drawFields('lbo');
  render();
}
