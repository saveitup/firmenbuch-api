#!/usr/bin/env node
// Finds and verifies the websites of the screener's Kernband firms in the
// mandate clusters (A1–B3) — see server/web/discovery.js for the method.
// Firms are processed by operating FCF, best first; results go to
// at_website. Manual entries (method = 'manuell') are never touched.
//
// Usage: npm run discover:at-web -- [--limit=N] [--recheck] [--retry]
//                                   [--band=kern|erweitert] [--fn=055036k]
//   default   only firms without an at_website row
//   --retry   also re-check 'nicht_gefunden' and 'fehler'
//   --recheck re-check every selected firm
// Other FNs named on a site are resolved locally or via one IWG
// Kurzinformation call (FIRMENBUCH_TOKEN from .env). With BRAVE_API_KEY in
// .env, firms without an FN match on the guessed domains get one search
// query each (FN or name + Ort), whose hits are checked the same way.

import { migrate, getDb } from '../server/db/index.js';
import { screenAt } from '../server/screen.js';
import { createContext, discoverWebsite, relatedFirm, searchDomains } from '../server/web/discovery.js';
import atAdapter from '../server/adapters/at.js';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k) => process.argv.includes(`--${k}`);
const LIMIT = Number(arg('limit')) || Infinity;
const CONCURRENCY = Number(arg('concurrency')) || 12;

migrate();
const db = getDb();

let firms = screenAt({ band: arg('band') || 'kern', cluster: 'AB', sort: 'fcf', dir: 'desc', limit: 5000 }).rows;
if (arg('fn')) firms = firms.filter((r) => r.id === arg('fn'));
const existing = new Map(db.prepare('SELECT national_id_canon, status, method FROM at_website').all()
  .map((r) => [r.national_id_canon, r]));
firms = firms.filter((r) => {
  const e = existing.get(r.id);
  if (!e) return true;
  if (e.method === 'manuell') return false;
  if (flag('recheck') || arg('fn')) return true;
  return flag('retry') && ['nicht_gefunden', 'fehler'].includes(e.status);
}).slice(0, LIMIT);

const profile = db.prepare('SELECT plz, homepage FROM at_company_profile WHERE national_id_canon = ?');
const known = db.prepare(`SELECT c.legal_name AS name, p.plz FROM companies c
  LEFT JOIN at_company_profile p ON p.national_id_canon = c.national_id_canon
  WHERE c.country = 'AT' AND c.national_id_canon = ?`);

// Name and PLZ behind another FN on the site: local first, else one
// Kurzinformation call (IWG) — only for the few firms whose site names one.
const otherCache = new Map();
function describeFn(fn) {
  if (!otherCache.has(fn)) {
    otherCache.set(fn, (async () => {
      const k = known.get(fn);
      if (k?.name) return { fn, name: k.name, plz: k.plz || null };
      if (!process.env.FIRMENBUCH_TOKEN) return { fn, name: null, plz: null };
      try {
        const info = await atAdapter.getKurzinformation(fn);
        return { fn, name: info?.legalName || null, plz: info?.address?.plz || null };
      } catch { return { fn, name: null, plz: null }; }
    })());
  }
  return otherCache.get(fn);
}
const upsert = db.prepare(`
  INSERT INTO at_website (national_id_canon, status, domain, url, impressum_url, evidence, other_fns_json, source, candidates_json, method)
  VALUES (@canon, @status, @domain, @url, @impressumUrl, @evidence, @otherFns, @source, @candidates, 'auto')
  ON CONFLICT(national_id_canon) DO UPDATE SET
    status = excluded.status, domain = excluded.domain, url = excluded.url, impressum_url = excluded.impressum_url,
    evidence = excluded.evidence, other_fns_json = excluded.other_fns_json, source = excluded.source,
    candidates_json = excluded.candidates_json, checked_at = datetime('now')
  WHERE at_website.method <> 'manuell'
`);

const STATUS_RANK = { fn: 5, gruppe: 4, name_plz: 3, andere_fn: 2, blockiert: 1, nicht_gefunden: 0 };

console.log(`discover:at-web — ${firms.length} Firmen, ${CONCURRENCY} parallel${process.env.BRAVE_API_KEY ? ', Such-API an' : ''}`);
const ctx = createContext();
const counts = {};
const started = Date.now();
let done = 0, next = 0;

async function worker() {
  while (next < firms.length) {
    const r = firms[next++];
    const p = profile.get(r.id) || {};
    let res;
    try {
      res = await discoverWebsite(ctx, { canon: r.id, name: r.name, plz: p.plz, homepage: p.homepage });
      // No FN on any guessed domain: ask the search API (if configured).
      if (res.status !== 'fn' && process.env.BRAVE_API_KEY) {
        const domains = await searchDomains({ canon: r.id, name: r.name, ort: r.ort });
        if (domains.length) {
          const viaSearch = await discoverWebsite(ctx, { canon: r.id, name: r.name, plz: p.plz, candidateDomains: domains });
          if (STATUS_RANK[viaSearch.status] > STATUS_RANK[res.status]) {
            res = { ...viaSearch, candidates: [...res.candidates, ...viaSearch.candidates] };
          }
        }
      }
    } catch (e) {
      res = { status: 'fehler', domain: null, url: null, impressumUrl: null, evidence: String(e.message).slice(0, 200),
        otherFns: [], source: null, candidates: [] };
    }
    // Another FN on the site: a related firm makes it the group's website,
    // an unrelated one a namesake's domain.
    const others = await Promise.all((res.otherFns || []).slice(0, 5).map(describeFn));
    for (const o of others) o.related = Boolean(o.name) && relatedFirm({ name: r.name, plz: p.plz }, o);
    if (['andere_fn', 'name_plz'].includes(res.status) && others.some((o) => o.related)) res.status = 'gruppe';
    res.otherFns = others;
    upsert.run({ canon: r.id, ...res, otherFns: JSON.stringify(res.otherFns || []), candidates: JSON.stringify(res.candidates) });
    counts[res.status] = (counts[res.status] || 0) + 1;
    done++;
    if (arg('fn') || firms.length <= 30) {
      console.log(`  ${r.id} ${r.name.slice(0, 44).padEnd(44)} ${res.status.padEnd(14)} ${res.domain || ''}  ${res.impressumUrl || ''}`);
      if (arg('fn')) console.log(JSON.stringify(res, null, 2));
    } else if (done % 25 === 0) {
      const s = (Date.now() - started) / 1000;
      console.log(`  ${done}/${firms.length} · ${Math.round(s)} s · ${ctx.requests} Requests · ${JSON.stringify(counts)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, firms.length) }, worker));

const s = Math.round((Date.now() - started) / 1000);
console.log(`fertig in ${s} s, ${ctx.requests} Requests: ${JSON.stringify(counts)}`);
const all = db.prepare(`SELECT status, COUNT(*) n FROM at_website GROUP BY status ORDER BY n DESC`).all();
console.log('at_website gesamt:', all.map((r) => `${r.status} ${r.n}`).join(' · '));
