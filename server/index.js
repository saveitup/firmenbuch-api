// Kontur — multi-country company registry. Minimal Phase-A server.
// Routes:
//   GET /api/health
//   GET /api/countries                          list registered adapters
//   GET /api/search?q=&country=                 cross-country or single-country search
//   GET /api/company/:country/:id               one company by national id
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
loadEnv();
import { migrate } from './db/index.js';
import { listCountries, getAdapter, searchAll } from './adapters/registry.js';
import { upsertCompany, readCompany, upsertFinancials, readFinancials } from './normalize.js';
import { canonId, AdapterError } from './adapters/base.js';
import { enrichWithGleif } from './adapters/gleif-enrich.js';
import { computeHealthScore } from './analytics/health-score.js';
import { computeRatios } from './analytics/ratios.js';
import { LruCache } from './cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

migrate();

const app = express();
app.use(express.json());

const searchCache = new LruCache({ max: 500, ttlMs: 5 * 60 * 1000 });
const companyCache = new LruCache({ max: 2000, ttlMs: 30 * 60 * 1000 });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, countries: listCountries().map((c) => c.id) });
});

app.get('/api/countries', (_req, res) => {
  res.json({ countries: listCountries() });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', results: [] });
  const countryFilter = req.query.country
    ? String(req.query.country).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;
  const cacheKey = `${countryFilter ? countryFilter.join(',') : '*'}::${q.toLowerCase()}`;
  try {
    const results = await searchCache.wrap(cacheKey, () => searchAll(q, countryFilter));
    for (const group of results) for (const hit of group.hits) upsertCompany(hit);
    res.json({ query: q, countries: countryFilter, results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/company/:country/:id', async (req, res) => {
  const country = req.params.country.toUpperCase();
  const adapter = getAdapter(country);
  if (!adapter) return res.status(404).json({ error: `No adapter for country ${country}` });
  const idCanon = canonId(req.params.id);
  const cacheKey = `${country}:${idCanon}`;
  try {
    const dto = await companyCache.wrap(cacheKey, async () => {
      const fresh = await adapter.getCompany(req.params.id);
      if (fresh) upsertCompany(fresh);
      return fresh;
    });
    let company = dto;
    let stale = false;
    if (!company) {
      const cached = readCompany(country, idCanon);
      if (!cached) return res.status(404).json({ error: 'Company not found' });
      company = cached;
      stale = true;
    }
    // Best-effort enrichment: officers + financials + GLEIF parent lookup.
    // Run in parallel to avoid compounding latency; failures are silent.
    // We do NOT gate on `stale` — the enrichment is keyed on (country, id),
    // not on whether the primary stammdaten were fresh. So a cached company
    // still benefits from live officers/financials on each detail click.
    let people, financials, score, documents;
    const tasks = [];
    if (typeof adapter.getPeople === 'function') {
      tasks.push(adapter.getPeople(req.params.id).then((p) => { people = p; }).catch(() => {}));
    }
    if (typeof adapter.getFinancials === 'function') {
      tasks.push(
        adapter.getFinancials(req.params.id).then((rows) => {
          if (rows?.length) upsertFinancials(country, idCanon, rows);
        }).catch(() => {}),
      );
    }
    if (typeof adapter.getDocuments === 'function') {
      tasks.push(adapter.getDocuments(req.params.id).then((docs) => { documents = docs; }).catch(() => {}));
    }
    if (!/-gleif$/.test(company.source || '')) {
      tasks.push(enrichWithGleif(company).catch(() => {}));
    }
    await Promise.all(tasks);
    // Always read the accumulated financials from DB — includes this call's
    // fresh row plus any prior years cached from previous lookups.
    financials = readFinancials(country, idCanon);
    if (financials.length) {
      score = computeHealthScore(financials);
      // Attach computed Kennzahlen to each row that has a balance sheet.
      // Ratios are cheap (pure arithmetic); recompute on every read so a
      // formula change takes effect without a data refetch.
      for (const row of financials) {
        if (row.balanceSheet) {
          row.ratios = computeRatios(row.balanceSheet, row.jahresergebnis);
        }
      }
    }
    res.json({ company, people, financials, score, documents, stale: stale || undefined });
  } catch (err) {
    if (err instanceof AdapterError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Proxy a single document download through the adapter. Currently only AT
// supports this (JustizOnline URKUNDE). Each call incurs an IWG fee, so the
// route is intentionally 1:1 with the user's click — no prefetching.
app.get('/api/company/:country/:id/document/:docKey', async (req, res) => {
  const country = String(req.params.country || '').toUpperCase();
  const adapter = getAdapter(country);
  if (!adapter || typeof adapter.downloadDocument !== 'function') {
    return res.status(404).json({ error: 'Document download not supported for this country' });
  }
  try {
    const doc = await adapter.downloadDocument(req.params.docKey);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Content-Type', doc.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.bytes);
  } catch (err) {
    if (err instanceof AdapterError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(ROOT, 'public')));

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`[kontur] listening on http://localhost:${PORT}`);
});
