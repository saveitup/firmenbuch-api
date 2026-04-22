// GLEIF enrichment — runs on top of primary adapter results to add
//   (1) LEI code if not already known,
//   (2) direct parent entity (Level 2 relationship data),
//   (3) ultimate parent entity (Level 2).
// Silent-fail: any HTTP error or missing data leaves the input DTO untouched.
// License: GLEIF Golden Copy is CC0 — no attribution required for Level 2.
import https from 'node:https';

const HOST = 'api.gleif.org';
const UA = 'Kontur/0.2';
const TIMEOUT_MS = 8000;

function gleifGet(path) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: HOST, path, method: 'GET',
        headers: { Accept: 'application/vnd.api+json', 'User-Agent': UA },
        timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function findLei(country, nationalId, legalName) {
  if (nationalId) {
    const filter = encodeURIComponent(nationalId);
    const r = await gleifGet(
      `/api/v1/lei-records?filter%5Bentity.registeredAs%5D=${filter}&filter%5Bentity.jurisdiction%5D=${country}&page%5Bsize%5D=1`,
    );
    const hit = r?.data?.[0];
    if (hit) return hit.attributes?.lei;
  }
  if (legalName) {
    const filter = encodeURIComponent(legalName);
    const r = await gleifGet(
      `/api/v1/lei-records?filter%5Bentity.legalName%5D=${filter}&filter%5Bentity.jurisdiction%5D=${country}&page%5Bsize%5D=1`,
    );
    const hit = r?.data?.[0];
    if (hit) return hit.attributes?.lei;
  }
  return null;
}

function parentToBrief(payload) {
  const data = payload?.data;
  if (!data) return null;
  const a = data.attributes;
  if (!a?.lei) return null;
  return {
    lei: a.lei,
    name: a.entity?.legalName?.name,
    jurisdiction: a.entity?.jurisdiction,
    nationalId: a.entity?.registeredAs,
  };
}

/**
 * Enrich a primary-adapter DTO in place with LEI + parent relationships.
 * No-op when GLEIF has no data for the company.
 */
export async function enrichWithGleif(dto) {
  if (!dto || !dto.country) return;
  let lei = dto.lei;
  if (!lei) {
    lei = await findLei(dto.country, dto.nationalId, dto.legalName);
    if (!lei) return;
    dto.lei = lei;
  }
  const [direct, ultimate] = await Promise.all([
    gleifGet(`/api/v1/lei-records/${encodeURIComponent(lei)}/direct-parent`),
    gleifGet(`/api/v1/lei-records/${encodeURIComponent(lei)}/ultimate-parent`),
  ]);
  const directBrief = parentToBrief(direct);
  const ultimateBrief = parentToBrief(ultimate);
  if (directBrief) dto.parent = directBrief;
  // Only surface ultimate parent if it's distinct from the direct parent.
  if (ultimateBrief && ultimateBrief.lei !== directBrief?.lei) {
    dto.ultimateParent = ultimateBrief;
  }
}
