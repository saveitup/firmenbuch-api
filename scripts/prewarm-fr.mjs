#!/usr/bin/env node
// FR prewarm — Kennzahlen-ingestion via the INPI RNE HTTPS API.
//
// **Important scale note:** the public `/api/bilans` endpoint ignores the
// `page`/`offset`/`pageSize` parameters and always returns the 20 most
// recently deposited bilans (confirmed 2026-04). To ingest at scale you
// need the SFTP bulk channel — see scripts/ingest-fr-sftp.mjs once you
// have credentials.
//
// For API-based ingestion the best we can do is a *rolling* strategy:
// run this script periodically (every 30–60 min via cron) and each run
// picks up whatever new filings surfaced since the last one. Over a day
// INPI publishes a few hundred to a few thousand bilans; the checkpoint
// (logs/prewarm-fr.checkpoint.json) prevents re-processing.
//
// How it works:
//   1. Log in to INPI (credentials from .env).
//   2. Read the top-20 `/api/bilans` feed (requesting more is ignored).
//   3. Skip SIRENs already warmed in a prior run via the checkpoint.
//   4. Drive each SIREN through our own /api/company/FR/{siren} pipeline,
//      which handles adapter + bilan download + layout-aware parse + OCR
//      fallback + SQLite cache.
//
// Operational niceties:
//   • Checkpoint file (logs/prewarm-fr.checkpoint.json) tracks every
//     SIREN we've attempted, so re-running resumes. Use `--reset` to
//     start fresh.
//   • SIGINT (Ctrl-C) flushes the checkpoint before exiting.
//   • Scales from a 10-entry smoke-test to "keep going for N hours"
//     by tuning the two env vars at the top.
//
// Usage:
//   npm run prewarm:fr                      # one shot, harvests whatever
//                                           # is in the current 20-item feed
//   npm run prewarm:fr -- --reset           # wipe checkpoint (re-process
//                                           # already-cached SIRENs)
//   # recommended deployment: cron every 30 min
//   # */30 * * * * cd $KONTUR_REPO && npm run prewarm:fr >> logs/cron.log 2>&1

import https from 'node:https';
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
} from 'node:fs';

const BASE            = process.env.KONTUR_BASE || 'http://localhost:3456';
const INPI_BASE       = 'https://registre-national-entreprises.inpi.fr';
// BILAN_PAGES kept for legacy tuning but pagination is a no-op on INPI's
// side; we always fetch only the first 20 items. MAX_COMPANIES caps the
// per-run warm count (mostly relevant for the first run when the feed
// contains nothing already in our cache).
const BILAN_PAGES     = Number(process.env.PREWARM_BILAN_PAGES     || 1);
const MAX_COMPANIES   = Number(process.env.PREWARM_MAX_COMPANIES   || 100);
const CONCURRENCY     = Number(process.env.PREWARM_CONCURRENCY     || 3);
const TIMEOUT_MS      = Number(process.env.PREWARM_TIMEOUT_MS      || 240000);   // 4 min/SIREN
const CHECKPOINT_EVERY_N = Number(process.env.PREWARM_CHECKPOINT_EVERY_N || 10);
const INPI_USERNAME   = process.env.INPI_USERNAME;
const INPI_PASSWORD   = process.env.INPI_PASSWORD;

if (!INPI_USERNAME || !INPI_PASSWORD) {
  console.error('Error: INPI_USERNAME / INPI_PASSWORD must be set (use `node --env-file=.env …`).');
  process.exit(1);
}

const LOG_DIR         = 'logs';
const LOG_PATH        = `${LOG_DIR}/prewarm-fr.log`;
const CHECKPOINT_PATH = `${LOG_DIR}/prewarm-fr.checkpoint.json`;
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const RESET = process.argv.includes('--reset');
const cli = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `${ts}  ${line}`;
  process.stdout.write(msg + '\n');
  appendFileSync(LOG_PATH, msg + '\n');
};

// ─── Checkpoint ─────────────────────────────────────────────────────────
// Persist a map { siren: { status, filled, tried_at } } so re-runs know
// which SIRENs are done (any status) and can resume. Write-through on
// every N successful completions plus a final flush on SIGINT/exit.
let checkpoint = { seen: {} };
if (existsSync(CHECKPOINT_PATH) && !RESET) {
  try {
    checkpoint = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8'));
    if (!checkpoint.seen) checkpoint.seen = {};
  } catch { checkpoint = { seen: {} }; }
}
let dirty = 0;
const flushCheckpoint = () => {
  try { writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint)); dirty = 0; }
  catch (err) { log(`checkpoint write failed: ${err.message}`); }
};
process.on('SIGINT',  () => { log('SIGINT — flushing checkpoint'); flushCheckpoint(); process.exit(130); });
process.on('SIGTERM', () => { log('SIGTERM — flushing checkpoint'); flushCheckpoint(); process.exit(143); });

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
    username: INPI_USERNAME, password: INPI_PASSWORD,
  });
  if (!data?.token) throw new Error('INPI login returned no token');
  return data.token;
}

async function fetchRecentBilanPage(token, page) {
  return inpiJson(`/api/bilans?page=${page}&pageSize=100`, 'GET', null, {
    Authorization: `Bearer ${token}`,
  });
}

// ─── Warm one SIREN ─────────────────────────────────────────────────────
async function warmOne(siren, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/company/FR/${siren}`, { signal: ctrl.signal });
    const ms  = Date.now() - t0;
    if (!res.ok) {
      log(`  FAIL ${siren}  http=${res.status}  ${ms}ms  ${label || ''}`);
      return { ok: false, status: `http_${res.status}` };
    }
    const data = await res.json();
    const fins = data?.financials || [];
    const latest = fins[fins.length - 1];
    const filled = latest
      ? ['umsatzerloese','bilanzsumme','eigenkapital','jahresergebnis','betriebsergebnis']
          .filter((k) => latest[k] != null).length
      : 0;
    const name = data?.company?.legalName || label || '';
    log(`   OK  ${siren}  ${String(fins.length).padStart(2)}r  ${filled}/5 KPIs  ${String(ms).padStart(6)}ms  ${name}`);
    return { ok: true, rows: fins.length, filled };
  } catch (err) {
    log(`  ERR  ${siren}  ${err.name}: ${err.message}  ${label || ''}`);
    return { ok: false, status: err.name };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
log(`=== prewarm-fr  pages=${BILAN_PAGES}, max=${MAX_COMPANIES}, conc=${CONCURRENCY}${RESET ? ' [--reset]' : ''} ===`);
log('Logging in to INPI…');
let token;
try { token = await inpiLogin(); }
catch (err) { log(`Login failed: ${err.message}`); process.exit(2); }
log('Login OK. Scanning recent bilans…');

const sirens = new Map();   // siren → most recent denomination from bilan metadata
for (let p = 1; p <= BILAN_PAGES; p++) {
  let arr = [];
  try {
    const list = await fetchRecentBilanPage(token, p);
    arr = Array.isArray(list) ? list : [];
  } catch (err) {
    log(`  page ${p}: fetch failed (${err.message}), skipping`);
    continue;
  }
  let added = 0;
  for (const b of arr) {
    if (!b?.siren || !/^\d{9}$/.test(b.siren)) continue;
    if (sirens.has(b.siren)) continue;
    sirens.set(b.siren, b.denomination || '');
    added++;
  }
  log(`  page ${p}: +${added} new SIRENs (cumulative ${sirens.size})`);
  if (arr.length < 100) break;
}

// Apply checkpoint filter. Any SIREN with a seen entry from a prior run
// is skipped regardless of outcome — re-runs can reset with --reset.
const eligible = [...sirens.entries()].filter(([s]) => !checkpoint.seen[s]);
const ckSkipped = sirens.size - eligible.length;
const targets = eligible.slice(0, MAX_COMPANIES);
const capSkipped = eligible.length - targets.length;
log(`=== ${targets.length} SIRENs queued  (checkpoint skipped ${ckSkipped}, over-cap ${capSkipped}) ===`);

if (!targets.length) {
  log('Nothing to do — all candidates already checkpointed.');
  flushCheckpoint();
  process.exit(0);
}

let cursor = 0;
let okCount = 0, errCount = 0, totalFilled = 0;
const t_start = Date.now();

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < targets.length) {
    const i = cursor++;
    const [siren, name] = targets[i];
    const r = await warmOne(siren, name);
    checkpoint.seen[siren] = {
      status: r.ok ? 'ok' : (r.status || 'err'),
      filled: r.filled ?? 0,
      tried_at: new Date().toISOString().slice(0, 19),
    };
    if (r.ok) { okCount++; totalFilled += (r.filled || 0); } else { errCount++; }
    if (++dirty >= CHECKPOINT_EVERY_N) flushCheckpoint();

    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - t_start) / 1000).toFixed(0);
      const rate = (okCount + errCount) / Math.max(1, Date.now() - t_start) * 1000;
      log(`-- progress ${i + 1}/${targets.length}  ok=${okCount}  err=${errCount}  ⌀KPI=${(totalFilled / Math.max(1, okCount)).toFixed(2)}/5  ${elapsed}s  (${rate.toFixed(2)}/s) --`);
    }
  }
}));
flushCheckpoint();
const avg = (totalFilled / Math.max(1, okCount)).toFixed(2);
log(`=== done: ok=${okCount}, err=${errCount} / ${targets.length}  ⌀ KPIs=${avg}/5 ===`);
