#!/usr/bin/env node
// FR bulk ingest via INPI SFTP server.  **Skeleton — pending credentials.**
//
// The INPI SFTP endpoint is enrolment-gated: after requesting access on
// https://www.inpi.fr/ressources/propriete-intellectuelle/acces-aux-api-et-ftp
// they issue a host + username + key that let you pull daily archives of:
//   • comptes_annuels/YYYY/MM/DD/*.zip      — bilan PDFs grouped by deposit date
//   • actes/YYYY/MM/DD/*.zip                — statute / PV / other legal docs
//   • entreprises/YYYY/MM/DD/*.json         — incremental JSON of company changes
//
// What this script does end-to-end (once credentials land):
//   1. SFTP-connect with key from SFTP_HOST / SFTP_USER / SFTP_KEY_PATH.
//   2. List the remote `comptes_annuels/` tree for a configured date
//      window (default: yesterday).
//   3. Download each zip into a local staging dir.
//   4. Unzip → yields one PDF per bilan deposit (filename carries SIREN
//      and dateCloture).
//   5. Call parseFrBilanPdf() on each PDF directly (no HTTP round-trip),
//      upsert Kennzahlen into SQLite via normalize.upsertFinancials.
//   6. Progress checkpoint in logs/ingest-fr-sftp.checkpoint.json so
//      re-runs resume at the next unprocessed file.
//   7. On completion, log a summary and rotate the staging dir.
//
// At the millions-of-SIRENs scale the bottleneck is PDF parsing, not
// transfer. CONCURRENCY should track CPU count; OCR alone is tesseract-
// bound and will consume all cores.
//
// NOTE: Not executable yet — `ssh2-sftp-client` is not in package.json
// and the credentials are pending. When you are ready:
//
//   npm install ssh2-sftp-client
//   cp .env .env.local
//   # add SFTP_HOST, SFTP_USER, SFTP_KEY_PATH, SFTP_PASSPHRASE (optional)
//   node --env-file=.env.local scripts/ingest-fr-sftp.mjs --date=2026-04-22

import path from 'node:path';
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
  createReadStream, createWriteStream, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';

import { parseFrBilanPdf } from '../server/fr-bilanz-parser.js';
import { upsertFinancials, upsertCompany } from '../server/normalize.js';

// ─── Config ─────────────────────────────────────────────────────────────
const SFTP_HOST       = process.env.SFTP_HOST;
const SFTP_USER       = process.env.SFTP_USER;
const SFTP_KEY_PATH   = process.env.SFTP_KEY_PATH;
const SFTP_PASSPHRASE = process.env.SFTP_PASSPHRASE || undefined;
const SFTP_PORT       = Number(process.env.SFTP_PORT || 22);
const REMOTE_ROOT     = process.env.SFTP_ROOT || '/comptes_annuels';
const STAGING_DIR     = process.env.STAGING_DIR || 'data/staging-sftp';
const CONCURRENCY     = Number(process.env.SFTP_CONCURRENCY || Math.max(2, (os.cpus()?.length || 4) - 1));
const CHECKPOINT_EVERY_N = Number(process.env.SFTP_CHECKPOINT_EVERY_N || 25);

const LOG_DIR         = 'logs';
const LOG_PATH        = `${LOG_DIR}/ingest-fr-sftp.log`;
const CHECKPOINT_PATH = `${LOG_DIR}/ingest-fr-sftp.checkpoint.json`;
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
if (!existsSync(STAGING_DIR)) mkdirSync(STAGING_DIR, { recursive: true });

const log = (line) => {
  const ts = new Date().toISOString();
  const msg = `${ts}  ${line}`;
  process.stdout.write(msg + '\n');
  appendFileSync(LOG_PATH, msg + '\n');
};

// ─── CLI ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => s.split('=')).map(([k, v]) => [k.replace(/^-+/, ''), v ?? true]),
);
if (args.help) {
  console.log(`Usage: node scripts/ingest-fr-sftp.mjs [--date=YYYY-MM-DD] [--reset] [--dry-run]`);
  process.exit(0);
}

const date = args.date
  ? String(args.date)
  : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const [Y, M, D] = date.split('-');
const remoteDir = `${REMOTE_ROOT}/${Y}/${M}/${D}`;
const localDir  = path.join(STAGING_DIR, date);

// ─── Checkpoint ─────────────────────────────────────────────────────────
let checkpoint = { processed: {} };
if (existsSync(CHECKPOINT_PATH) && !args.reset) {
  try { checkpoint = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')); }
  catch { checkpoint = { processed: {} }; }
}
let dirty = 0;
const flushCheckpoint = () => {
  try { writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint)); dirty = 0; }
  catch (err) { log(`checkpoint write failed: ${err.message}`); }
};
process.on('SIGINT',  () => { log('SIGINT — flushing'); flushCheckpoint(); process.exit(130); });
process.on('SIGTERM', () => { log('SIGTERM — flushing'); flushCheckpoint(); process.exit(143); });

// ─── SFTP (deferred import) ─────────────────────────────────────────────
// `ssh2-sftp-client` is NOT in package.json yet — install once keys arrive.
// We import dynamically so a `--help` invocation still works before install.
async function loadSftpClient() {
  try {
    const mod = await import('ssh2-sftp-client');
    return mod.default || mod;
  } catch (err) {
    log('ssh2-sftp-client is not installed. Run `npm install ssh2-sftp-client` first.');
    process.exit(3);
  }
}

async function sftpListZips(client, remoteDir) {
  const entries = await client.list(remoteDir);
  return entries
    .filter((e) => e.type === '-' && /\.zip$/i.test(e.name))
    .map((e) => ({ remote: `${remoteDir}/${e.name}`, size: e.size, name: e.name }));
}

async function sftpDownload(client, remote, local) {
  if (existsSync(local)) return;   // resume-safe
  await client.fastGet(remote, local, { concurrency: 4, chunkSize: 64 * 1024 });
}

// ─── Unzip (system unzip, no npm dep) ───────────────────────────────────
function unzip(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-o', '-q', zipPath, '-d', outDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`unzip exit ${code}: ${err}`)));
  });
}

// ─── PDF → KPI pipeline ─────────────────────────────────────────────────
// The filename convention INPI uses in bulk archives is
// `CA_<SIREN>_<greffe>_<numnat>_<year>_<typeBilan>.pdf`
// (same as the API's `nomDocument`). We parse enough to locate SIREN,
// closing-year, and typeBilan; anything unparseable goes to a reject list.
const BILAN_FILE_RE = /^CA_(\d{9})_\d+_[A-Za-z0-9]+_(\d{4})_([SKC])/;

async function processPdf(pdfPath) {
  const base = path.basename(pdfPath);
  const m = base.match(BILAN_FILE_RE);
  if (!m) return { skip: 'filename-mismatch', base };
  const siren = m[1];
  const year  = m[2];
  const type  = m[3];
  const dateCloture = `${year}-12-31`;   // assumption; CERFA filings are fiscal-year

  if (checkpoint.processed[base]) return { skip: 'already-processed', base };

  const buf = readFileSync(pdfPath);
  const kpi = await parseFrBilanPdf(buf, {
    dateCloture, typeBilan: type, sourceRef: base,
  });
  if (!kpi) {
    checkpoint.processed[base] = { siren, status: 'unparsed' };
    return { parsed: false, siren, year, type };
  }

  // No adapter call here — we already have a fully-parsed KPI row.
  upsertFinancials('FR', siren, [kpi]);
  // Also drop a minimal companies-row so search-by-name works. Bulk
  // ingest doesn't carry denomination in the PDF filename, so we leave
  // legal_name null; a later lookup will fill it.
  upsertCompany({
    country: 'FR',
    nationalId: siren,
    nationalIdCanon: siren,
    legalName: null,
    status: 'active',
    source: 'fr-sftp-bulk',
  });

  checkpoint.processed[base] = { siren, status: 'ok', filled: kpi && Object.values(kpi).filter((v) => v != null).length };
  return { parsed: true, siren, year, type, filled: checkpoint.processed[base].filled };
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  log(`=== ingest-fr-sftp  date=${date}  concurrency=${CONCURRENCY}  dry=${!!args['dry-run']} ===`);

  if (!SFTP_HOST || !SFTP_USER || !SFTP_KEY_PATH) {
    log('SFTP credentials missing (SFTP_HOST / SFTP_USER / SFTP_KEY_PATH).');
    log('Skeleton ready — add credentials to .env.local and re-run.');
    process.exit(4);
  }

  const Client = await loadSftpClient();
  const client = new Client();
  await client.connect({
    host: SFTP_HOST,
    port: SFTP_PORT,
    username: SFTP_USER,
    privateKey: readFileSync(SFTP_KEY_PATH),
    passphrase: SFTP_PASSPHRASE,
  });

  log(`SFTP connected. Listing ${remoteDir}…`);
  let zips = [];
  try { zips = await sftpListZips(client, remoteDir); }
  catch (err) { log(`list failed: ${err.message}`); await client.end(); process.exit(5); }
  log(`found ${zips.length} zips for ${date}.`);
  if (!zips.length) { await client.end(); process.exit(0); }

  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
  for (const z of zips) {
    const local = path.join(localDir, z.name);
    log(`  download ${z.name} (${(z.size / 1e6).toFixed(1)} MB)…`);
    if (!args['dry-run']) await sftpDownload(client, z.remote, local);
  }
  await client.end();

  if (args['dry-run']) { log('dry-run — stopping before unzip/parse.'); process.exit(0); }

  // Unzip into a shared PDF dir (filenames are globally unique so no conflict).
  const pdfDir = path.join(localDir, '_pdfs');
  if (!existsSync(pdfDir)) mkdirSync(pdfDir, { recursive: true });
  for (const z of zips) {
    log(`  unzip ${z.name}…`);
    await unzip(path.join(localDir, z.name), pdfDir);
  }
  const pdfs = readdirSync(pdfDir).filter((f) => /\.pdf$/i.test(f));
  log(`${pdfs.length} PDFs ready for parsing.`);

  let cursor = 0;
  let ok = 0, skipped = 0, err = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < pdfs.length) {
      const i = cursor++;
      const pdfPath = path.join(pdfDir, pdfs[i]);
      try {
        const r = await processPdf(pdfPath);
        if (r.skip) { skipped++; }
        else if (r.parsed) { ok++; }
        else { err++; }
      } catch (e) {
        err++;
        log(`  parse-err ${pdfs[i]}: ${e.message}`);
      }
      if (++dirty >= CHECKPOINT_EVERY_N) flushCheckpoint();
      if ((i + 1) % 100 === 0) {
        const s = (Date.now() - t0) / 1000;
        log(`-- progress ${i + 1}/${pdfs.length}  ok=${ok} skip=${skipped} err=${err}  ${s.toFixed(0)}s --`);
      }
    }
  }));
  flushCheckpoint();
  log(`=== done: ok=${ok}, skipped=${skipped}, err=${err} / ${pdfs.length} in ${((Date.now() - t0)/1000).toFixed(0)}s ===`);

  // Cleanup staging dir? Keep for now so re-runs don't redownload. Let
  // the operator prune manually or rotate via a cron.
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
