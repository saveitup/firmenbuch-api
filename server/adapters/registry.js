// Country → Adapter registry. Single source of truth for which countries
// Kontur can currently lookup. Adding a country is one import + one push.

import at from './at.js';
import de from './de.js';
import no from './no.js';
import fr from './fr.js';
import cz from './cz.js';
import fi from './fi.js';
import uk from './uk.js';
import se from './se.js';
import pl from './pl.js';
import it from './it.js';
import es from './es.js';
import nl from './nl.js';
import be from './be.js';
import ie from './ie.js';

const ADAPTERS = [at, de, no, fr, cz, fi, uk, se, pl, it, es, nl, be, ie];
const BY_ID = new Map(ADAPTERS.map((a) => [a.id.toUpperCase(), a]));

export function listCountries() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    license: a.license,
    sourceLabel: a.sourceLabel,
    sourceUrl: a.sourceUrl,
    attribution: a.attribution,
    hasFinancials: a.hasFinancials,
    coverage: a.coverage || 'full',
    configured: a.configured !== false,    // undefined → assume configured
  }));
}

export function getAdapter(countryCode) {
  if (!countryCode) return null;
  return BY_ID.get(String(countryCode).toUpperCase()) || null;
}

export async function searchAll(query, countries = null) {
  const targets = countries && countries.length
    ? countries.map((c) => getAdapter(c)).filter(Boolean)
    : ADAPTERS;
  const results = await Promise.allSettled(
    targets.map(async (a) => ({ country: a.id, hits: await a.search(query) })),
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { country: targets[i].id, hits: [], error: String(r.reason?.message || r.reason) },
  );
}
