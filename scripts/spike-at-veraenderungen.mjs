#!/usr/bin/env node
// Phase-0 spike 0.3 — Firmenbuch change feeds (VERAENDERUNGENFIRMA /
// VERAENDERUNGENURKUNDE): do they work with our token, and how much comes
// through per day? Raw responses are cached in data/staging-at-veraenderungen/
// (re-runs cost no IWG calls).
//
// Request shapes from the service WSDL (fbw.wsdl):
//   VERAENDERUNGENFIRMAREQUEST   VON, BIS, [GERICHT], [RECHTSFORM], [ARTDERVERAENDERUNG]
//   VERAENDERUNGENURKUNDEREQUEST VON, BIS
//
// Usage:
//   node --env-file=.env scripts/spike-at-veraenderungen.mjs firma   <VON> <BIS> [RECHTSFORM]
//   node --env-file=.env scripts/spike-at-veraenderungen.mjs urkunde <VON> <BIS>
//   node scripts/spike-at-veraenderungen.mjs --analyse

import https from 'node:https';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const HOST = 'justizonline.gv.at';
const PATH = '/jop/api/at.gv.justiz.fbw/ws';
const STAGING_DIR = 'data/staging-at-veraenderungen';
const JAB_DOC_CODE = '48';

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
      timeout: 120000,
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

function envelope(op, von, bis, rechtsform) {
  const [ns, root] = op === 'firma'
    ? ['ns://firmenbuch.justiz.gv.at/Abfrage/VeraenderungenFirmaRequest', 'VERAENDERUNGENFIRMAREQUEST']
    : ['ns://firmenbuch.justiz.gv.at/Abfrage/VeraenderungenUrkundeRequest', 'VERAENDERUNGENURKUNDEREQUEST'];
  const extra = rechtsform ? `\n      <v:RECHTSFORM>${rechtsform}</v:RECHTSFORM>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:v="${ns}">
  <soap:Header/>
  <soap:Body>
    <v:${root}>
      <v:VON>${von}</v:VON>
      <v:BIS>${bis}</v:BIS>${extra}
    </v:${root}>
  </soap:Body>
</soap:Envelope>`;
}

async function fetchOne(op, von, bis, rechtsform) {
  if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });
  const file = path.join(STAGING_DIR, `${op}__${von}__${bis}${rechtsform ? `__${rechtsform}` : ''}.xml`);
  if (existsSync(file)) { console.log(`[spike] cached ${file}`); return; }
  const t0 = Date.now();
  const { status, text } = await soapPost(envelope(op, von, bis, rechtsform));
  const ms = Date.now() - t0;
  const fault = text.match(/<(?:\w+:)?Text[^>]*>([^<]+)</)?.[1];
  const n = (text.match(/<(?:\w+:)?VERAENDERUNG>/g) || []).length;
  console.log(`[spike] ${op} ${von}..${bis}${rechtsform ? ` ${rechtsform}` : ''} → HTTP ${status}, ${ms} ms, ${(text.length / 1024).toFixed(0)} KB, ${n} Einträge${fault ? `, fault: ${fault}` : ''}`);
  if (status >= 200 && status < 300 && !fault) writeFileSync(file, text);
}

const count = (arr, key) => arr.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map());
const top = (m, n = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`).join(' · ');
const fnOfKey = (key) => String(key).split('_')[0].replace(/^0+/, '');

function analyse() {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true });
  for (const f of readdirSync(STAGING_DIR).filter((x) => x.endsWith('.xml')).sort()) {
    const [op, von, bis] = f.replace(/\.xml$/, '').split('__');
    const body = parser.parse(readFileSync(path.join(STAGING_DIR, f), 'utf8')).Envelope?.Body || {};
    const resp = body.VERAENDERUNGENFIRMARESPONSE || body.VERAENDERUNGENURKUNDERESPONSE || {};
    const list = [resp.VERAENDERUNG].flat().filter(Boolean);
    const days = Math.round((Date.parse(bis) - Date.parse(von)) / 86400000) + 1;
    console.log(`\n## ${f}  (${days} Tag${days > 1 ? 'e' : ''}, ${list.length} Einträge, ${(list.length / days).toFixed(0)}/Tag)`);
    console.log(`  Vollzugsdatum: ${top(count(list, (x) => x.VOLLZUGSDATUM), 10)}`);
    if (op === 'firma') {
      console.log(`  Firmen (distinct FNR): ${new Set(list.map((x) => x.FNR)).size}`);
      console.log(`  Art der Veränderung: ${top(count(list, (x) => x.ARTDERVERAENDERUNG), 15)}`);
      const details = list.flatMap((x) => [x.DETAIL].flat().filter(Boolean));
      console.log(`  Detail-Funktionen (FKEN): ${top(count(details.filter((d) => d.FKEN), (d) => d.FKEN), 12)}`);
      console.log(`  Umgründungs-Details: ${details.filter((d) => d.FNR_UEBERNEHMENDE).length}`);
    } else {
      const jab = list.filter((x) => String(x.DOKUMENTART?.CODE) === JAB_DOC_CODE);
      console.log(`  Dokumentart: ${top(count(list, (x) => `${x.DOKUMENTART?.CODE ?? '?'} ${x.DOKUMENTART?.TEXT ?? ''}`.trim()), 12)}`);
      console.log(`  Content-Type: ${top(count(list, (x) => x.CONTENTTYPE))}`);
      console.log(`  Jahresabschlüsse (Code ${JAB_DOC_CODE}): ${jab.length} Dokumente, ${new Set(jab.map((x) => fnOfKey(x.KEY))).size} Firmen, davon XML: ${jab.filter((x) => /xml/i.test(x.CONTENTTYPE)).length}, PDF: ${jab.filter((x) => /pdf/i.test(x.CONTENTTYPE)).length}`);
      if (jab[0]) console.log(`  Beispiel-KEY: ${jab[0].KEY}`);
    }
  }
}

const [op, von, bis, rechtsform] = process.argv.slice(2);
if (op === '--analyse') analyse();
else if ((op === 'firma' || op === 'urkunde') && von && bis) await fetchOne(op, von, bis, rechtsform);
else console.log('usage: spike-at-veraenderungen.mjs firma|urkunde <VON> <BIS> [RECHTSFORM] | --analyse');
