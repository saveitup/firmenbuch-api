#!/usr/bin/env node
// Batch pre-warm: discovers recent French bilan filings directly from
// INPI RNE, collects unique SIRENs, and drives them through our normal
// /api/company/FR/{SIREN} pipeline so each gets parsed + cached.
//
// After a run, every discovered SIREN renders with KPIs instantly in
// the search UI — both via the /api/search local-cache prepend and via
// the zero-cost `latestFinancials` attach.
//
// Usage:
//   1. Server läuft auf $KONTUR_BASE (default localhost:3456).
//   2. .env hat INPI_USERNAME / INPI_PASSWORD (read via node --env-file).
//   3. Run:
//        node --env-file=.env scripts/prewarm-fr.mjs
//      or (same effect via shorthand):
//        npm run prewarm:fr
//
// Tuning via env vars:
//   PREWARM_BILAN_PAGES     default 5   (100 bilans/page → ~500 filings scanned)
//   PREWARM_MAX_COMPANIES   default 200 (hard cap on warm-calls per run)
//   PREWARM_CONCURRENCY     default 3   (parallel warm-calls)
//   PREWARM_TIMEOUT_MS      default 180000  (3 min per SIREN)
//   PREWARM_SKIP_WARM       default 1   (1 = skip SIRENs already in DB)
//
// Idempotent: re-runs against the same window are cheap (cache hits).

import https from 'node:https';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';

const BASE            = process.env.KONTUR_BASE || 'http://localhost:3456';
const INPI_BASE       = 'https://registre-national-entreprises.inpi.fr';
const BILAN_PAGES     = Number(process.env.PREWARM_BILAN_PAGES     || 5);
const MAX_COMPANIES   = Number(process.env.PREWARM_MAX_COMPANIES   || 200);
const CONCURRENCY     = Number(process.env.PREWARM_CONCURRENCY     || 3);
const TIMEOUT_MS      = Number(process.env.PREWARM_TIMEOUT_MS      || 180000);
const SKIP_WARM       = Number(process.env.PREWARM_SKIP_WARM       || 1);
const INPI_USERNAME   = process.env.INPI_USERNAME;
const INPI_PASSWORD   = process.env.INPI_PASSWORD;

if (!INPI_USERNAME || !INPI_PASSWORD) {
  console.error('Error: INPI_USERNAME / INPI_PASSWORD must be set (use `node --env-file=.env …`).');
  process.exit(1);
}

if (!existsSync('logs')) mkdirSync('logs', { recursive: true });
const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `${ts}  ${line}`;
  console.log(msg);
  appendFileSync('logs/prewarm-fr.log', msg + '\n');
};

// ─── INPI helpers ───────────────────────────────────────────────────────
function inpiJson(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${INPI_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`INPI ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('INPI timeout')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function inpiLogin() {
  const data = await inpiJson('/api/sso/login', 'POST', {
    username: INPI_USERNAME,
    password: INPI_PASSWORD,
  });
  if (!data?.token) throw new Error('INPI login returned no token');
  return data.token;
}

async function fetchRecentBilanPage(token, page) {
  // /api/bilans without filter returns the global chronological feed of
  // recent filings. Newest first, 100 per page by default.
  return inpiJson(`/api/bilans?page=${page}&pageSize=100`, 'GET', null, {
    Authorization: `Bearer ${token}`,
  });
}

// ─── Our server helpers ─────────────────────────────────────────────────
async function warmOne(siren, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/company/FR/${siren}`, { signal: ctrl.signal });
    const ms  = Date.now() - t0;
    if (!res.ok) {
      log(`  FAIL ${siren}  http=${res.status}  ${ms}ms  ${label || ''}`);
      return { ok: false };
    }
    const data = await res.json();
    const fins = data?.financials || [];
    const latest = fins[fins.length - 1];
    const filled = latest
      ? ['umsatzerloese','bilanzsumme','eigenkapital','jahresergebnis','betriebsergebnis']
          .filter((k) => latest[k] != null).length
      : 0;
    const name = data?.company?.legalName || label || '';
    log(`   OK  ${siren}  ${String(fins.length).padStart(2)} rows  ${filled}/5 KPIs  ${ms.toString().padStart(5)}ms  ${name}`);
    return { ok: true, rows: fins.length, filled };
  } catch (err) {
    log(`  ERR  ${siren}  ${err.name}: ${err.message}  ${label || ''}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function listAlreadyWarm() {
  // Ask our own server: it exposes countries but not raw DB. We call the
  // /api/search endpoint with a wildcard? Not supported. Pragmatic: just
  // accept that re-runs do work (cache hits are fast anyway). Skipping
  // warm SIRENs is a nice-to-have, toggled via PREWARM_SKIP_WARM.
  // Easiest skip signal: ask the company endpoint first with a HEAD-ish
  // check? We don't expose that. So we just rely on downstream caches.
  return new Set();
}

// ─── Main ───────────────────────────────────────────────────────────────
log(`=== prewarm-fr  pages=${BILAN_PAGES}, concurrency=${CONCURRENCY}, cap=${MAX_COMPANIES} ===`);
log('Logging in to INPI…');
let token;
try { token = await inpiLogin(); }
catch (err) { log(`Login failed: ${err.message}`); process.exit(2); }
log('Login OK. Scanning recent bilans…');

const sirens = new Map(); // siren → most recent denomination from bilan metadata
for (let p = 1; p <= BILAN_PAGES; p++) {
  const list = await fetchRecentBilanPage(token, p);
  const arr = Array.isArray(list) ? list : [];
  let added = 0;
  for (const b of arr) {
    if (!b?.siren || !/^\d{9}$/.test(b.siren)) continue;
    if (sirens.has(b.siren)) continue;
    sirens.set(b.siren, b.denomination || '');
    added++;
  }
  log(`  page ${p}: +${added} new SIRENs (cumulative ${sirens.size})`);
  if (arr.length < 100) break;  // no more pages
}

const warm = SKIP_WARM ? await listAlreadyWarm() : new Set();
const targets = [...sirens.entries()]
  .filter(([s]) => !warm.has(s))
  .slice(0, MAX_COMPANIES);
log(`=== ${targets.length} SIRENs queued for pre-warming ===`);

let cursor = 0;
let okCount = 0, errCount = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < targets.length) {
    const i = cursor++;
    const [siren, name] = targets[i];
    const r = await warmOne(siren, name);
    if (r.ok) okCount++; else errCount++;
    if ((i + 1) % 25 === 0) log(`-- progress ${i + 1}/${targets.length} (ok=${okCount}, err=${errCount}) --`);
  }
}));
log(`=== done: ok=${okCount}, err=${errCount} / ${targets.length} ===`);
