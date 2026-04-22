// Peer-grouping for a single company.
// We don't have registered industry codes, so we approximate a "peer group"
// via:
//   · same Rechtsform code (GmbH, AG, …)
//   · similar Bilanzsumme (log-size bucket: quarter..quadruple the target)
// The query in db/queries.js handles the SQL; this module adds percentile
// computation so we can say "this company is in the p73 of its peers".

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

export function computePercentiles(values) {
  const clean = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  return {
    count: clean.length,
    p25: quantile(clean, 0.25),
    p50: quantile(clean, 0.5),
    p75: quantile(clean, 0.75),
    p95: quantile(clean, 0.95),
    min: clean[0],
    max: clean[clean.length - 1],
  };
}

export function rankOf(value, sorted) {
  if (value == null || !sorted.length) return null;
  let idx = 0;
  while (idx < sorted.length && sorted[idx] < value) idx++;
  return idx / sorted.length;
}

/**
 * Given a target company's latest KPIs and the array of peer records
 * (each with bilanz, umsatz, ek_quote, health_score), compute a peer
 * profile with percentiles and ranks.
 */
export function buildPeerProfile(target, peers) {
  const metrics = ['bilanz', 'umsatz', 'ek_quote', 'health_score'];
  const profile = { target, peers, percentiles: {}, ranks: {} };
  for (const m of metrics) {
    const values = peers.map((p) => p[m]);
    profile.percentiles[m] = computePercentiles(values);
    if (target[m] != null && profile.percentiles[m]) {
      const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
      profile.ranks[m] = rankOf(target[m], sorted);
    }
  }
  return profile;
}
