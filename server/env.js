// Minimal .env loader. No dependency on dotenv — we parse KEY=VALUE lines
// from the project-root .env and push them into process.env unless already set.
//
// Kept intentionally tiny: no interpolation, no multiline, no `export`. A single
// `=` splits key from value; surrounding double/single quotes are stripped; `#`
// lines and empty lines are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv(file = '.env') {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return { loaded: 0, path: p, missing: true };
  const raw = fs.readFileSync(p, 'utf8');
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = val;
      loaded++;
    }
  }
  return { loaded, path: p, missing: false };
}
