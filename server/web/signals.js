// Deterministic signals from a crawled website (plans/investor-screening.md,
// Phase 5): open positions incl. leadership roles, succession, family
// business and generation, group membership, language versions and export,
// certificates, locations, founding year, web shop. Every signal carries the
// URL and a short quote it rests on — the LLM profile (Phase 6) builds on
// these instead of re-reading whole sites.

const CURRENT_YEAR = new Date().getFullYear();

// "(m/w/d)", "(w/m/x)", "(m/f/d)", "(all genders)", "(gn*)"
const GENDER_MARKER = /\((?:[mwdfxi*]\s*[/|,]\s*){1,3}[mwdfxi*]\)|\((?:all genders|alle geschlechter|gn\*?)\)/i;
// Bau-, Projekt- and Montageleiter are site roles, not management.
const LEADERSHIP = /f[uü]hrungskraft|(?<!bau|projekt|montage|filial|reise|schicht)leit(?:er|erin|ung)\b|head of|director|\bcfo\b|\bceo\b|\bcoo\b|\bcto\b|prokurist/i;
const TOP_ROLE = /gesch[aä]ftsf[uü]hr|gesch[aä]ftsleit|managing director|\bceo\b|\bcfo\b|\bcoo\b|nachfolge|nachfolger|vorstand/i;

// "Nachfolger für den Lüfter X" is a product; "die nächste Generation von
// Technikern/Projekten" is not ownership.
const SUCCESSION = /unternehmensnachfolge|nachfolgeregelung|nachfolgeplanung|nachfolger(?:in)?\s+gesucht|suchen (?:eine[nr]? )?nachfolger|generationswechsel|generationen(?:wechsel|übergabe)|(?:an|in) die n[aä]chste generation(?!\s+(?:von|an|der|des|unserer))|[uü]bergabe des unternehmens|[uü]bergibt (?:die |das )?(?:gesch[aä]ftsf[uü]hrung|unternehmen|firma)/i;
const FAMILY = /familienunternehmen|familiengef[uü]hrt|familienbetrieb|eigent[uü]merge(?:f[uü]hrt|führt)|inhabergef[uü]hrt|family[- ]owned|family business|family company/i;
const GENERATION = /(?:in|der|die)\s+(\d|zweite[nr]?|dritte[nr]?|vierte[nr]?|f[uü]nfte[nr]?|sechste[nr]?|2\.|3\.|4\.|5\.|6\.)\s*generation|(\d)(?:st|nd|rd|th) generation/i;
const GENERATION_WORDS = { zweite: 2, dritte: 3, vierte: 4, 'fünfte': 5, funfte: 5, sechste: 6 };
// Done: "vollzogen", "übernimmt", "ist neuer Eigentümer" — context, not an opening.
const SUCCESSION_DONE = /vollzogen|abgeschlossen|vollendet|[uü]bernimmt|[uü]bernahm|[uü]bernommen|[uü]bergeben|ist neue[rn]?|sind neue|neue[rn]? (?:gesch[aä]ftsf[uü]hr|eigent[uü]mer|inhaber|alleineigent)|leite[nt] nun|lenken|f[uü]hren nun|in (?:\d\.|zweiter|dritter|vierter|f[uü]nfter) generation gef[uü]hrt/i;
// "Werden Sie Teil der … Group" recruits; it says nothing about ownership.
const RECRUITING = /(?:werden sie|werde|become|join|bewirb dich|bewerben sie sich)\W{0,3}$/i;
const GROUP = /teil der [^.\n]{1,40}(?:gruppe|group|holding)|geh[oö]rt zu(?:r|m)? [^.\n]{1,40}(?:gruppe|group|konzern)|tochter(?:gesellschaft|unternehmen) (?:der|von)|ein unternehmen der [^.\n]{1,40}(?:gruppe|group)|(?:member|part|a company) of the [^.\n]{1,40}group/i;

const EXPORT_QUOTE = /export(?:quote|anteil)\s*(?:von|:|liegt bei|betr[aä]gt)?\s*(?:rund|ca\.?|über|mehr als|knapp)?\s*(\d{1,3})\s*%/i;
const EXPORT_COUNTRIES = /(?:in|nach|aus|into|to)\s+(?:über|mehr als|rund|ca\.?|knapp|more than|over|about)?\s*(\d{1,3})\s+(?:l[aä]nder|l[aä]ndern|staaten|countries|nations)/i;
// "weltweit führend" is marketing; only "Export" itself counts as a word hint.
const EXPORT_WORDS = /\bexport/i;

const CERTIFICATES = [
  ['ISO 9001', /iso\s*9001/i], ['ISO 14001', /iso\s*14001/i], ['ISO 45001', /iso\s*45001|ohsas\s*18001/i],
  ['ISO 50001', /iso\s*50001/i], ['ISO 27001', /iso(?:\/iec)?\s*27001/i], ['ISO 13485', /iso\s*13485/i],
  ['IATF 16949', /iatf\s*16949|iso\/ts\s*16949/i], ['EN 9100', /(?:en|as)\s*9100/i], ['ISO 22000', /iso\s*22000|fssc\s*22000/i],
  ['IFS', /\bifs (?:food|logistics|broker|global markets)\b/i], ['BRCGS', /\bbrc(?:gs)?\b/i], ['HACCP', /\bhaccp\b/i],
  ['GMP', /\bgmp\b/i], ['GDP', /\bgdp(?:-zertifi| zertifi| certifi|-certifi)/i], ['EN 1090', /en\s*1090/i],
  ['ISO 3834', /iso\s*3834/i], ['SCC', /\bSCC(?:\*{1,2}|P)?(?!\w)/], ['EMAS', /\bemas\b/i], ['TÜV', /t[uü]v[- ](?:zertifi|gepr[uü]ft|certifi|s[uü]d|austria|nord|rheinland)/i],
  ['FSC/PEFC', /\bfsc\b|\bpefc\b/i], ['EcoVadis', /ecovadis/i], ['ÖKOPROFIT', /[oö]koprofit/i], ['klimaaktiv', /klimaaktiv/i],
];

const STANDORTE_COUNT = /(\d{1,3})\s+(?:standorte|standorten|niederlassungen|filialen|vertriebsniederlassungen|locations|sites|branches|offices)/i;
// Austrian PLZ + place on location/contact pages ("4020 Linz", "A-1100 Wien").
const PLZ_ORT = /(?:^|[\s,(])(?:A-|AT-)?([1-9]\d{3})\s+([A-ZÄÖÜ][a-zäöüß]+(?:[ -][A-ZÄÖÜa-zäöüß.]+){0,3})/g;
// "1000 Mitarbeiter", "2024 Neue …" are counts and years, not addresses.
const NOT_PLACE = /^(mitarbeiter|mitarbeitende|besch[aä]ftigte|kunden|projekte|st[uü]ck|jahre|euro|tonnen|quadratmeter|neue|neuer|neues|produkte|artikel|m2|stunden|fahrzeuge|partner|standorte|filialen|lkw|tage|wurde|wurden|haben|hat|ist|war|gr[uü]ndung)/i;

const FOUNDED = /(?:gegr[uü]ndet|gr[uü]ndung(?:sjahr)?|founded|established|est\.|gegr\.)\s*(?:im jahr(?:e)?|in|:|am [^\n]{0,20})?\s*((?:1[6-9]|20)\d\d)|((?:1[6-9]|20)\d\d)\s*[:–-]?\s+(?:[^.\n\d]{0,60}\s)?(?:gegr[uü]ndet|gr[uü]ndung|founded)/i;
// History pages are timelines: their earliest line-leading year is the start.
const HISTORY_PAGE = /geschichte|historie|history|chronik|meilenstein|milestone|tradition/i;
const TIMELINE_YEAR = /(?:^|\n)\s*((?:1[89]|20)\d\d)(?=\s*(?:[:–-]|\n|\s+[A-ZÄÖÜ]))/g;
const SINCE = /\b(?:seit|since)\s+((?:1[6-9]|20)\d\d)\b/i;
// "Vor mehr als 65 Jahren … gegründet" → about CURRENT_YEAR − 65.
const YEARS_AGO = /vor\s+(?:mehr als|über|rund|knapp|fast|genau)?\s*(\d{2,3})\s+jahren\s+(?:[^.\n]{0,80}\s)?gegr[uü]ndet|(?:more than|over)?\s*(\d{2,3})\s+years ago[^.\n]{0,40}founded/i;

const B2B_PORTAL = /b2b[- ]?(?:shop|portal|webshop)|h[aä]ndlerportal|h[aä]ndler-?login|fachh[aä]ndler-?login|kundenportal|kunden-?login|dealer portal|partnerportal/i;

const clip = (text, idx, len) => text.slice(Math.max(0, idx - 70), idx + len + 70).replace(/\s+/g, ' ').trim();

function firstMatch(pages, re, kinds) {
  for (const p of pages) {
    if (kinds && !kinds.includes(p.kind)) continue;
    const m = re.exec(p.text);
    if (m) return { m, page: p, quote: clip(p.text, m.index, m[0].length) };
  }
  return null;
}

/**
 * pages: [{url, kind, text}], meta: {languages, shop, jobsExternal, jobLinks}
 * → { signals, evidence } with evidence = {signal: [{url, quote}]}.
 */
export function extractSignals(pages, meta = {}) {
  const evidence = {};
  const cite = (key, url, quote) => { (evidence[key] ||= []).length < 3 && evidence[key].push({ url, quote }); };

  // Open positions: distinct lines with a gender marker on career pages and
  // in the career pages' link texts; elsewhere only on the start page.
  const jobLines = new Map();
  const addJob = (line, url) => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t.length < 6 || t.length > 160 || !GENDER_MARKER.test(t)) return;
    const key = t.toLowerCase().replace(GENDER_MARKER, '').replace(/[^a-zäöüß]+/g, ' ').trim();
    if (key && !jobLines.has(key)) jobLines.set(key, { title: t, url });
  };
  for (const p of pages) if (p.kind === 'karriere' || p.kind === 'start') for (const l of p.text.split('\n')) addJob(l, p.url);
  const careerUrl = pages.find((p) => p.kind === 'karriere')?.url || null;
  for (const t of meta.jobLinks || []) addJob(t, careerUrl);
  const jobs = [...jobLines.values()];
  const fuehrung = jobs.filter((j) => LEADERSHIP.test(j.title) || TOP_ROLE.test(j.title));
  const gf = jobs.filter((j) => TOP_ROLE.test(j.title));
  for (const j of gf) cite('jobs_gf', j.url, j.title);
  for (const j of fuehrung.filter((x) => !gf.includes(x))) cite('jobs_fuehrung', j.url, j.title);
  for (const j of jobs.slice(0, 3)) cite('jobs', j.url, j.title);

  // Succession, family business, generation, group membership.
  // A generation change dated years ago is history, not a current succession.
  let succ = null;
  for (const p of pages) {
    for (const m of p.text.matchAll(new RegExp(SUCCESSION.source, 'gi'))) {
      const around = p.text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      const years = [...around.matchAll(/\b(1[6-9]\d\d|20\d\d)\b/g)].map((y) => Number(y[1]));
      if (years.length && Math.max(...years) < CURRENT_YEAR - 5) continue;
      const context = p.text.slice(Math.max(0, m.index - 150), m.index + m[0].length + 150);
      succ = { page: p, quote: clip(p.text, m.index, m[0].length), done: SUCCESSION_DONE.test(context) };
      break;
    }
    if (succ) break;
  }
  if (succ) cite('nachfolge', succ.page.url, succ.quote);
  const fam = firstMatch(pages, FAMILY);
  if (fam) cite('familienunternehmen', fam.page.url, fam.quote);
  let generation = null;
  const gen = firstMatch(pages, GENERATION);
  if (gen) {
    const raw = (gen.m[1] || gen.m[2] || '').toLowerCase().replace('.', '');
    generation = Number(raw) || GENERATION_WORDS[raw.replace(/[nr]$/, '')] || null;
    if (generation) cite('generation', gen.page.url, gen.quote);
  }
  let grp = null;
  for (const p of pages) {
    for (const m of p.text.matchAll(new RegExp(GROUP.source, 'gi'))) {
      if (RECRUITING.test(p.text.slice(Math.max(0, m.index - 25), m.index))) continue;
      grp = { page: p, quote: clip(p.text, m.index, m[0].length) };
      break;
    }
    if (grp) break;
  }
  if (grp) cite('gruppe_hinweis', grp.page.url, grp.quote);

  // Languages and export.
  const languages = (meta.languages || []).filter((l) => /^[a-z]{2}$/.test(l));
  const quote = firstMatch(pages, EXPORT_QUOTE);
  const exportQuote = quote && Number(quote.m[1]) <= 100 ? Number(quote.m[1]) / 100 : null;
  if (exportQuote != null) cite('export', quote.page.url, quote.quote);
  const countries = firstMatch(pages, EXPORT_COUNTRIES);
  const exportLaender = countries && Number(countries.m[1]) >= 2 && Number(countries.m[1]) <= 200 ? Number(countries.m[1]) : null;
  if (exportLaender) cite('export', countries.page.url, countries.quote);
  const words = firstMatch(pages, EXPORT_WORDS);
  if (words && !evidence.export) cite('export', words.page.url, words.quote);
  const foreign = languages.filter((l) => l !== 'de');
  const exportHinweis = Boolean(exportQuote || exportLaender || words || foreign.length >= 2);

  // Certificates (cited once each).
  const zertifikate = [];
  for (const [name, re] of CERTIFICATES) {
    const hit = firstMatch(pages, re);
    if (hit) { zertifikate.push(name); cite('zertifikate', hit.page.url, hit.quote); }
  }

  // Locations: an explicit count, else distinct PLZ on location/contact pages.
  let standorte = null;
  const count = firstMatch(pages, STANDORTE_COUNT);
  if (count && Number(count.m[1]) >= 2 && Number(count.m[1]) <= 500) { standorte = Number(count.m[1]); cite('standorte', count.page.url, count.quote); }
  const plz = new Map();
  for (const p of pages.filter((x) => x.kind === 'standorte' || x.kind === 'kontakt')) {
    for (const m of p.text.matchAll(PLZ_ORT)) {
      if (!NOT_PLACE.test(m[2]) && !plz.has(m[1])) plz.set(m[1], { url: p.url, label: `${m[1]} ${m[2]}` });
    }
  }
  if (plz.size >= 2 && plz.size > (standorte || 0)) {
    standorte = plz.size;
    cite('standorte', [...plz.values()][0].url, [...plz.values()].slice(0, 6).map((x) => x.label).join(' · '));
  }

  // Founding year: explicit "gegründet" first, "seit" only as a fallback.
  let gruendungsjahr = null;
  const years = [];
  for (const p of pages) {
    for (const m of p.text.matchAll(new RegExp(FOUNDED.source, 'gi'))) {
      const y = Number(m[1] || m[2]);
      if (y <= CURRENT_YEAR) years.push({ y, url: p.url, quote: clip(p.text, m.index, m[0].length) });
    }
    for (const m of p.text.matchAll(new RegExp(YEARS_AGO.source, 'gi'))) {
      const n = Number(m[1] || m[2]);
      if (n >= 5 && n <= 400) years.push({ y: CURRENT_YEAR - n, url: p.url, quote: clip(p.text, m.index, m[0].length) });
    }
  }
  if (!years.length) {
    for (const p of pages.filter((x) => HISTORY_PAGE.test(`${x.url} ${x.title || ''}`))) {
      for (const m of p.text.matchAll(TIMELINE_YEAR)) {
        const y = Number(m[1]);
        if (y <= CURRENT_YEAR) years.push({ y, url: p.url, quote: clip(p.text, m.index, m[0].length + 60) });
      }
    }
  }
  if (!years.length) {
    // "seit 1978" is weak ("seit 2015 zertifiziert"): earliest on start/Über uns only.
    for (const p of pages.filter((x) => x.kind === 'start' || x.kind === 'ueber_uns')) {
      for (const m of p.text.matchAll(new RegExp(SINCE.source, 'gi'))) {
        const y = Number(m[1]);
        if (y <= CURRENT_YEAR) years.push({ y, url: p.url, quote: clip(p.text, m.index, m[0].length) });
      }
    }
  }
  if (years.length) {
    const first = years.sort((a, b) => a.y - b.y)[0];
    gruendungsjahr = first.y;
    cite('gruendungsjahr', first.url, first.quote);
  }

  // Web shop (B2C hint) vs. a B2B portal.
  const portal = firstMatch(pages, B2B_PORTAL);
  if (portal) cite('b2b_portal', portal.page.url, portal.quote);
  const shop = meta.shop || {};
  const webshop = Boolean(shop === true || shop.strong || (shop.label && shop.cart));
  if (webshop) cite('webshop', pages[0]?.url, shop.strong ? 'Kauf-Buttons bzw. Shopify-Shop im HTML' : 'Link „Shop“ und Warenkorb im HTML');

  // Team page naming a second management level.
  const team = pages.filter((p) => p.kind === 'team' || p.kind === 'ueber_uns');
  const roles = new Set();
  for (const p of team) for (const m of p.text.matchAll(/(?:bereichs|abteilungs|vertriebs|verkaufs|produktions|werks|technische[rn]?|kaufm[aä]nnische[rn]?|niederlassungs)\s?leit(?:er|erin|ung)|head of [a-z]+|prokurist(?:in)?/gi)) roles.add(m[0].toLowerCase());
  const zweiteEbene = roles.size >= 2;
  if (zweiteEbene) cite('zweite_ebene', team[0].url, [...roles].slice(0, 5).join(' · '));

  return {
    signals: {
      pages: pages.length,
      jobs: jobs.length,
      jobs_fuehrung: fuehrung.length,
      jobs_gf: gf.length,
      jobs_extern: (meta.jobsExternal || []).join(', ') || null,
      // 1 = open or unclear (incl. a GF job ad), 2 = succession already done.
      nachfolge: gf.length || (succ && !succ.done) ? 1 : succ ? 2 : 0,
      familienunternehmen: fam || generation ? 1 : 0,
      generation,
      gruppe_hinweis: grp ? 1 : 0,
      languages,
      export_hinweis: exportHinweis ? 1 : 0,
      export_laender: exportLaender,
      export_quote: exportQuote,
      zertifikate,
      standorte,
      gruendungsjahr,
      webshop: webshop ? 1 : 0,
      b2b_portal: portal ? 1 : 0,
      zweite_ebene: zweiteEbene ? 1 : 0,
    },
    evidence,
  };
}
