#!/usr/bin/env node
// Crawls the websites verified by scripts/at-website-discovery.mjs (FN match
// or group site): up to 15 pages per domain, cleaned text into web_pages,
// deterministic signals into web_signals. Each domain is crawled once even
// when several firms share it (group sites).
//
// Usage: npm run crawl:at-web -- [--limit=N] [--recrawl] [--domain=fcp.at]
//                                [--include=name_plz] [--concurrency=16]
//   default    only domains without web_signals
//   --include  also crawl Name + PLZ matches (unverified)
//   --resignal recompute signals from stored pages and meta, no requests

import { migrate, getDb } from '../server/db/index.js';
import { createContext } from '../server/web/discovery.js';
import { crawlSite } from '../server/web/crawler.js';
import { extractSignals } from '../server/web/signals.js';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k) => process.argv.includes(`--${k}`);
const LIMIT = Number(arg('limit')) || Infinity;
const CONCURRENCY = Number(arg('concurrency')) || 16;

migrate();
const db = getDb();

const statuses = ['fn', 'gruppe', ...(arg('include') ? arg('include').split(',') : [])];
let sites = db.prepare(`
  SELECT domain, MIN(url) AS url, COUNT(*) AS firms
  FROM at_website
  WHERE status IN (${statuses.map(() => '?').join(', ')}) AND domain IS NOT NULL AND url IS NOT NULL
  GROUP BY domain
`).all(...statuses);
if (arg('domain')) sites = sites.filter((s) => s.domain === arg('domain'));
if (!flag('recrawl') && !arg('domain')) {
  const done = new Set(db.prepare('SELECT domain FROM web_signals').all().map((r) => r.domain));
  sites = sites.filter((s) => !done.has(s.domain));
}
sites = sites.slice(0, LIMIT);

const deletePages = db.prepare('DELETE FROM web_pages WHERE domain = ?');
const insertPage = db.prepare(`
  INSERT INTO web_pages (url, domain, kind, title, text, http_status) VALUES (@url, @domain, @kind, @title, @text, @status)
  ON CONFLICT(url) DO UPDATE SET domain = excluded.domain, kind = excluded.kind, title = excluded.title,
    text = excluded.text, http_status = excluded.http_status, fetched_at = datetime('now')
`);
const upsertSignals = db.prepare(`
  INSERT INTO web_signals (domain, pages, jobs, jobs_fuehrung, jobs_gf, jobs_extern, nachfolge, familienunternehmen,
    generation, gruppe_hinweis, languages_json, export_hinweis, export_laender, export_quote, zertifikate_json,
    standorte, gruendungsjahr, webshop, b2b_portal, zweite_ebene, evidence_json, meta_json)
  VALUES (@domain, @pages, @jobs, @jobs_fuehrung, @jobs_gf, @jobs_extern, @nachfolge, @familienunternehmen,
    @generation, @gruppe_hinweis, @languages_json, @export_hinweis, @export_laender, @export_quote, @zertifikate_json,
    @standorte, @gruendungsjahr, @webshop, @b2b_portal, @zweite_ebene, @evidence_json, @meta_json)
  ON CONFLICT(domain) DO UPDATE SET pages = excluded.pages, jobs = excluded.jobs, jobs_fuehrung = excluded.jobs_fuehrung,
    jobs_gf = excluded.jobs_gf, jobs_extern = excluded.jobs_extern, nachfolge = excluded.nachfolge,
    familienunternehmen = excluded.familienunternehmen, generation = excluded.generation,
    gruppe_hinweis = excluded.gruppe_hinweis, languages_json = excluded.languages_json,
    export_hinweis = excluded.export_hinweis, export_laender = excluded.export_laender, export_quote = excluded.export_quote,
    zertifikate_json = excluded.zertifikate_json, standorte = excluded.standorte, gruendungsjahr = excluded.gruendungsjahr,
    webshop = excluded.webshop, b2b_portal = excluded.b2b_portal, zweite_ebene = excluded.zweite_ebene,
    evidence_json = excluded.evidence_json, meta_json = excluded.meta_json, crawled_at = datetime('now')
`);
const store = db.transaction((domain, pages, signals, evidence, meta, { keepPages = false } = {}) => {
  if (!keepPages) {
    deletePages.run(domain);
    for (const p of pages) insertPage.run({ ...p, domain });
  }
  upsertSignals.run({
    domain, ...signals,
    languages_json: JSON.stringify(signals.languages), zertifikate_json: JSON.stringify(signals.zertifikate),
    evidence_json: JSON.stringify(evidence), meta_json: JSON.stringify(meta || {}),
  });
});

// Signal rules changed: recompute from what is stored, without requests.
if (flag('resignal')) {
  const rows = db.prepare('SELECT domain, meta_json FROM web_signals WHERE pages > 0').all();
  const pagesOf = db.prepare('SELECT url, kind, title, text FROM web_pages WHERE domain = ? ORDER BY rowid');
  for (const r of rows) {
    const meta = JSON.parse(r.meta_json || '{}');
    const { signals, evidence } = extractSignals(pagesOf.all(r.domain), meta);
    store(r.domain, null, signals, evidence, meta, { keepPages: true });
  }
  console.log(`crawl:at-web --resignal — ${rows.length} Domains neu ausgewertet`);
  process.exit(0);
}

console.log(`crawl:at-web — ${sites.length} Domains, ${CONCURRENCY} parallel`);
const ctx = createContext({ cachePages: false });
const started = Date.now();
const totals = { ok: 0, fehler: 0, seiten: 0 };
let next = 0, done = 0;

async function worker() {
  while (next < sites.length) {
    const site = sites[next++];
    try {
      const res = await crawlSite(ctx, site.url);
      if (!res.ok) {
        // Keep an empty signal row so the domain is not retried every run.
        store(site.domain, [], { ...extractSignals([], {}).signals, pages: 0 }, { fehler: [{ url: site.url, quote: res.error || `HTTP ${res.status}` }] }, {});
        totals.fehler++;
      } else {
        const { signals, evidence } = extractSignals(res.pages, res.meta);
        store(site.domain, res.pages, signals, evidence, res.meta);
        totals.ok++;
        totals.seiten += res.pages.length;
        if (arg('domain') || sites.length <= 10) console.log(site.domain, JSON.stringify(signals), '\n', JSON.stringify(evidence, null, 1).slice(0, 3000));
      }
    } catch (e) {
      totals.fehler++;
      console.error(`  ${site.domain}: ${e.message}`);
    }
    if (++done % 25 === 0) {
      console.log(`  ${done}/${sites.length} · ${Math.round((Date.now() - started) / 1000)} s · ${ctx.requests} Requests · ${JSON.stringify(totals)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));

console.log(`fertig in ${Math.round((Date.now() - started) / 1000)} s, ${ctx.requests} Requests: ${JSON.stringify(totals)}`);
const sum = db.prepare(`
  SELECT COUNT(*) AS domains, SUM(pages > 0) AS gecrawlt, ROUND(AVG(NULLIF(pages, 0)), 1) AS seiten,
    SUM(jobs > 0) AS mit_stellen, SUM(jobs_fuehrung > 0) AS fuehrung, SUM(nachfolge) AS nachfolge,
    SUM(familienunternehmen) AS familie, SUM(gruppe_hinweis) AS gruppe, SUM(export_hinweis) AS export,
    SUM(zertifikate_json <> '[]') AS zertifiziert, SUM(gruendungsjahr IS NOT NULL) AS gruendung,
    SUM(webshop) AS webshop
  FROM web_signals
`).get();
console.log('web_signals gesamt:', JSON.stringify(sum));
