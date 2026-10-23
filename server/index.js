// Kontur — multi-country company registry. Minimal Phase-A server.
// Routes:
//   GET /api/health
//   GET /api/countries                          list registered adapters
//   GET /api/search?q=&country=                 cross-country or single-country search
//   GET /api/company/:country/:id               one company by national id
//   POST /api/models/:model                     three-statement | lbo | merger
//   POST /api/models/export                     the three models as .xlsx with formulas
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
loadEnv();
import { migrate } from './db/index.js';
import { listCountries, getAdapter, searchAll } from './adapters/registry.js';
import { upsertCompany, readCompany, upsertFinancials, readFinancials, searchCompaniesLocal } from './normalize.js';
import { canonId, AdapterError } from './adapters/base.js';
import { enrichWithGleif } from './adapters/gleif-enrich.js';
import { computeHealthScore } from './analytics/health-score.js';
import { computeRatios } from './analytics/ratios.js';
import { buildBase, defaultAssumptions, projectThreeStatement } from './analytics/models/three-statement.js';
import { defaultLboAssumptions, runLbo } from './analytics/models/lbo.js';
import { defaultMergerAssumptions, runMerger } from './analytics/models/merger.js';
import { buildModelWorkbook, modelFileName } from './analytics/models/excel-export.js';
import { LruCache } from './cache.js';
import { screenAt, toCsv, EBITDA_BANDS } from './screen.js';

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

    // 1) Local-cache prepend. Upstream registers rank small shops above
    //    the flagship entities when the query matches both (e.g. INPI on
    //    "Renault"). We inject companies from our own DB that already
    //    have Kennzahlen cached at the top of their country group so the
    //    "big names" always surface first.
    const prependByCountry = new Map();   // country → DTO[]
    const targetCountries = countryFilter
      ? countryFilter
      : [...new Set(results.map((g) => g.country))];
    for (const cc of targetCountries) {
      const local = searchCompaniesLocal(q, { country: cc, onlyWithFinancials: true, limit: 5 });
      if (local.length) prependByCountry.set(cc, local);
    }

    for (const group of results) {
      const prepend = prependByCountry.get(group.country) || [];
      if (prepend.length) {
        const seen = new Set(group.hits.map((h) => h.nationalIdCanon));
        const merged = [
          ...prepend.filter((h) => !seen.has(h.nationalIdCanon)),
          ...group.hits,
        ];
        group.hits = merged;
      }

      // 2) Attach the most recent cached Kennzahlen (zero-cost DB lookup)
      //    so the frontend can render the inline KPI strip without a
      //    follow-up company fetch. Never-looked-up companies get nothing.
      for (const hit of group.hits) {
        upsertCompany(hit);
        const rows = readFinancials(hit.country, hit.nationalIdCanon);
        if (rows.length) {
          const latest = rows[rows.length - 1];
          hit.latestFinancials = {
            stichtag: latest.stichtag,
            currency: latest.currency || 'EUR',
            umsatzerloese: latest.umsatzerloese,
            bilanzsumme: latest.bilanzsumme,
            eigenkapital: latest.eigenkapital,
            jahresergebnis: latest.jahresergebnis,
            ek_quote: latest.ek_quote,
          };
        }
      }
    }
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
    // Per-task timeout. `getFinancials` can run an OCR pipeline that legally
    // takes minutes on a 250-page scanned annual report; capping it at 60 s
    // means the user gets stammdaten + officers + the document list back
    // promptly and can download the raw PDF if parsing was the bottleneck.
    // Financials the adapter already cached in SQLite remain available and
    // get rendered in `readFinancials` below regardless of this timeout.
    const withTimeout = (p, ms, label) =>
      Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(Symbol.for(label + ':timeout')), ms))]);
    const tasks = [];
    if (typeof adapter.getPeople === 'function') {
      tasks.push(
        withTimeout(adapter.getPeople(req.params.id), 15000, 'people')
          .then((p) => { if (!(typeof p === 'symbol')) people = p; })
          .catch(() => {}),
      );
    }
    if (typeof adapter.getFinancials === 'function') {
      tasks.push(
        withTimeout(adapter.getFinancials(req.params.id), 60000, 'financials')
          .then((rows) => { if (Array.isArray(rows) && rows.length) upsertFinancials(country, idCanon, rows); })
          .catch(() => {}),
      );
    }
    if (typeof adapter.getDocuments === 'function') {
      tasks.push(
        withTimeout(adapter.getDocuments(req.params.id), 15000, 'documents')
          .then((docs) => { if (!(typeof docs === 'symbol')) documents = docs; })
          .catch(() => {}),
      );
    }
    if (!/-gleif$/.test(company.source || '')) {
      tasks.push(withTimeout(enrichWithGleif(company), 10000, 'gleif').catch(() => {}));
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

// Investor screener over the AT universe (server/screen.js).
app.get('/api/screen', (req, res) => {
  try {
    res.json({ bands: EBITDA_BANDS, ...screenAt(req.query) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/screen.csv', (req, res) => {
  try {
    const { rows } = screenAt({ ...req.query, limit: 5000 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kontur-screener-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Financial models on cached financials (server/analytics/models/). The
// browser runs the same modules from /lib/models/ and recalculates locally;
// these routes are for API clients. Overrides replace the calibrated defaults
// key by key — unknown keys and mistyped values are ignored. The company's
// financials must be cached, i.e. looked up once via /api/company.
function withOverrides(defaults, overrides) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(defaults, key)) continue;
    const d = defaults[key];
    const ok = Array.isArray(d)
      ? Array.isArray(value) && value.length && value.every(Number.isFinite)
      : typeof d === 'number' ? Number.isFinite(value) : typeof value === typeof d;
    if (ok) out[key] = value;
  }
  return out;
}

function modelCompany(spec, overrides) {
  const country = String(spec?.country || '').toUpperCase();
  const base = buildBase(readFinancials(country, canonId(String(spec?.id || ''))), { country });
  if (base.error) throw Object.assign(new Error(`${country}:${spec?.id || '?'} — ${base.error}`), { status: 422 });
  return { base, assumptions: withOverrides(defaultAssumptions(base), overrides) };
}

// Excel workbook of all three models with live formulas. Body as for lbo,
// plus optional { counterparty: {country, id}, role: 'acquirer' | 'target' }
// and assumptions.counterparty / assumptions.merger for the merger sheets.
app.post('/api/models/export', (req, res) => {
  const body = req.body || {};
  const a = body.assumptions || {};
  try {
    const self = modelCompany(body, a.operating);
    const companyOf = (spec) => readCompany(String(spec.country).toUpperCase(), canonId(String(spec.id)))
      || { country: String(spec.country).toUpperCase(), nationalId: String(spec.id), legalName: String(spec.id) };
    let merger = null;
    if (body.counterparty) {
      const role = body.role === 'target' ? 'target' : 'acquirer';
      const cp = modelCompany(body.counterparty, a.counterparty);
      const [acq, tgt] = role === 'acquirer' ? [self, cp] : [cp, self];
      merger = {
        role,
        assumptions: withOverrides(defaultMergerAssumptions(acq, tgt), a.merger),
        counterparty: { company: companyOf(body.counterparty), base: cp.base, assumptions: cp.assumptions },
      };
    }
    const company = companyOf(body);
    const bytes = buildModelWorkbook({
      company, base: self.base, ts: self.assumptions, lbo: withOverrides(defaultLboAssumptions(), a.lbo), merger,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${modelFileName(company, self.base)}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/models/:model', (req, res) => {
  const body = req.body || {};
  const a = body.assumptions || {};
  try {
    let out;
    if (req.params.model === 'three-statement') {
      const c = modelCompany(body, a);
      out = { base: c.base, assumptions: c.assumptions, result: projectThreeStatement(c.base, c.assumptions) };
    } else if (req.params.model === 'lbo') {
      const c = modelCompany(body, a.operating);
      const lbo = withOverrides(defaultLboAssumptions(), a.lbo);
      out = { base: c.base, assumptions: { operating: c.assumptions, lbo }, result: runLbo(c.base, c.assumptions, lbo) };
    } else if (req.params.model === 'merger') {
      const acq = modelCompany(body.acquirer, a.acquirer);
      const tgt = modelCompany(body.target, a.target);
      const merger = withOverrides(defaultMergerAssumptions(acq, tgt), a.merger);
      out = { assumptions: { acquirer: acq.assumptions, target: tgt.assumptions, merger }, result: runMerger(acq, tgt, merger) };
    } else {
      return res.status(404).json({ error: 'Unknown model — use three-statement, lbo or merger' });
    }
    res.status(out.result.error ? 422 : 200).json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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

app.use('/lib/models', express.static(path.join(__dirname, 'analytics/models')));
app.use(express.static(path.join(ROOT, 'public')));

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`[kontur] listening on http://localhost:${PORT}`);
});
