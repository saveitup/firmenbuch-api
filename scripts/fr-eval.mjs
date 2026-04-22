// FR adapter evaluation harness. Fetches /api/company/FR/{SIREN} for a
// fixed sample and computes two metrics per user's target:
//   • KPI-depth  — avg fraction of 5 KPIs populated per successful SIREN
//   • Coverage   — fraction of SIRENs that returned ≥1 usable bilan
// Both must clear 90% per spec.

const SIRENS = [
  { name: 'LVMH',         id: '775670417' },
  { name: "L'Oréal",      id: '632012100' },
  { name: 'Danone',       id: '552032534' },
  { name: 'TotalEnergies',id: '542051180' },
  { name: 'Renault',      id: '441639465' },
  { name: 'Carrefour',    id: '652014051' },
  { name: 'Sanofi',       id: '395030844' },
  { name: 'Michelin',     id: '855200507' },
  { name: 'Orange',       id: '380129866' },
  { name: 'BNP Paribas',  id: '662042449' },
];

const BASE = 'http://localhost:3456';
const KPIS = ['umsatzerloese', 'bilanzsumme', 'eigenkapital', 'jahresergebnis', 'betriebsergebnis'];

async function fetchOne(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 900000);  // 15 min for OCR
  try {
    const r = await fetch(`${BASE}/api/company/FR/${id}`, { signal: ctrl.signal });
    return await r.json();
  } finally { clearTimeout(timer); }
}

function summarise(d) {
  if (!d || d.error) return { ok: false, error: d?.error || 'empty' };
  const fins = d.financials || [];
  if (!fins.length) return { ok: true, rows: 0, kpiAvg: 0, bestRow: null };
  const perRow = fins.map((r) => ({
    stichtag: r.stichtag,
    filled: KPIS.filter((k) => r[k] != null).length,
    row: r,
  }));
  // "Best row" per SIREN = row with the most filled KPIs (ties → most
  // recent stichtag wins). This is what a user reads in the UI, and what
  // the user-stated target ("90% KPIs filled per SIREN") is measured on.
  perRow.sort((a, b) => (b.filled - a.filled) || (b.stichtag || '').localeCompare(a.stichtag || ''));
  const best = perRow[0];
  const kpiAvg = best.filled / 5;
  return { ok: true, rows: fins.length, kpiAvg, bestRow: best.row, bestFilled: best.filled };
}

const results = [];
let totalDepthSum = 0, coveredN = 0;
for (const { name, id } of SIRENS) {
  process.stdout.write(`${name.padEnd(16)} ${id} ... `);
  const t0 = Date.now();
  let d;
  try { d = await fetchOne(id); } catch (e) { d = { error: e.message }; }
  const s = summarise(d);
  const ms = Date.now() - t0;
  if (!s.ok) {
    console.log(`❌ ${s.error} (${ms}ms)`);
  } else if (s.rows === 0) {
    console.log(`⚠ 0 rows (${ms}ms)`);
  } else {
    console.log(`✓ ${s.rows} rows, best ${s.bestFilled}/5 KPIs @ ${s.bestRow?.stichtag} (${ms}ms)`);
    totalDepthSum += s.kpiAvg;
    coveredN++;
  }
  results.push({ name, id, ...s });
}

console.log('\n=== METRICS ===');
const coverage = coveredN / SIRENS.length;
const depth = coveredN ? totalDepthSum / coveredN : 0;
console.log(`Coverage: ${(coverage*100).toFixed(1)}% (${coveredN}/${SIRENS.length} SIRENs with ≥1 bilan)`);
console.log(`KPI-depth: ${(depth*100).toFixed(1)}% (avg ${(depth*5).toFixed(2)}/5 KPIs filled per covered SIREN)`);
console.log(`Both ≥90%? ${coverage >= 0.9 && depth >= 0.9 ? 'YES ✓' : 'NO'}`);

console.log('\n=== PER-SIREN DETAIL ===');
for (const r of results) {
  if (!r.ok) { console.log(`  ${r.name}: ERROR ${r.error}`); continue; }
  if (!r.rows) { console.log(`  ${r.name}: 0 rows`); continue; }
  const row = r.bestRow;
  const fmt = (n) => n == null ? '—' : `${(n/1e6).toFixed(0)}M€`;
  console.log(`  ${r.name.padEnd(14)} ${row.stichtag}  U=${fmt(row.umsatzerloese)} B=${fmt(row.bilanzsumme)} EK=${fmt(row.eigenkapital)} JE=${fmt(row.jahresergebnis)} Betr=${fmt(row.betriebsergebnis)}  type=${row.typeBilan||'?'}`);
}
