#!/usr/bin/env node
// Evaluation harness for the new adapters (DK, SK, EE, SI).
//
// Runs directly against the adapter modules (no HTTP server needed)
// so it can be invoked in any environment with .env credentials in
// place. For each fixture we call getCompany + getFinancials and
// compute two metrics per country:
//
//   • stammCoverage — fraction of fixtures where getCompany returned a
//                     DTO with at least a legalName
//   • kpiCoverage   — fraction of fixtures where getFinancials returned
//                     ≥ 1 row with ≥ 3 of the 5 core KPIs populated
//
// Output:
//   logs/harden-new.json      — machine-readable report (used by the
//                                harden-adapters plan loop)
//   stdout                    — markdown summary
//
// Usage:
//   node --env-file=.env scripts/eval-new-adapters.mjs
//   node --env-file=.env scripts/eval-new-adapters.mjs --country=DK
//   node --env-file=.env scripts/eval-new-adapters.mjs --fixture=custom.json

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import dk from '../server/adapters/dk.js';
import sk from '../server/adapters/sk.js';
import ee from '../server/adapters/ee.js';
import si from '../server/adapters/si.js';

const KPIS = ['umsatzerloese', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'betriebsergebnis'];
// Default per-row threshold. Adapters that can only surface a subset
// from public data (e.g. EE with Revenue + Net profit only) override
// this via `adapter.minKpisPerRow`.
const DEFAULT_MIN_KPIS_PER_ROW = 3;
const LOG_DIR = 'logs';
const REPORT_PATH = `${LOG_DIR}/harden-new.json`;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const DEFAULT_FIXTURES = {
  DK: [
    { name: 'Novo Nordisk A/S',        id: '24256790' },
    { name: 'A.P. Møller-Mærsk',       id: '22756214' },
    { name: 'Carlsberg A/S',           id: '61056416' },
    { name: 'Vestas Wind Systems',     id: '10403782' },
    { name: 'Ørsted A/S',              id: '36213728' },
  ],
  SK: [
    { name: 'Slovnaft, a.s.',                  id: '31322832' },
    { name: 'Volkswagen Slovakia, a.s.',       id: '35757442' },
    { name: 'ESET, spol. s r.o.',              id: '31333532' },
    { name: 'Slovenské elektrárne, a.s.',      id: '35829052' },
    { name: 'Kia Slovakia s. r. o.',           id: '36264911' },
  ],
  EE: [
    { name: 'Tallink Grupp AS',        id: '10238429' },
    { name: 'Swedbank AS',             id: '10060701' },
    { name: 'Eesti Energia AS',        id: '10421629' },
    { name: 'Tele2 Eesti AS',          id: '10069046' },
    { name: 'Luminor Bank AS',         id: '11315936' },
  ],
  SI: [
    { name: 'Krka, d. d., Novo mesto', id: '5043611' },
    { name: 'Petrol d.d.',             id: '5025796' },
    { name: 'Lek farmacevtska družba', id: '5045639' },
  ],
};

const ADAPTERS = { DK: dk, SK: sk, EE: ee, SI: si };

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : ['_', s];
  }),
);

const fixtures = args.fixture
  ? JSON.parse(readFileSync(args.fixture, 'utf8'))
  : DEFAULT_FIXTURES;

const countryFilter = args.country ? String(args.country).toUpperCase() : null;

function summariseKpis(rows) {
  if (!Array.isArray(rows) || !rows.length) return { rows: 0, bestFilled: 0, best: null };
  const perRow = rows.map((r) => ({
    stichtag: r.stichtag,
    filled: KPIS.filter((k) => r[k] != null).length,
    row: r,
  }));
  perRow.sort((a, b) => (b.filled - a.filled) || (b.stichtag || '').localeCompare(a.stichtag || ''));
  return { rows: rows.length, bestFilled: perRow[0].filled, best: perRow[0].row };
}

async function evalOne(adapter, fx) {
  const t0 = Date.now();
  const out = { name: fx.name, id: fx.id };
  try {
    const c = await adapter.getCompany(fx.id);
    out.stamm = c ? { legalName: c.legalName, status: c.status } : null;
  } catch (e) { out.stammError = String(e.message || e).slice(0, 300); }

  try {
    if (typeof adapter.getFinancials === 'function') {
      const rows = await adapter.getFinancials(fx.id);
      const s = summariseKpis(rows);
      out.financials = {
        rows: s.rows,
        bestFilled: s.bestFilled,
        bestStichtag: s.best?.stichtag || null,
        kpis: s.best ? Object.fromEntries(KPIS.map((k) => [k, s.best[k] ?? null])) : null,
      };
    }
  } catch (e) { out.financialsError = String(e.message || e).slice(0, 300); }

  out.durationMs = Date.now() - t0;
  return out;
}

const report = { startedAt: new Date().toISOString(), countries: {} };

for (const [cc, list] of Object.entries(fixtures)) {
  if (countryFilter && cc !== countryFilter) continue;
  const adapter = ADAPTERS[cc];
  if (!adapter) { console.error(`no adapter for ${cc}`); continue; }

  const configured = adapter.configured !== false;
  console.log(`\n=== ${cc} — ${adapter.label} ${configured ? '' : '[NOT CONFIGURED — skipping]'} ===`);

  const minKpis = adapter.minKpisPerRow ?? DEFAULT_MIN_KPIS_PER_ROW;
  const results = [];
  let stammOk = 0, kpiOk = 0;
  for (const fx of list) {
    process.stdout.write(`  ${String(fx.id).padEnd(10)}  ${fx.name.padEnd(32)} ... `);
    if (!configured) { console.log('skip'); results.push({ ...fx, skipped: 'not-configured' }); continue; }
    const r = await evalOne(adapter, fx);
    if (r.stamm?.legalName) stammOk++;
    if (r.financials?.bestFilled >= minKpis) kpiOk++;
    const kpi = r.financials?.bestFilled ?? 0;
    const stammFlag = r.stamm?.legalName ? 'S' : (r.stammError ? 'E' : '-');
    const ms = r.durationMs;
    console.log(`[${stammFlag}] kpi=${kpi}/5  (${ms}ms)${r.stammError || r.financialsError ? '  ERR' : ''}`);
    results.push(r);
  }

  const n = list.length || 1;
  const stammCov = stammOk / n;
  const kpiCov   = kpiOk / n;
  report.countries[cc] = {
    label: adapter.label,
    configured,
    fixtures: list.length,
    stammOk, kpiOk,
    stammCoverage: stammCov,
    kpiCoverage: kpiCov,
    // Unconfigured adapters (pending credentials or stub) are exempt
    // from PASS/FAIL — the plan treats them as "skipped", not FAIL.
    passes: !configured
      ? true
      : stammCov >= 0.8 && (adapter.hasFinancials ? kpiCov >= 0.6 : true),
    skipped: !configured,
    results,
  };
  const r = report.countries[cc];
  console.log(`  → stamm=${(stammCov*100).toFixed(0)}%  kpi=${(kpiCov*100).toFixed(0)}%  ${r.skipped ? 'SKIP' : (r.passes ? 'PASS' : 'FAIL')}`);
}

report.finishedAt = new Date().toISOString();
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

// Markdown summary to stdout, easy to paste into a commit/PR.
console.log('\n## Harden-New summary\n');
console.log('| Country | configured | stamm | kpi | status |');
console.log('|---|---|---|---|---|');
for (const [cc, r] of Object.entries(report.countries)) {
  const statusLabel = r.skipped ? 'SKIP' : (r.passes ? 'PASS' : 'FAIL');
  console.log(
    `| ${cc} | ${r.configured ? 'yes' : 'no'} | ${(r.stammCoverage*100).toFixed(0)}% (${r.stammOk}/${r.fixtures}) | ${(r.kpiCoverage*100).toFixed(0)}% (${r.kpiOk}/${r.fixtures}) | ${statusLabel} |`,
  );
}
console.log(`\nreport → ${path.resolve(REPORT_PATH)}`);

const allPass = Object.values(report.countries).every((r) => r.passes);
process.exit(allPass ? 0 : 1);
