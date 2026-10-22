#!/usr/bin/env node
// Phase-0 spike 0.2 — GuV / Vorjahr / Arbeitnehmer coverage in AT JAb XMLs.
// Downloads a small sample of Jahresabschluss XMLs via URKUNDE (cached in
// data/staging-at-jab/ so re-runs cost no IWG calls) and reports which
// sections and line items the filings actually carry.
//
// Usage:
//   node --env-file=.env scripts/spike-at-jab.mjs              # default sample
//   node --env-file=.env scripts/spike-at-jab.mjs <KEY> <KEY>  # explicit keys
//
// Output: summary on stdout, full report in logs/spike-at-jab.json.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import at from '../server/adapters/at.js';

const STAGING_DIR = 'data/staging-at-jab';
const REPORT_PATH = 'logs/spike-at-jab.json';

// Mix of mittelgroß/groß (Bilanzsumme > 6,25 Mio.) and klein filings.
// Andritz is the reference case where the current parser already finds Umsatz.
const DEFAULT_KEYS = [
  '066209_4580322410830_000___000_30_34505376_XML', // voestalpine AG
  '050935_6380512505504_000___000_30_36519307_XML', // Andritz AG (Umsatz ok)
  '088983_7290652504100_000___000_30_36481999_XML', // STRABAG SE
  '107110_5190292504340_000___000_30_36701601_XML', // ASAMER Kies- und Betonwerke GmbH
  '251948_2390082513272_000___000_30_37206846_XML', // Palmers Textil GmbH
  '110814_0070732560361_000___000_30_37479426_XML', // Horvath & Partner Management Consulting GmbH
  '072138_0070732615006_000___000_30_38444826_XML', // GRÜNER KREIS gemeinnützige GmbH
  '080472_0070752540862_000___000_30_36537243_XML', // Armstrong Consulting GmbH
  '114379_8180602600481_000___000_30_38044068_XML', // Alpengasthof Grüner GmbH
  '082412_4580132506262_000___000_30_36518801_XML', // Auto-Gusenbauer GmbH
  '454385_0070732523190_000___000_30_35850801_XML', // HS Timber Group GmbH
  '127857_3090442500879_000___000_30_35413166_XML', // Autohaus Erich Horvath GmbH (klein)
  '477351_9290152501578_000___000_30_35749497_XML', // Auto Blaser GmbH (klein)
  '290579_1990282500311_000___000_30_34889110_XML', // Auto Centro GmbH & Co KG (klein)
  '106256_7290052400860_000___000_30_32281416_XML', // Ferd. Grüner GmbH (klein)
];

// Line items the cash-flow engine needs. Matched as substrings of element
// names so we see every variant the schema uses.
const PROBES = [
  'UMSATZ', 'ROHERGEBNIS', 'MATERIAL', 'PERSONAL', 'ABSCHREIBUNG', 'ZINS',
  'STEUER', 'BETRIEBSERFOLG', 'FINANZERFOLG', 'ERGEBNIS', 'JAHRESUEBERSCHUSS',
  'ARBEITNEHMER', 'BESCHAEFTIGT', 'GROESSENKLASSE', 'KREDITINSTITUT',
  'LIEFERUNGEN', 'RESTLAUFZEIT', 'GEWINN_UND_VERLUST', 'GUV',
];

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

async function ensureDownloaded(keys) {
  if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });
  for (const key of keys) {
    const file = path.join(STAGING_DIR, `${key}.xml`);
    if (existsSync(file)) continue;
    const doc = await at.downloadDocument(key);
    if (!doc) { console.warn(`[spike] no content for ${key}`); continue; }
    writeFileSync(file, doc.bytes);
    console.log(`[spike] downloaded ${key} (${doc.bytes.length} bytes)`);
  }
}

function formatOf(xml) {
  if (xml.includes('justiz.gv.at/Bilanzierung/v4')) return 'v4';
  if (xml.includes('finanzonline.bmf.gv.at/bilanz')) return 'bmf-legacy';
  return 'unknown';
}

// Depth-first walk yielding [tagPath, node] for every element.
function* walk(node, trail = []) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_') || k === '#text') continue;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      const p = [...trail, k];
      yield [p, item];
      yield* walk(item, p);
    }
  }
}

function analyse(file) {
  const xml = readFileSync(file, 'utf8');
  const tree = parser.parse(xml);
  const tags = new Set();
  const probeHits = {};
  let posten = 0, postenWithVj = 0;
  const units = {};
  for (const [p, node] of walk(tree)) {
    const tag = p[p.length - 1];
    tags.add(tag);
    for (const probe of PROBES) {
      if (tag.includes(probe)) (probeHits[probe] ||= new Set()).add(p.slice(-3).join('/'));
    }
    if (tag === 'POSTENZEILE' && node && typeof node === 'object') {
      posten++;
      const vj = node.BETRAG_VJ ?? node.BETRAG_VORJAHR;
      if (vj != null && vj !== '') postenWithVj++;
    }
    if (tag === 'DARSTELLUNG_EINGEREICHT' || tag === 'DARSTELLUNG_VORHERGEHEND') {
      units[tag] = node?.EINHEIT ?? node;
    }
  }
  // Two-level skeleton below the envelope shows which sections exist.
  const env = tree.UEBERMITTLUNG || {};
  const skeleton = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('@_')) continue;
    skeleton[k] = v && typeof v === 'object' ? Object.keys(v).filter((x) => !x.startsWith('@_')) : [];
  }
  return {
    file: path.basename(file),
    format: formatOf(xml),
    bytes: xml.length,
    skeleton,
    units,
    posten,
    postenWithVj,
    probeHits: Object.fromEntries(Object.entries(probeHits).map(([k, v]) => [k, [...v]])),
    tagCount: tags.size,
  };
}

const keys = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_KEYS;
await ensureDownloaded(keys);

const files = readdirSync(STAGING_DIR).filter((f) => f.endsWith('.xml')).map((f) => path.join(STAGING_DIR, f));
const results = files.map(analyse);

if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
writeFileSync(REPORT_PATH, JSON.stringify(results, null, 2));

const byFormat = results.reduce((acc, r) => ((acc[r.format] = (acc[r.format] || 0) + 1), acc), {});
console.log(`\nFiles: ${results.length}  formats: ${JSON.stringify(byFormat)}`);
console.log('\nfile | format | posten | mit VJ | units');
for (const r of results) {
  console.log(`${r.file.slice(0, 22)} | ${r.format} | ${r.posten} | ${r.postenWithVj} | ${JSON.stringify(r.units)}`);
}
console.log('\nProbe → files containing it');
for (const probe of PROBES) {
  const n = results.filter((r) => r.probeHits[probe]).length;
  console.log(`${probe.padEnd(20)} ${n}/${results.length}`);
}
console.log(`\nFull report: ${REPORT_PATH}`);
