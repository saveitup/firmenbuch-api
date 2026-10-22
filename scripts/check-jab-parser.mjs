#!/usr/bin/env node
// Regression + plausibility check for server/jab-parser.js against the JAb
// XMLs cached by scripts/spike-at-jab.mjs (data/staging-at-jab/). No IWG calls.
//
// Three checks per file:
//   1. Regression — every field the committed parser (git HEAD) produced is
//      unchanged, except the ones this check expects to improve (listed in
//      EXPECTED_CHANGES).
//   2. GuV identities — subtotals add up (current year to the cent, prior
//      year within TEUR rounding).
//   3. Prior-year column — `priorYear` matches the firm's separately filed
//      prior-year row in data/kontur.db, where one exists. Small deviations
//      are reported as restatements (firms may adjust Vorjahreszahlen in the
//      following filing); only gross ones — a unit/scale bug — fail.
//
// Usage: node scripts/check-jab-parser.mjs        (exit code 1 on failure)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJAb } from '../server/jab-parser.js';
import { getDb } from '../server/db/index.js';

const STAGING_DIR = 'data/staging-at-jab';
// The baseline copy lives under node_modules/ so its `fast-xml-parser` import
// resolves and it stays out of git.
const BASELINE_PATH = 'node_modules/.cache/kontur/jab-parser.head.mjs';

// Fields the BMF-GuV change is allowed to fill in or correct.
const EXPECTED_CHANGES = new Set(['umsatzerloese', 'betriebsergebnis', 'jahresergebnis']);
const NEW_FIELDS = new Set(['guv', 'priorYear']);

function loadBaseline() {
  mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, execFileSync('git', ['show', 'HEAD:server/jab-parser.js']));
  return import(pathToFileURL(path.resolve(BASELINE_PATH)).href);
}

// Flatten nested objects to dotted paths so diffs name the exact field.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const sum = (...xs) => xs.reduce((s, x) => s + (x ?? 0), 0);

// GuV subtotals must add up. `tol` absorbs TEUR rounding in the prior year.
function guvIdentities(guv, tol) {
  if (!guv) return [];
  const issues = [];
  const operating = sum(guv.umsatzerloese, guv.rohergebnis, guv.bestandsveraenderung,
    guv.aktivierteEigenleistungen, guv.sonstigeBetrieblicheErtraege, guv.materialaufwand,
    guv.personalaufwand, guv.abschreibungen, guv.sonstigeBetrieblicheAufwendungen);
  if (guv.betriebserfolg != null && !near(operating, guv.betriebserfolg, tol)) {
    issues.push(`Betriebserfolg ${guv.betriebserfolg} ≠ Σ Positionen ${operating.toFixed(2)}`);
  }
  if (guv.ergebnisVorSteuern != null && !near(sum(guv.betriebserfolg, guv.finanzerfolg), guv.ergebnisVorSteuern, tol)) {
    issues.push(`EGT ${guv.ergebnisVorSteuern} ≠ Betriebserfolg + Finanzerfolg`);
  }
  if (guv.ergebnisNachSteuern != null && !near(sum(guv.ergebnisVorSteuern, guv.steuernEinkommen), guv.ergebnisNachSteuern, tol)) {
    issues.push(`Ergebnis n. St. ${guv.ergebnisNachSteuern} ≠ EGT + Steuern`);
  }
  if (guv.ebitda == null && guv.betriebserfolg != null) issues.push('EBITDA fehlt trotz Betriebserfolg');
  return issues;
}

const baseline = await loadBaseline();
const db = getDb();
const priorRow = db.prepare(`
  SELECT bilanzsumme, eigenkapital FROM financials_yearly
  WHERE country = 'AT' AND national_id_canon = ? AND stichtag = ?
`);
const fnOf = (key) => {
  const row = db.prepare(`SELECT national_id_canon FROM financials_yearly WHERE country = 'AT' AND source_ref = ?`).get(key);
  return row?.national_id_canon ?? null;
};

const files = existsSync(STAGING_DIR) ? readdirSync(STAGING_DIR).filter((f) => f.endsWith('.xml')) : [];
if (!files.length) {
  console.error(`No cached XMLs in ${STAGING_DIR} — run scripts/spike-at-jab.mjs first.`);
  process.exit(1);
}

let failures = 0;
const changes = [];
console.log('key                    | fmt | GuV | Umsatz (R=Roh) | EBITDA         | JÜ Mio (alt → neu)           | VJ-Stichtag | VJ vs. DB');
for (const f of files) {
  const key = f.replace(/\.xml$/, '');
  const xml = readFileSync(path.join(STAGING_DIR, f), 'utf8');
  const before = baseline.parseJAb(xml);
  const after = parseJAb(xml);
  const problems = [];
  const warnings = [];

  // 1. Regression
  const a = flatten(before);
  const b = flatten(after);
  for (const [field, oldVal] of Object.entries(a)) {
    const top = field.split('.')[0];
    if (NEW_FIELDS.has(top)) continue;
    if (b[field] === oldVal) continue;
    if (EXPECTED_CHANGES.has(field)) changes.push({ key, field, oldVal, newVal: b[field] });
    else problems.push(`regression ${field}: ${oldVal} → ${b[field]}`);
  }
  for (const field of Object.keys(b)) {
    if (!(field in a) && !NEW_FIELDS.has(field.split('.')[0])) problems.push(`unexpected new field ${field}`);
  }

  // 2. GuV identities
  problems.push(...guvIdentities(after.guv, 0.01));
  const vjTol = after.priorYear?.guv ? 5000 : 0;
  problems.push(...guvIdentities(after.priorYear?.guv, vjTol).map((s) => `VJ ${s}`));

  // 3. Prior-year column vs. separately stored prior-year filing
  let vjCheck = '–';
  const fn = fnOf(key);
  if (after.priorYear && fn) {
    const ref = priorRow.get(fn, after.priorYear.stichtag);
    if (ref) {
      // TEUR values are truncated, not rounded — allow up to 1 000 €.
      const tol = after.priorYear.bilanzsumme % 1000 === 0 ? 1000 : 0.01;
      const exact = near(after.priorYear.bilanzsumme, ref.bilanzsumme, tol)
        && near(after.priorYear.eigenkapital, ref.eigenkapital, tol);
      const sameScale = Math.abs(after.priorYear.bilanzsumme / ref.bilanzsumme - 1) < 0.1;
      vjCheck = exact ? 'ok' : sameScale ? 'angepasst' : 'FEHLER';
      const detail = `VJ Bilanzsumme/EK ${after.priorYear.bilanzsumme}/${after.priorYear.eigenkapital} vs. DB ${ref.bilanzsumme}/${ref.eigenkapital}`;
      if (!exact && !sameScale) problems.push(detail);
      if (!exact && sameScale) warnings.push(`${detail} — Vorjahr im Folgeabschluss angepasst`);
    } else {
      vjCheck = 'kein DB-Jahr';
    }
  }

  const fmt = xml.includes('justiz.gv.at/Bilanzierung/v4') ? 'v4 ' : 'bmf';
  const mio = (x) => (x == null ? '—' : `${(x / 1e6).toFixed(2)} Mio`).padEnd(14);
  const je = `${before?.jahresergebnis == null ? '—' : (before.jahresergebnis / 1e6).toFixed(2)} → ${after?.jahresergebnis == null ? '—' : (after.jahresergebnis / 1e6).toFixed(2)}`;
  // Mittelgroße filers report Rohergebnis instead of Umsatz — marked "R".
  const umsatz = after?.umsatzerloese != null ? mio(after.umsatzerloese)
    : after?.guv?.rohergebnis != null ? `R ${mio(after.guv.rohergebnis)}`.slice(0, 14) : mio(null);
  console.log(`${key.slice(0, 22)} | ${fmt} | ${after?.guv ? 'ja ' : '—  '} | ${umsatz} | ${mio(after?.guv?.ebitda)} | ${je.padEnd(28)} | ${(after?.priorYear?.stichtag ?? '—').padEnd(11)} | ${vjCheck}`);
  for (const w of warnings) console.log(`    ! ${w}`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  failures += problems.length;
}

console.log(`\nErwartete Änderungen (alt → neu): ${changes.length}`);
for (const c of changes) console.log(`  ${c.key.slice(0, 22)} ${c.field}: ${c.oldVal} → ${c.newVal}`);
console.log(failures ? `\n✗ ${failures} Problem(e)` : '\n✓ alle Prüfungen bestanden');
process.exit(failures ? 1 : 0);
