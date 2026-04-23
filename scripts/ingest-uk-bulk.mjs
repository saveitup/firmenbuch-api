#!/usr/bin/env node
// UK bulk ingest — downloads a day's Companies House accounts archive,
// parses every iXBRL/XBRL filing inside, and upserts KPIs into SQLite.
// Bypasses the PDF/OCR pipeline entirely for electronic filings (~65% of
// UK corporate accounts).
//
// Data source: https://download.companieshouse.gov.uk/Accounts_Bulk_Data-YYYY-MM-DD.zip
//   • no auth, no registration
//   • ~80 MB/day, ~10 k filings
//   • 60-day rolling availability
//
// Usage:
//   npm run ingest:uk-bulk                     # yesterday
//   npm run ingest:uk-bulk -- --date=2026-04-20
//   npm run ingest:uk-bulk -- --reset          # ignore checkpoint
//
// Idempotent. Checkpoint tracks processed filenames so re-runs skip
// already-ingested files — safe to cron nightly.

import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
  createWriteStream, readdirSync, unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';

import { upsertFinancials, upsertCompany } from '../server/normalize.js';
import { parseUkIxbrl, parseBulkFilename } from '../server/uk-ixbrl-parser.js';

// ─── Config ─────────────────────────────────────────────────────────────
const CONCURRENCY          = Number(process.env.UKBULK_CONCURRENCY || Math.max(2, (os.cpus()?.length || 4) - 1));
const CHECKPOINT_EVERY_N   = Number(process.env.UKBULK_CHECKPOINT_EVERY_N || 100);
const STAGING_DIR          = process.env.UKBULK_STAGING || 'data/staging-uk-bulk';

const LOG_DIR   = 'logs';
const LOG_PATH  = `${LOG_DIR}/ingest-uk-bulk.log`;
const CKPT_PATH = `${LOG_DIR}/ingest-uk-bulk.checkpoint.json`;
if (!existsSync(LOG_DIR))    mkdirSync(LOG_DIR, { recursive: true });
if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : ['_', s];
  }),
);
if (args.help) {
  console.log('Usage: node scripts/ingest-uk-bulk.mjs [--date=YYYY-MM-DD] [--reset] [--keep-files]');
  process.exit(0);
}

const date = args.date
  ? String(args.date)
  : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const zipUrl   = `https://download.companieshouse.gov.uk/Accounts_Bulk_Data-${date}.zip`;
const zipPath  = path.join(STAGING_DIR, `Accounts_Bulk_Data-${date}.zip`);
const extractDir = path.join(STAGING_DIR, date);

const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `${ts}  ${line}`;
  process.stdout.write(msg + '\n');
  appendFileSync(LOG_PATH, msg + '\n');
};

// ─── Checkpoint ─────────────────────────────────────────────────────────
let checkpoint = { processed: {} };
if (existsSync(CKPT_PATH) && !args.reset) {
  try { checkpoint = JSON.parse(readFileSync(CKPT_PATH, 'utf8')); }
  catch { checkpoint = { processed: {} }; }
}
let dirty = 0;
const flushCheckpoint = () => {
  try { writeFileSync(CKPT_PATH, JSON.stringify(checkpoint)); dirty = 0; }
  catch (err) { log(`checkpoint write failed: ${err.message}`); }
};
process.on('SIGINT',  () => { log('SIGINT — flushing'); flushCheckpoint(); process.exit(130); });
process.on('SIGTERM', () => { log('SIGTERM — flushing'); flushCheckpoint(); process.exit(143); });

// ─── Download ───────────────────────────────────────────────────────────
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        out.destroy();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let seen = 0, lastLogged = 0;
      res.on('data', (c) => {
        seen += c.length;
        if (total && seen - lastLogged >= 10 * 1024 * 1024) {
          log(`  downloaded ${(seen / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
          lastLogged = seen;
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
    });
    req.on('error', reject);
  });
}

// ─── Unzip ──────────────────────────────────────────────────────────────
function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const p = spawn('unzip', ['-o', '-q', zip, '-d', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}: ${err}`)));
  });
}

// ─── One file → KPI rows ────────────────────────────────────────────────
function ingestOne(filePath, filename) {
  const meta = parseBulkFilename(filename);
  if (!meta) return { skip: 'bad-filename' };
  const html = readFileSync(filePath);
  const rows = parseUkIxbrl(html, { filename });
  if (!rows.length) return { skip: 'no-kpis' };

  // Upsert a minimal company row so search-by-name works (name not present
  // in the iXBRL header for small-full format; stays null until /api/company
  // backfills). SIREN → company_number mapping via national_id.
  upsertCompany({
    country: 'UK',
    nationalId: meta.companyNumber,
    nationalIdCanon: meta.companyNumber,
    legalName: null,
    status: 'active',
    source: 'uk-bulk-ixbrl',
  });
  upsertFinancials('UK', meta.companyNumber, rows);
  return { ok: true, rows: rows.length, siren: meta.companyNumber };
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  log(`=== ingest-uk-bulk  date=${date}  concurrency=${CONCURRENCY}${args.reset ? ' [--reset]' : ''} ===`);

  if (!existsSync(zipPath)) {
    log(`downloading ${zipUrl}`);
    try { await download(zipUrl, zipPath); }
    catch (err) { log(`download failed: ${err.message}`); process.exit(1); }
  } else {
    log(`using cached ${zipPath}`);
  }

  log(`unzipping → ${extractDir}`);
  await unzip(zipPath, extractDir);
  const files = readdirSync(extractDir).filter((f) => /\.(html|xml)$/i.test(f));
  log(`${files.length} iXBRL/XBRL files extracted`);

  if (!args.reset) {
    const before = files.length;
    const filtered = files.filter((f) => !checkpoint.processed[f]);
    const skipped = before - filtered.length;
    files.length = 0;
    files.push(...filtered);
    if (skipped) log(`checkpoint skipped ${skipped} already-processed files`);
  }

  let cursor = 0, ok = 0, err = 0, skipped = 0, totalRows = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < files.length) {
      const i = cursor++;
      const name = files[i];
      try {
        const r = ingestOne(path.join(extractDir, name), name);
        if (r.skip) { skipped++; checkpoint.processed[name] = { status: r.skip }; }
        else if (r.ok) { ok++; totalRows += r.rows; checkpoint.processed[name] = { status: 'ok', siren: r.siren, rows: r.rows }; }
      } catch (e) {
        err++;
        checkpoint.processed[name] = { status: 'err', msg: e.message.slice(0, 200) };
      }
      if (++dirty >= CHECKPOINT_EVERY_N) flushCheckpoint();
      if ((i + 1) % 500 === 0) {
        const s = (Date.now() - t0) / 1000;
        log(`-- progress ${i + 1}/${files.length}  ok=${ok} skip=${skipped} err=${err}  ${s.toFixed(0)}s (${((i + 1) / s).toFixed(1)}/s) --`);
      }
    }
  }));
  flushCheckpoint();

  // Clean up extracted HTMLs so we don't accumulate hundreds of thousands
  // of files on disk across runs. Keep the ZIP for resumability.
  if (!args['keep-files']) {
    for (const f of readdirSync(extractDir)) {
      try { unlinkSync(path.join(extractDir, f)); } catch { /* ignore */ }
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  log(`=== done: ok=${ok} (${totalRows} KPI rows), skipped=${skipped}, err=${err} / ${files.length} in ${secs}s ===`);
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
