#!/usr/bin/env node
// Phase-0 spike 0.4 — what does AUSZUG_V2 return?
// Fetches the Firmenbuch extract for a handful of FNs and saves the raw SOAP
// response to data/staging-at-auszug/ (cached, re-runs cost no IWG calls).
// The request shape comes from the service WSDL (fbw.wsdl): FNR, STICHTAG,
// UMFANG — UMFANG is a free string, so candidate values are probed.
//
// Usage:
//   node --env-file=.env scripts/spike-at-auszug.mjs <FNR> [UMFANG] [STICHTAG] [v2|v1|v0]
//   node --env-file=.env scripts/spike-at-auszug.mjs --analyse

import https from 'node:https';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const HOST = 'justizonline.gv.at';
const PATH = '/jop/api/at.gv.justiz.fbw/ws';
const STAGING_DIR = 'data/staging-at-auszug';

function soapPost(xml) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(xml, 'utf8');
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: {
        'X-API-KEY': process.env.FIRMENBUCH_TOKEN,
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': body.length,
        'User-Agent': 'Kontur/0.2',
      },
      timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// The WSDL exposes three generations of the same operation.
const OPERATIONS = {
  v2: { ns: 'ns://firmenbuch.justiz.gv.at/Abfrage/v2/AuszugRequest', root: 'AUSZUG_V2_REQUEST' },
  v1: { ns: 'ns://firmenbuch.justiz.gv.at/Abfrage/v1/AuszugRequest', root: 'AUSZUG_V1_REQUEST' },
  v0: { ns: 'ns://firmenbuch.justiz.gv.at/Abfrage/AuszugRequest', root: 'AUSZUGREQUEST' },
};

function envelope(fnr, umfang, stichtag, version) {
  const { ns, root } = OPERATIONS[version];
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"
  xmlns:a="${ns}">
  <soap:Header/>
  <soap:Body>
    <a:${root}>
      <a:FNR>${fnr}</a:FNR>
      <a:STICHTAG>${stichtag}</a:STICHTAG>
      <a:UMFANG>${umfang}</a:UMFANG>
    </a:${root}>
  </soap:Body>
</soap:Envelope>`;
}

async function fetchOne(fnr, umfang, stichtag, version = 'v2') {
  if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });
  const slug = umfang.toLowerCase().replace(/[^a-z]+/g, '-');
  const file = path.join(STAGING_DIR, `${fnr}__${version}__${slug}.xml`);
  if (existsSync(file)) { console.log(`[spike] cached ${file}`); return; }
  const { status, text } = await soapPost(envelope(fnr, umfang, stichtag, version));
  const fault = text.match(/<(?:\w+:)?Text[^>]*>([^<]+)</)?.[1];
  console.log(`[spike] ${fnr} "${umfang}" → HTTP ${status}, ${text.length} bytes${fault ? `, fault: ${fault}` : ''}`);
  if (status >= 200 && status < 300 && !fault) writeFileSync(file, text);
}

// Element-name inventory with example values, to see which fields exist.
function analyse() {
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  for (const f of readdirSync(STAGING_DIR).filter((x) => x.endsWith('.xml') && x.includes('__'))) {
    const tree = parser.parse(readFileSync(path.join(STAGING_DIR, f), 'utf8'));
    const seen = new Map();
    (function walk(node, trail) {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '#text') continue;
        for (const item of Array.isArray(v) ? v : [v]) {
          const p = trail.concat(k).slice(-3).join('/');
          if (!seen.has(p)) seen.set(p, typeof item === 'object' ? '' : String(item).slice(0, 60));
          walk(item, trail.concat(k));
        }
      }
    })(tree, []);
    console.log(`\n## ${f} (${seen.size} distinct paths)`);
    for (const [p, ex] of seen) console.log(`  ${p}${ex ? `  = ${ex}` : ''}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--analyse') analyse();
else if (args[0]) await fetchOne(args[0], args[1] || 'Kurzinformation', args[2] || new Date().toISOString().slice(0, 10), args[3] || 'v2');
else console.log('usage: spike-at-auszug.mjs <FNR> [UMFANG] [STICHTAG] [v2|v1|v0] | --analyse');
