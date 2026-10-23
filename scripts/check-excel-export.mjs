// Excel parity check for the model export (macOS with Microsoft Excel).
//
// Builds the workbook for two cached AT companies, strips every cached result
// (formula cells and data-table interiors), lets Excel recalculate from
// scratch with iterative calculation, and compares every cell with the
// engine's value. Exit code 1 on any mismatch or lost formula.
//
//   node scripts/check-excel-export.mjs [FN] [FN Gegenpartei] [acquirer|target]
//
// Excel is sandboxed, so the files go through its container folder.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { readCompany, readFinancials } from '../server/normalize.js';
import { buildBase, defaultAssumptions } from '../server/analytics/models/three-statement.js';
import { defaultLboAssumptions } from '../server/analytics/models/lbo.js';
import { defaultMergerAssumptions } from '../server/analytics/models/merger.js';
import { buildModelWorkbook } from '../server/analytics/models/excel-export.js';

const [selfId = '013908d', cpId = '012924g', role = 'acquirer'] = process.argv.slice(2);
const load = (id) => {
  const base = buildBase(readFinancials('AT', id), { country: 'AT' });
  if (base.error) throw new Error(`${id}: ${base.error}`);
  return { company: readCompany('AT', id) || { country: 'AT', nationalId: id, legalName: id }, base, assumptions: defaultAssumptions(base) };
};
const self = load(selfId), cp = load(cpId);
const [acq, tgt] = role === 'acquirer' ? [self, cp] : [cp, self];
const bytes = buildModelWorkbook({
  company: self.company, base: self.base, ts: self.assumptions, lbo: defaultLboAssumptions(),
  merger: { role, counterparty: cp, assumptions: defaultMergerAssumptions(acq, tgt) },
});

const work = join(homedir(), 'Library/Containers/com.microsoft.Excel/Data/kontur-check');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'kontur-xlsx-'));
const unzip = (file) => {
  const dir = mkdtempSync(join(scratch, 'x-'));
  execFileSync('unzip', ['-q', '-o', file, '-d', dir]);
  return dir;
};

// 1. Workbook without any cached result.
const original = join(work, 'export.xlsx');
writeFileSync(original, bytes);
const stripDir = unzip(original);
const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
for (const f of readdirSync(join(stripDir, 'xl/worksheets'))) {
  const p = join(stripDir, 'xl/worksheets', f);
  const xml = readFileSync(p, 'utf8');
  const tables = [...xml.matchAll(/t="dataTable" ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)]
    .map((m) => ({ c1: colNum(m[1]), r1: +m[2], c2: colNum(m[3]), r2: +m[4] }));
  writeFileSync(p, xml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)<\/c>/g, (all, col, row, attrs, inner) => {
    const inTable = tables.some((t) => colNum(col) >= t.c1 && colNum(col) <= t.c2 && +row >= t.r1 && +row <= t.r2);
    if (!inner.includes('<f') && !inTable) return all;
    return `<c r="${col}${row}"${attrs.replace(/ t="(str|e|b)"/, '')}>${inner.replace(/<v>[^<]*<\/v>/, '')}</c>`;
  }));
}
const stripped = join(work, 'stripped.xlsx');
execFileSync('zip', ['-q', '-0', '-X', '-r', stripped, '[Content_Types].xml', '_rels', 'docProps', 'xl'], { cwd: stripDir });

// 2. Excel recalculates and saves.
const recalculated = join(work, 'excel.xlsx');
execFileSync('osascript', [
  '-e', 'on run argv',
  '-e', 'tell application "Microsoft Excel"',
  '-e', 'set display alerts to false',
  '-e', 'open (POSIX file (item 1 of argv))',
  '-e', 'set wb to active workbook',
  '-e', 'calculate full',
  '-e', 'save workbook as wb filename (item 2 of argv) file format Excel XML file format',
  '-e', 'close wb saving no',
  '-e', 'end tell',
  '-e', 'end run',
  stripped, recalculated,
], { timeout: 120000 });

// 3. Cell-by-cell comparison with the engine's cached values.
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text', parseTagValue: false,
  isArray: (n) => ['sheet', 'row', 'c', 'Relationship'].includes(n),
});
function sheets(file) {
  const dir = unzip(file);
  const wb = parser.parse(readFileSync(join(dir, 'xl/workbook.xml'), 'utf8')).workbook;
  const rels = parser.parse(readFileSync(join(dir, 'xl/_rels/workbook.xml.rels'), 'utf8')).Relationships.Relationship;
  const out = {};
  for (const sh of wb.sheets.sheet) {
    const target = rels.find((r) => r.Id === sh['r:id']).Target.replace(/^\/?xl\//, '');
    const ws = parser.parse(readFileSync(join(dir, 'xl', target), 'utf8')).worksheet;
    const cells = {};
    for (const row of ws.sheetData?.row || []) {
      for (const c of row.c || []) cells[c.r] = { v: c.v ?? null, t: c.t, f: c.f != null };
    }
    out[sh.name] = cells;
  }
  return out;
}
const ours = sheets(original), excel = sheets(recalculated);
let compared = 0, mismatches = 0, lost = 0;
for (const [name, cells] of Object.entries(ours)) {
  let bad = 0;
  for (const [ref, c] of Object.entries(cells)) {
    const o = excel[name]?.[ref];
    if (c.f && !o?.f) lost++;
    if (c.v == null || c.t === 'inlineStr') continue;
    compared++;
    const a = Number(c.v), b = Number(o?.v);
    const ok = c.t === 'str' || c.t === 'e' || Number.isNaN(a)
      ? String(c.v) === String(o?.v)
      : Number.isFinite(b) && Math.abs(a - b) <= Math.max(0.01, 1e-7 * Math.abs(a));
    if (!ok) {
      bad++;
      if (mismatches + bad <= 10) console.log(`  ${name}!${ref}: engine ${c.v} · Excel ${o?.v}`);
    }
  }
  mismatches += bad;
  console.log(`${name.padEnd(22)} ${String(Object.keys(cells).length).padStart(5)} cells · ${bad} mismatches`);
}
console.log(`${compared} values compared · ${mismatches} mismatches · ${lost} formulas lost in Excel`);
rmSync(scratch, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
process.exit(mismatches || lost ? 1 : 0);
