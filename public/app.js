// Kontur frontend. Cross-country search + enriched detail, URL-routed.
//
// Hash shapes:
//   #q=bank&c=CZ     → search (c optional)
//   #co=AT:129377k   → detail view for a specific company
//   ∅               → empty state with example chips
const els = {
  form: document.getElementById('search-form'),
  countrySelect: document.getElementById('country-select'),
  countryStrip: document.getElementById('country-strip'),
  heroCount: document.getElementById('hero-count'),
  input: document.getElementById('search-input'),
  button: document.getElementById('search-button'),
  status: document.getElementById('search-status'),
  results: document.getElementById('results'),
  detail: document.getElementById('detail'),
  footerSources: document.getElementById('footer-sources'),
  emptyState: document.getElementById('empty-state'),
  exampleChips: document.getElementById('example-chips'),
  scrollTop: document.getElementById('scroll-top'),
  toast: document.getElementById('toast'),
};

let countries = [];
let activeCountryFilter = '';
let suppressHashChange = false;
let lastSearchKey = '';       // `q::c` — memo to avoid refetch on detail-back

const EXAMPLES = [
  { cc: 'AT', q: 'OMV',              label: 'OMV'                },
  { cc: 'NO', q: 'equinor',          label: 'Equinor'            },
  { cc: 'CZ', q: 'skoda auto',       label: 'Škoda Auto'         },
  { cc: 'FI', q: 'nokia',            label: 'Nokia'              },
  { cc: 'DE', q: 'siemens',          label: 'Siemens'            },
  { cc: 'FR', q: 'renault',          label: 'Renault'            },
  { cc: '',   q: 'bank',             label: 'Alle Banken'        },
  { cc: '',   q: 'volkswagen',       label: 'Volkswagen-Konzern' },
];

// ─────────── Init ───────────
async function init() {
  try {
    const res = await fetch('/api/countries');
    const data = await res.json();
    countries = data.countries || [];
  } catch (err) {
    setStatus(`Länder konnten nicht geladen werden: ${err.message}`);
    return;
  }
  els.heroCount.textContent = countries.length;
  renderCountryOptions(countries);
  renderCountryStrip(countries);
  renderFooterSources(countries);
  renderExamples();

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = els.input.value.trim();
    if (q) setHash({ q, c: activeCountryFilter });
  });
  els.countrySelect.addEventListener('change', () => {
    activeCountryFilter = els.countrySelect.value;
    syncStripHighlight();
    const q = els.input.value.trim();
    if (q) setHash({ q, c: activeCountryFilter });
  });
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('scroll', onScroll, { passive: true });
  els.scrollTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  els.results.addEventListener('click', onResultsClick);

  onHashChange();
}

// ─────────── Country strip / dropdown ───────────
function renderCountryOptions(list) {
  for (const c of list) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const suffix = c.coverage === 'partial' ? ' — LEI only'
                 : c.configured === false ? ' — braucht API-Key'
                 : '';
    opt.textContent = `${c.label} (${c.id})${suffix}`;
    els.countrySelect.appendChild(opt);
  }
}

function renderCountryStrip(list) {
  els.countryStrip.innerHTML = '';
  const allPill = makePill('', 'Alle', 'full', true);
  allPill.classList.add('active');
  els.countryStrip.appendChild(allPill);
  for (const c of list) {
    const cfgClass = c.configured === false ? 'needs-config' : c.coverage === 'partial' ? 'partial' : '';
    const pill = makePill(c.id, c.id, cfgClass, true);
    pill.title = `${c.label} · ${c.license}${c.configured === false ? ' · API-Key fehlt' : ''}`;
    els.countryStrip.appendChild(pill);
  }
}
function makePill(cc, label, cfgClass, clickable) {
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'country-pill' + (cfgClass ? ' ' + cfgClass : '');
  pill.dataset.cc = cc;
  pill.innerHTML = `<span class="country-pill-dot"></span><span></span>`;
  pill.querySelector('span:last-child').textContent = label;
  if (clickable) pill.addEventListener('click', () => setFilter(cc));
  return pill;
}
function setFilter(code) {
  activeCountryFilter = code;
  els.countrySelect.value = code;
  syncStripHighlight();
  const q = els.input.value.trim();
  if (q) setHash({ q, c: code });
  else   setHash({});
}
function syncStripHighlight() {
  for (const pill of els.countryStrip.querySelectorAll('.country-pill')) {
    pill.classList.toggle('active', (pill.dataset.cc || '') === activeCountryFilter);
  }
}

// ─────────── Footer + examples ───────────
function renderFooterSources(list) {
  els.footerSources.innerHTML = '';
  const heading = document.createElement('p');
  heading.className = 'footer-sources-heading';
  heading.textContent = 'Datenquellen';
  els.footerSources.appendChild(heading);
  const ul = document.createElement('ul');
  for (const c of list) {
    const li = document.createElement('li');
    const code = document.createElement('strong');
    code.textContent = c.id;
    li.appendChild(code);
    if (c.sourceUrl) {
      const a = document.createElement('a');
      a.href = c.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = c.sourceLabel || c.sourceUrl;
      li.appendChild(a);
    } else {
      li.appendChild(document.createTextNode(c.sourceLabel || ''));
    }
    ul.appendChild(li);
  }
  els.footerSources.appendChild(ul);
}

function renderExamples() {
  els.exampleChips.innerHTML = '';
  for (const ex of EXAMPLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'example-chip';
    btn.innerHTML = `<span class="chip-cc"></span><span></span>`;
    btn.querySelector('.chip-cc').textContent = ex.cc || '↻';
    btn.querySelectorAll('span')[1].textContent = ex.label;
    btn.addEventListener('click', () => setHash({ q: ex.q, c: ex.cc }));
    els.exampleChips.appendChild(btn);
  }
}

// ─────────── Hash routing ───────────
function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  if (!h) return { kind: 'home' };
  const params = new URLSearchParams(h.includes('=') ? h : '');
  if (params.has('co')) {
    const [cc, id] = params.get('co').split(':');
    return { kind: 'detail', country: cc, id: decodeURIComponent(id || '') };
  }
  if (params.has('q')) {
    return { kind: 'search', q: params.get('q'), c: params.get('c') || '' };
  }
  return { kind: 'home' };
}

function setHash(spec) {
  const p = new URLSearchParams();
  if (spec.kind === 'detail') p.set('co', `${spec.country}:${spec.id}`);
  else if (spec.q) { p.set('q', spec.q); if (spec.c) p.set('c', spec.c); }
  const h = p.toString();
  if (suppressHashChange && `#${h}` === location.hash) return;
  if (h) location.hash = h;
  else { history.replaceState(null, '', location.pathname + location.search); onHashChange(); }
}

function onHashChange() {
  const state = parseHash();
  if (state.kind === 'home') {
    hideDetail();
    els.results.innerHTML = '';
    els.results.hidden = false;
    els.emptyState.hidden = false;
    lastSearchKey = '';
    setStatus('');
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  if (state.kind === 'search') {
    els.emptyState.hidden = true;
    els.results.hidden = false;
    els.input.value = state.q;
    activeCountryFilter = state.c || '';
    els.countrySelect.value = activeCountryFilter;
    syncStripHighlight();
    runSearch(state.q, activeCountryFilter);
    hideDetail();
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  if (state.kind === 'detail') {
    // Switch to "detail page": hide the search results and empty-state so
    // the detail card sits right below the hero, no scroll gymnastics.
    els.emptyState.hidden = true;
    els.results.hidden = true;
    window.scrollTo({ top: 0, behavior: 'instant' });
    showDetail(state.country, state.id);
    return;
  }
}

// ─────────── Search / results ───────────
async function runSearch(q, cc) {
  // Memo: when returning from detail to the same search, reuse cached DOM.
  const key = `${q}::${cc || ''}`;
  if (lastSearchKey === key && els.results.children.length) {
    setStatus(els.status.textContent || '');
    return;
  }
  lastSearchKey = key;
  setStatus('Suche läuft…');
  els.results.innerHTML = '';
  try {
    const url = new URL('/api/search', location.href);
    url.searchParams.set('q', q);
    if (cc) url.searchParams.set('country', cc);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Suche fehlgeschlagen');
    const groups = data.results || [];
    renderResults(groups);
    const total = groups.reduce((n, g) => n + (g.hits?.length || 0), 0);
    const withHits = groups.filter((g) => g.hits?.length).length;
    setStatus(!total
      ? 'Keine Treffer.'
      : `${total.toLocaleString('de-AT')} Treffer in ${withHits} ${withHits === 1 ? 'Land' : 'Ländern'}.`);
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  }
}

function renderResults(groups) {
  els.results.innerHTML = '';
  const sorted = [...groups].sort((a, b) => {
    const ha = a.hits?.length || 0, hb = b.hits?.length || 0;
    if (ha !== hb) return hb - ha;
    if (!!a.error !== !!b.error) return a.error ? 1 : -1;
    return a.country.localeCompare(b.country);
  });
  for (const group of sorted) {
    if (!group.hits?.length && !group.error) continue;
    els.results.appendChild(renderGroup(group));
  }
  // After the DOM is in place, kick off background Kennzahlen-loading for
  // any hit that came back from the server without cached financials. Runs
  // with bounded concurrency so 20 misses don't hammer INPI at once; the
  // AbortController is recycled on every new search so stale requests stop.
  enrichMissingFinancials(sorted);
}

let enrichAbort = null;
const ENRICH_CONCURRENCY = 3;
const ENRICH_TIMEOUT_MS  = 60000;

function enrichMissingFinancials(groups) {
  if (enrichAbort) enrichAbort.abort();
  enrichAbort = new AbortController();
  const signal = enrichAbort.signal;

  // Only adapters with `hasFinancials` (per /api/countries) are worth fetching.
  const FIN_COUNTRIES = new Set(
    (countries || []).filter((c) => c.hasFinancials).map((c) => c.id),
  );
  const queue = [];
  for (const group of groups) {
    if (!FIN_COUNTRIES.has(group.country)) continue;
    for (const hit of (group.hits || [])) {
      if (hit.latestFinancials) continue;         // already fulfilled server-side
      if (hit.status === 'dissolved') continue;   // very rarely has fresh bilanzen
      queue.push({ country: hit.country, id: hit.nationalId });
    }
  }
  if (!queue.length) return;

  let cursor = 0;
  const runOne = async () => {
    while (cursor < queue.length && !signal.aborted) {
      const item = queue[cursor++];
      try { await fetchOneKpi(item, signal); } catch { /* swallow — don't kill other fetches */ }
    }
  };
  Promise.allSettled(Array.from({ length: ENRICH_CONCURRENCY }, runOne));
}

async function fetchOneKpi(item, parentSignal) {
  // Mark the hit li as loading so the user gets a visual hint.
  const li = document.querySelector(
    `.hit[data-country="${CSS.escape(item.country)}"][data-id="${CSS.escape(item.id)}"]`,
  );
  if (li) li.classList.add('kpi-loading');

  const ctrl = new AbortController();
  parentSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const timer = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(`/api/company/${item.country}/${item.id}`, { signal: ctrl.signal });
    if (!res.ok) return;
    data = await res.json();
  } finally {
    clearTimeout(timer);
    if (li) li.classList.remove('kpi-loading');
  }
  const fins = data?.financials || [];
  // Pick the most recent KPI row.
  const latest = fins.length
    ? [...fins].sort((a, b) => (b.stichtag || '').localeCompare(a.stichtag || ''))[0]
    : null;
  if (!li) return;
  if (!latest) {
    // Upstream register returned no bilanzen for this SIREN. Make that
    // explicit so the user knows it's not a loading bug — small SMEs /
    // subsidiaries routinely file under the confidentiality option.
    if (!li.querySelector('.hit-kpi, .hit-no-fin')) {
      const note = document.createElement('div');
      note.className = 'hit-no-fin';
      note.textContent = 'Keine Bilanz öffentlich hinterlegt';
      li.appendChild(note);
    }
    return;
  }
  if (!li.querySelector('.hit-kpi')) {
    li.appendChild(renderKpiStrip({
      stichtag: latest.stichtag,
      currency: latest.currency || 'EUR',
      umsatzerloese: latest.umsatzerloese,
      bilanzsumme: latest.bilanzsumme,
      eigenkapital: latest.eigenkapital,
      jahresergebnis: latest.jahresergebnis,
      ek_quote: latest.ek_quote,
    }));
    li.classList.add('has-kpi');
  }
}

function renderGroup(group) {
  const country = countries.find((c) => c.id === group.country);
  const section = document.createElement('section');
  section.className = `country-group${group.error ? ' err' : ''}`;
  section.innerHTML = `
    <div class="country-group-header">
      <span class="cg-code"></span>
      <span class="cg-name"></span>
      <span class="count"></span>
    </div>
    <ul class="hit-list"></ul>
  `;
  section.querySelector('.cg-code').textContent = group.country;
  section.querySelector('.cg-name').textContent = country?.label || group.country;
  section.querySelector('.count').textContent =
    group.error ? 'Fehler' : `${group.hits.length} Treffer`;
  const list = section.querySelector('.hit-list');
  if (group.error) {
    const li = document.createElement('li');
    li.className = 'hit'; li.style.cursor = 'default';
    const name = document.createElement('span');
    name.className = 'hit-name'; name.style.color = 'var(--muted)';
    name.textContent = group.error;
    li.appendChild(name);
    list.appendChild(li);
  } else {
    // Active companies first, dissolved last — keep input order within each group.
    const sortedHits = [...group.hits].sort((a, b) => {
      const ad = a.status === 'dissolved' ? 1 : 0;
      const bd = b.status === 'dissolved' ? 1 : 0;
      return ad - bd;
    });
    for (const hit of sortedHits) list.appendChild(renderHit(hit));
  }
  return section;
}

function renderHit(dto) {
  const li = document.createElement('li');
  li.className = 'hit';
  li.dataset.country = dto.country;
  li.dataset.id = dto.nationalId;
  li.innerHTML = `
    <span class="hit-name"></span>
    <span class="hit-status${dto.status === 'dissolved' ? ' dissolved' : ''}"></span>
    <span class="hit-id copy-id" title="Zum Kopieren klicken"></span>
  `;
  li.querySelector('.hit-name').textContent = dto.legalName || '(ohne Namen)';
  li.querySelector('.hit-status').textContent = dto.status === 'dissolved' ? 'gelöscht' : 'aktiv';
  li.querySelector('.hit-id').textContent = dto.nationalId;
  if (dto.latestFinancials) {
    li.appendChild(renderKpiStrip(dto.latestFinancials));
    li.classList.add('has-kpi');
  }
  return li;
}

// Compact one-line Kennzahlen summary rendered under the company name when
// the search response carries cached financials for the hit. Stays silent
// for companies the user has never looked up (fresh registers show no data).
const EUR_COMPACT = new Intl.NumberFormat('de-AT', { notation: 'compact', compactDisplay: 'short', maximumFractionDigits: 1 });
function fmtEur(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return EUR_COMPACT.format(v) + ' €';
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v * 100).toFixed(1) + ' %';
}
function renderKpiStrip(kpi) {
  const strip = document.createElement('div');
  strip.className = 'hit-kpi';
  const year = (kpi.stichtag || '').slice(0, 4) || '—';
  strip.innerHTML = `
    <span class="hit-kpi-year">FY ${year}</span>
    <span class="hit-kpi-cell" title="Umsatzerlöse"><em>Umsatz</em> <b></b></span>
    <span class="hit-kpi-cell" title="Bilanzsumme"><em>Bilanz</em> <b></b></span>
    <span class="hit-kpi-cell" title="Eigenkapital"><em>EK</em> <b></b></span>
    <span class="hit-kpi-cell" title="Jahresergebnis"><em>JE</em> <b></b></span>
    <span class="hit-kpi-cell" title="Eigenkapitalquote"><em>EK-Quote</em> <b></b></span>
  `;
  const cells = strip.querySelectorAll('.hit-kpi-cell b');
  cells[0].textContent = fmtEur(kpi.umsatzerloese);
  cells[1].textContent = fmtEur(kpi.bilanzsumme);
  cells[2].textContent = fmtEur(kpi.eigenkapital);
  cells[3].textContent = fmtEur(kpi.jahresergebnis);
  cells[4].textContent = fmtPct(kpi.ek_quote);
  return strip;
}

function onResultsClick(ev) {
  const copy = ev.target.closest('.copy-id');
  if (copy) {
    ev.stopPropagation();
    copyToClipboard(copy.textContent.trim());
    return;
  }
  const hit = ev.target.closest('.hit');
  if (hit && hit.dataset.id) {
    setHash({ kind: 'detail', country: hit.dataset.country, id: hit.dataset.id });
  }
}

// ─────────── Detail ───────────
async function showDetail(country, id) {
  setStatus('Lade Details…');
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(country)}/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nicht gefunden');
    renderDetail(data.company, data.people || [], data.financials || [], data.score, data.documents || []);
    setStatus('');
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
  }
}

function renderDetail(c, people, financials, score, documents) {
  const country = countries.find((x) => x.id === c.country);
  els.detail.hidden = false;
  const backLabel = lastSearchKey
    ? `← Zurück zu „${els.input.value.trim() || 'Suche'}"`
    : '← Startseite';
  els.detail.innerHTML = `
    <button class="detail-back" type="button" title="Zurück (Esc)"></button>
    <article class="detail">
      <header class="detail-head">
        <button class="detail-close" type="button" aria-label="Detail schließen" title="Schließen (Esc)">×</button>
        <h2></h2>
        <p class="hit-id copy-id" title="Zum Kopieren klicken"></p>
        <div class="detail-flags"></div>
      </header>
      <div class="detail-body">
        <section class="detail-section detail-col-span">
          <h3>Stammdaten</h3>
          <dl class="detail-fields"></dl>
        </section>
        <section class="detail-section detail-group detail-col-span" hidden>
          <h3>Konzernstruktur</h3>
          <div class="group-rows"></div>
        </section>
        <section class="detail-section detail-score" hidden>
          <h3>Health-Score</h3>
          <div class="score-card">
            <div class="score-number">
              <span class="score-value"></span>
              <span class="score-grade"></span>
            </div>
            <ul class="score-breakdown"></ul>
          </div>
        </section>
        <section class="detail-section detail-financials" hidden>
          <h3>Finanzkennzahlen</h3>
          <table class="fin-table">
            <thead>
              <tr><th>Jahr</th><th>Umsatz</th><th>Ergebnis</th><th>EK</th><th>Bilanz</th><th>EK-Quote</th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </section>
        <section class="detail-section detail-bilanz detail-col-span" hidden>
          <header class="bilanz-head">
            <nav class="bilanz-tabs" role="tablist">
              <button type="button" class="bilanz-tab is-active" data-tab="bilanz" role="tab">Bilanz</button>
              <button type="button" class="bilanz-tab" data-tab="kennzahlen" role="tab">Kennzahlen</button>
            </nav>
            <span class="bilanz-stichtag"></span>
          </header>
          <div class="bilanz-pane bilanz-pane-bilanz"></div>
          <div class="bilanz-pane bilanz-pane-kennzahlen" hidden></div>
          <p class="bilanz-note"></p>
        </section>
        <section class="detail-section detail-documents detail-col-span" hidden>
          <h3>Original-Jahresabschlüsse</h3>
          <p class="documents-note"></p>
          <ul class="documents-list"></ul>
        </section>
        <section class="detail-section detail-people detail-col-span" hidden>
          <h3>Vertretungsberechtigte</h3>
          <ul class="people-list"></ul>
        </section>
      </div>
      <div class="attribution">
        <p class="attribution-line"></p>
        <p class="attribution-meta"></p>
        <p class="attribution-disclaimer">Kein amtlicher Auszug · Angaben ohne Gewähr.</p>
      </div>
    </article>
  `;

  const goBack = () => {
    if (lastSearchKey) {
      const [q, c] = lastSearchKey.split('::');
      setHash({ q, c });
    } else setHash({});
  };
  els.detail.querySelector('.detail-close').addEventListener('click', goBack);
  const backBtn = els.detail.querySelector('.detail-back');
  backBtn.textContent = backLabel;
  backBtn.addEventListener('click', goBack);
  const idEl = els.detail.querySelector('.hit-id');
  idEl.textContent = c.nationalId;
  idEl.addEventListener('click', () => copyToClipboard(c.nationalId));

  els.detail.querySelector('h2').textContent = c.legalName || '(ohne Namen)';

  const flagsEl = els.detail.querySelector('.detail-flags');
  const flags = [];
  if (c.flags?.bankrupt) flags.push({ label: 'Insolvenz', cls: 'bad' });
  if (c.flags?.inLiquidation) flags.push({ label: 'Liquidation', cls: 'warn' });
  if (c.status === 'dissolved') flags.push({ label: 'gelöscht', cls: 'bad' });
  if (c.lei) flags.push({ label: `LEI ${c.lei}`, cls: 'muted' });
  for (const f of flags) {
    const span = document.createElement('span');
    span.className = `detail-flag ${f.cls}`;
    span.textContent = f.label;
    flagsEl.appendChild(span);
  }

  const dl = els.detail.querySelector('.detail-fields');
  const rows = [
    ['Land',       country ? `${country.label} (${c.country})` : c.country],
    ['Rechtsform', c.legalFormText || c.legalFormCode || null],
    ['Status',     c.status],
    ['Adresse',    c.address],
    ['Gründung',   c.incorporationDate],
    ['Branche',    c.nace ? [c.nace.code, c.nace.text].filter(Boolean).join(' – ') : null],
    ['Mitarbeiter', typeof c.employeeCount === 'number' ? c.employeeCount.toLocaleString('de-AT') : null],
    ['Kapital',    c.capital ? `${c.capital.amount.toLocaleString('de-AT')} ${c.capital.currency || ''}`.trim() : null],
    ['Website',    c.website ? { link: c.website } : null],
    ['Telefon',    c.phone],
    ['E-Mail',     c.email ? { link: `mailto:${c.email}`, text: c.email } : null],
    ['Frühere Namen', Array.isArray(c.previousNames) && c.previousNames.length
      ? c.previousNames.map((n) => n.until ? `${n.name} (bis ${String(n.until).slice(0,10)})` : n.name).join(' · ')
      : null],
  ];
  for (const [label, val] of rows) {
    if (val === null || val === undefined || val === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (val && typeof val === 'object' && val.link) {
      const a = document.createElement('a');
      a.href = val.link.startsWith('http') || val.link.startsWith('mailto:') ? val.link : `https://${val.link}`;
      a.rel = 'noopener noreferrer'; a.target = '_blank';
      a.textContent = val.text || val.link;
      dd.appendChild(a);
    } else {
      dd.textContent = String(val);
    }
    dl.appendChild(dt); dl.appendChild(dd);
  }

  if (c.parent || c.ultimateParent) {
    const groupWrap = els.detail.querySelector('.detail-group');
    groupWrap.hidden = false;
    const rowsEl = groupWrap.querySelector('.group-rows');
    const entries = [];
    if (c.parent) entries.push(['Muttergesellschaft', c.parent]);
    if (c.ultimateParent) entries.push(['Ultimate Parent', c.ultimateParent]);
    for (const [label, p] of entries) {
      const row = document.createElement('div');
      row.className = 'group-row';
      const navigable = !!countries.find((cc) => cc.id === p.jurisdiction) && !!p.nationalId;
      const jurLabel = countries.find((cc) => cc.id === p.jurisdiction)?.label || p.jurisdiction;
      row.innerHTML = `<span class="group-label"></span><span class="group-name"></span><span class="group-meta"></span>`;
      row.querySelector('.group-label').textContent = label;
      const nameEl = row.querySelector('.group-name');
      if (navigable) {
        const a = document.createElement('a');
        a.href = '#'; a.textContent = p.name || p.lei;
        a.addEventListener('click', (ev) => { ev.preventDefault(); setHash({ kind: 'detail', country: p.jurisdiction, id: p.nationalId }); });
        nameEl.appendChild(a);
      } else {
        nameEl.textContent = p.name || p.lei;
      }
      row.querySelector('.group-meta').textContent =
        [jurLabel, p.nationalId || (p.lei ? `LEI ${p.lei}` : '')].filter(Boolean).join(' · ');
      rowsEl.appendChild(row);
    }
  }

  if (score && typeof score.score === 'number') {
    const scoreWrap = els.detail.querySelector('.detail-score');
    scoreWrap.hidden = false;
    scoreWrap.querySelector('.score-value').textContent = score.score;
    const grade = scoreWrap.querySelector('.score-grade');
    grade.textContent = score.grade || '';
    grade.className = `score-grade grade-${String(score.grade || '').toLowerCase()}`;
    const bdList = scoreWrap.querySelector('.score-breakdown');
    for (const b of score.breakdown || []) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="bd-label"></span><span class="bd-bar"><span class="bd-fill"></span></span><span class="bd-contrib"></span>`;
      li.querySelector('.bd-label').textContent = b.label;
      li.querySelector('.bd-fill').style.width = `${Math.round((b.normalised ?? 0) * 100)}%`;
      li.querySelector('.bd-contrib').textContent = `+${b.contribution ?? 0}`;
      li.title = b.explanation || '';
      bdList.appendChild(li);
    }
  }

  if (Array.isArray(financials) && financials.length) {
    const finWrap = els.detail.querySelector('.detail-financials');
    finWrap.hidden = false;
    const tbody = finWrap.querySelector('tbody');
    const fmt = (v, cur) => v == null ? '—' : `${Number(v).toLocaleString('de-AT', { maximumFractionDigits: 0 })}${cur ? ' ' + cur : ''}`;
    const pct = (v) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
    for (const row of [...financials].reverse()) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="yr"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td><td class="num"></td>`;
      const cells = tr.querySelectorAll('td');
      cells[0].textContent = String(row.stichtag).slice(0, 10);
      cells[1].textContent = fmt(row.umsatzerloese, row.currency);
      cells[2].textContent = fmt(row.jahresergebnis, row.currency);
      cells[3].textContent = fmt(row.eigenkapital, row.currency);
      cells[4].textContent = fmt(row.bilanzsumme, row.currency);
      cells[5].textContent = pct(row.ek_quote);
      tbody.appendChild(tr);
    }
  }

  // Latest year with a parsed balance sheet drives the Bilanz / Kennzahlen view.
  const latestBalance = Array.isArray(financials)
    ? [...financials].reverse().find((r) => r.balanceSheet)
    : null;
  if (latestBalance) renderBilanz(els.detail.querySelector('.detail-bilanz'), latestBalance);

  // `hasAnyFinancials` is broader than `latestBalance`: it's true whenever
  // at least one year of parsed Kennzahlen (scalar or tree) is available,
  // which drives the friendly-vs-apologetic tone of the documents note.
  const hasAnyFinancials = Array.isArray(financials) && financials.some(
    (r) => r.umsatzerloese != null || r.bilanzsumme != null
        || r.eigenkapital != null || r.jahresergebnis != null
        || r.betriebsergebnis != null || r.balanceSheet,
  );
  // Original documents fallback — shown whenever the adapter enumerated filings.
  // Particularly useful for AT companies that file only PDF Jahresabschlüsse
  // (many large corporations do this; our XML parser can't read them).
  if (Array.isArray(documents) && documents.length) {
    renderDocuments(els.detail.querySelector('.detail-documents'), c, documents, hasAnyFinancials);
  }

  if (Array.isArray(people) && people.length) {
    const peopleWrap = els.detail.querySelector('.detail-people');
    peopleWrap.hidden = false;
    const peopleList = peopleWrap.querySelector('.people-list');
    for (const p of people) {
      const li = document.createElement('li');
      li.className = p.resigned ? 'person resigned' : 'person';
      li.innerHTML = `<span class="person-role"></span><span class="person-name"></span>`;
      li.querySelector('.person-role').textContent = p.role || p.roleCode || '—';
      li.querySelector('.person-name').textContent = p.resigned ? `${p.name} (ausgeschieden)` : p.name;
      peopleList.appendChild(li);
    }
  }

  const attribLine = els.detail.querySelector('.attribution-line');
  if (country?.attribution) {
    if (country.sourceUrl) {
      const a = document.createElement('a');
      a.href = country.sourceUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = country.sourceLabel || country.sourceUrl;
      attribLine.textContent = '';
      attribLine.appendChild(a);
      attribLine.appendChild(document.createTextNode(' · '));
      attribLine.appendChild(document.createTextNode(country.attribution));
    } else {
      attribLine.textContent = country.attribution;
    }
  } else {
    attribLine.textContent = `Quelle: ${c.source}`;
  }
  const meta = [];
  if (c.lastUpdated) meta.push(`Stand beim Register: ${formatDate(c.lastUpdated)}`);
  if (c.fetchedAt)   meta.push(`Abgerufen: ${formatDate(c.fetchedAt)}`);
  els.detail.querySelector('.attribution-meta').textContent = meta.join(' · ');

  // No auto-scroll needed — detail view now replaces results at top of page.
}

// ─────────── Bilanz / Kennzahlen ───────────
// Renders the Austrian UGB-style balance sheet breakdown + WU ratio set.
// Input: one `financials_yearly` row that has `.balanceSheet` (full tree)
// and optionally `.ratios` (precomputed server-side).
function renderBilanz(wrap, row) {
  if (!wrap || !row?.balanceSheet) return;
  wrap.hidden = false;
  const cur = row.currency || 'EUR';
  const sym = { EUR: '€', USD: '$', GBP: '£', NOK: 'kr', SEK: 'kr', DKK: 'kr', CHF: 'CHF', PLN: 'zł' }[cur] || cur;
  const money = (v) => v == null ? null : `${sym} ${Number(v).toLocaleString('de-AT', { maximumFractionDigits: 0 })}`;
  const pctStr = (v) => v == null ? null : `${(v * 100).toFixed(1)}%`;
  const share = (part, whole) => (part == null || !whole) ? null : ` (${Math.round((part / whole) * 100)}%)`;

  wrap.querySelector('.bilanz-stichtag').textContent = row.stichtag ? `Geschäftsjahr ${String(row.stichtag).slice(0, 4)}` : '';

  // ── Tab 1: Bilanz ──
  const bs = row.balanceSheet;
  const a = bs.aktiva || {};
  const p = bs.passiva || {};
  const av = a.anlagevermoegen || {};
  const uv = a.umlaufvermoegen || {};
  const ek = p.eigenkapital || {};
  const bg = ek.bilanzgewinn || {};
  const vb = p.verbindlichkeiten || {};

  const total = a.total ?? p.total ?? row.bilanzsumme;
  const card = (cls, icon, title, desc, total, items, color) => {
    const itemsHtml = items.filter((i) => i.v != null).map((i) =>
      `<li><span class="bilanz-item-label">${i.label}</span><span class="bilanz-item-value">${money(i.v)}${i.showShare ? `<span class="bilanz-item-share">${share(i.v, total) || ''}</span>` : ''}</span></li>`
    ).join('');
    return `
      <div class="bilanz-card bilanz-card-${cls}">
        <div class="bilanz-card-head">
          <span class="bilanz-card-title"><span class="bilanz-card-icon">${icon}</span>${title}</span>
          ${total != null ? `<span class="bilanz-card-total" style="color:${color}">${money(total)}</span>` : ''}
        </div>
        ${desc ? `<p class="bilanz-card-desc">${desc}</p>` : ''}
        ${itemsHtml ? `<ul class="bilanz-card-items">${itemsHtml}</ul>` : ''}
      </div>`;
  };

  const bilanzHtml = `
    <div class="bilanz-summary">
      <div class="bilanz-summary-label">⚖ Bilanzsumme</div>
      <div class="bilanz-summary-value">${money(total) || '—'}</div>
      <div class="bilanz-summary-sub">Summe der Aktiva/Passiva</div>
    </div>
    <div class="bilanz-grid">
      <div class="bilanz-col bilanz-col-aktiva">
        ${card('anlage', '🏢', 'Anlagevermögen',
          'Langfristige Vermögenswerte, die dem Unternehmen dauerhaft dienen',
          av.total, [
            { label: 'Immaterielle Vermögensgegenstände', v: av.immaterielle, showShare: true },
            { label: 'Sachanlagen', v: av.sachanlagen, showShare: true },
            { label: 'Finanzanlagen', v: av.finanzanlagen, showShare: true },
          ], '#e91e63')}
        ${card('umlauf', '💵', 'Umlaufvermögen',
          'Kurzfristige Vermögenswerte, die zur Veräußerung, Verarbeitung oder Rückzahlung bestimmt sind',
          uv.total, [
            { label: 'Vorräte', v: uv.vorraete, showShare: true },
            { label: 'Forderungen und sonstige Vermögensgegenstände', v: uv.forderungen, showShare: true },
            { label: 'Wertpapiere und Anteile', v: uv.wertpapiere, showShare: true },
            { label: 'Kassenbestand, Schecks, Guthaben bei Kreditinstituten', v: uv.kassenbestand, showShare: true },
          ], '#14b8a6')}
        ${a.rechnungsabgrenzung != null ? card('rap', '📄', 'Rechnungsabgrenzungsposten',
          'Ausgaben vor dem Abschlussstichtag, die Aufwand für bestimmte Zeit danach darstellen',
          a.rechnungsabgrenzung, [], '#f59e0b') : ''}
      </div>
      <div class="bilanz-col bilanz-col-passiva">
        ${card('ek', '🪙', 'Eigenkapital',
          'Von Eigentümern eingebrachtes Kapital und erwirtschaftete Überschüsse',
          ek.total, [
            { label: 'Eingefordertes Stammkapital', v: ek.stammkapital, showShare: false },
            { label: 'Kapitalrücklagen', v: ek.kapitalruecklagen, showShare: false },
            { label: 'Gewinnrücklagen', v: ek.gewinnruecklagen, showShare: false },
            { label: 'Bilanzgewinn', v: bg.total, showShare: false },
          ], '#10b981')}
        ${p.rueckstellungen != null ? card('rueck', '🛡', 'Rückstellungen',
          'Verbindlichkeiten, die aufgrund von zukünftigen Ereignissen entstehen',
          p.rueckstellungen, [], '#f59e0b') : ''}
        ${card('verb', '💳', 'Verbindlichkeiten',
          'Finanzielle Verpflichtungen gegenüber anderen',
          vb.total, [
            { label: 'davon langfristige', v: vb.langfristig, showShare: true },
          ], '#ef4444')}
      </div>
    </div>
    ${bg.total != null ? `
      <div class="bilanz-bilanzgewinn ${bg.total < 0 ? 'is-loss' : ''}">
        <div class="bilanz-bg-head">
          <span class="bilanz-card-title"><span class="bilanz-card-icon">${bg.total < 0 ? '📉' : '🏆'}</span>${bg.total < 0 ? 'Bilanzverlust' : 'Bilanzgewinn'}</span>
          <span class="bilanz-bg-total">${money(bg.total)}</span>
        </div>
        <div class="bilanz-bg-split">
          ${bg.gewinnvortrag != null ? `
            <div class="bilanz-bg-item ${bg.gewinnvortrag < 0 ? 'is-loss' : ''}">
              <div class="bilanz-bg-label">⏳ ${bg.gewinnvortrag < 0 ? 'Verlustvortrag' : 'Gewinnvortrag'}</div>
              <div class="bilanz-bg-value">${money(bg.gewinnvortrag)}</div>
              <div class="bilanz-bg-meta">${bg.total ? `${Math.round((bg.gewinnvortrag / bg.total) * 100)}% des Gesamtergebnisses` : ''}</div>
            </div>` : ''}
          ${bg.jahresueberschuss != null ? `
            <div class="bilanz-bg-item ${bg.jahresueberschuss < 0 ? 'is-loss' : ''}">
              <div class="bilanz-bg-label">📈 Laufendes Ergebnis</div>
              <div class="bilanz-bg-value">${money(bg.jahresueberschuss)}</div>
              <div class="bilanz-bg-meta">${bg.total ? `${Math.round((bg.jahresueberschuss / bg.total) * 100)}% des Gesamtergebnisses` : ''}</div>
            </div>` : ''}
        </div>
      </div>` : ''}
  `;
  wrap.querySelector('.bilanz-pane-bilanz').innerHTML = bilanzHtml;

  // ── Tab 2: Kennzahlen ──
  const r = row.ratios || {};
  const kpi = (icon, label, value) => `
    <div class="kpi">
      <div class="kpi-label">${icon ? `<span class="kpi-icon">${icon}</span>` : ''}${label}</div>
      <div class="kpi-value ${value == null ? 'kpi-na' : ''}">${value ?? 'Nicht verfügbar'}</div>
    </div>`;
  const group = (icon, title, items) => `
    <div class="kpi-group">
      <h4 class="kpi-group-title"><span class="kpi-group-icon">${icon}</span>${title}</h4>
      ${items.join('')}
    </div>`;

  const kennzHtml = `
    <div class="kpi-grid">
      ${group('%', 'Kapitalstruktur', [
        kpi('%', 'Eigenkapitalquote',     pctStr(r.ekQuote)),
        kpi('$', 'Fremdkapitalquote',     pctStr(r.fkQuote)),
        kpi('🏢','Anlagenintensität',     pctStr(r.anlagenintensitaet)),
        kpi('💵','Umlaufintensität',      pctStr(r.umlaufintensitaet)),
        kpi('↓', 'Verschuldungsgrad',     pctStr(r.verschuldungsgrad)),
      ])}
      ${group('💳', 'Liquidität', [
        kpi('💳','Liquidität 1. Grades',  pctStr(r.liquiditaet1Grad)),
        kpi('💳','Liquidität 2. Grades',  pctStr(r.liquiditaet2Grad)),
        kpi('💳','Liquidität 3. Grades',  pctStr(r.liquiditaet3Grad)),
        kpi('📈','Working Capital',       money(r.workingCapital)),
      ])}
      ${group('🏆', 'Kapitalrendite', [
        kpi('🪙','Return on Equity (ROE)',pctStr(r.roe)),
        kpi('💵','Return on Assets (ROA)',pctStr(r.roa)),
        kpi('🏢','Anlagendeckungsgrad',   pctStr(r.anlagendeckungsgrad)),
        kpi('📦','Investiertes Kapital',  money(r.investiertesKapital)),
      ])}
    </div>
    <p class="kpi-attrib">Berechnungsmethoden in Kooperation mit WU Wien · Abteilung für Unternehmensrechnung und Revision</p>
  `;
  wrap.querySelector('.bilanz-pane-kennzahlen').innerHTML = kennzHtml;

  // Note shown below the panes — explains when ROE / ROA come back as N/A.
  const hasGuv = row.jahresergebnis != null;
  const note = wrap.querySelector('.bilanz-note');
  note.textContent = row.stichtag
    ? `Die Daten basieren auf dem letzten veröffentlichten maschinell lesbaren Jahresabschluss aus dem Geschäftsjahr ${String(row.stichtag).slice(0, 4)}.${hasGuv ? '' : ' Dieses Unternehmen hat keine vollständige Gewinn- und Verlustrechnung (GuV) veröffentlicht. Daher sind nur bilanzbasierte Kennzahlen verfügbar.'}`
    : '';

  // Tab wiring.
  const tabs = wrap.querySelectorAll('.bilanz-tab');
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.toggle('is-active', b === btn));
      wrap.querySelector('.bilanz-pane-bilanz').hidden = btn.dataset.tab !== 'bilanz';
      wrap.querySelector('.bilanz-pane-kennzahlen').hidden = btn.dataset.tab !== 'kennzahlen';
    });
  });
}

// ─────────── Original-Dokumente ───────────
// Fallback / supplement to the parsed balance sheet. Each entry can offer an
// XML link (machine-readable source — what our parser used) and/or a PDF link
// (human-readable original — useful when no XML is available).
function renderDocuments(wrap, company, documents, hasParsedBalance) {
  if (!wrap || !documents?.length) return;
  wrap.hidden = false;
  const noteEl = wrap.querySelector('.documents-note');
  const listEl = wrap.querySelector('.documents-list');
  listEl.innerHTML = '';

  const onlyPdf = documents.every((d) => !d.xmlKey && d.pdfKey);
  if (!hasParsedBalance && onlyPdf) {
    noteEl.textContent =
      'Kennzahlen konnten aus diesen Einreichungen nicht zuverlässig extrahiert werden. '
      + 'Originalauszüge zum Download unten — in der Regel PDF-Jahresabschlüsse beim Register.';
  } else if (!hasParsedBalance) {
    noteEl.textContent = 'Originalauszüge der beim Register eingereichten Jahresabschlüsse.';
  } else {
    noteEl.textContent = 'Zugehörige Originalauszüge — ' + (onlyPdf
      ? 'PDF zum Lesen.'
      : 'XML maschinenlesbar, PDF zum Lesen.');
  }

  const countryPath = encodeURIComponent(company.country);
  const idPath = encodeURIComponent(company.nationalId);

  for (const d of documents) {
    const li = document.createElement('li');
    li.className = 'document-row';
    const year = document.createElement('span');
    year.className = 'document-year';
    // Many older JustizOnline filings ship without DOKUMENTENDATUM. Rather
    // than displaying "null", fall back to "—" (or an approximate year
    // extracted from the filing KEY, which is roughly chronological).
    year.textContent = d.stichtag ? String(d.stichtag).slice(0, 10) : '—';
    li.appendChild(year);
    if (d.title) {
      const title = document.createElement('span');
      title.className = 'document-title';
      title.textContent = d.title;
      li.appendChild(title);
    }
    const links = document.createElement('span');
    links.className = 'document-links';
    if (d.pdfKey) {
      const a = document.createElement('a');
      a.href = `/api/company/${countryPath}/${idPath}/document/${encodeURIComponent(d.pdfKey)}`;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'document-link document-link-pdf';
      a.textContent = 'PDF';
      links.appendChild(a);
    }
    if (d.xmlKey) {
      const a = document.createElement('a');
      a.href = `/api/company/${countryPath}/${idPath}/document/${encodeURIComponent(d.xmlKey)}`;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'document-link document-link-xml';
      a.textContent = 'XML';
      links.appendChild(a);
    }
    li.appendChild(links);
    listEl.appendChild(li);
  }
}

function hideDetail() { els.detail.hidden = true; els.detail.innerHTML = ''; }

// ─────────── Keyboard ───────────
function onKeyDown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.input.focus();
    els.input.select();
    return;
  }
  if (e.key === 'Escape') {
    if (!els.detail.hidden) {
      if (lastSearchKey) {
        const [q, c] = lastSearchKey.split('::');
        setHash({ q, c });
      } else setHash({});
    } else if (document.activeElement === els.input) {
      els.input.blur();
    }
  }
  if (e.key === '/' && document.activeElement !== els.input) {
    e.preventDefault();
    els.input.focus();
    els.input.select();
  }
}

// ─────────── Scroll-to-top ───────────
function onScroll() {
  els.scrollTop.hidden = window.scrollY < 600;
}

// ─────────── Clipboard + toast ───────────
function copyToClipboard(text) {
  if (!text) return;
  const done = () => showToast(`„${text}" kopiert`);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { /* ignore */ }
  document.body.removeChild(ta);
}
let toastTimer = null;
function showToast(msg) {
  clearTimeout(toastTimer);
  els.toast.textContent = msg;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    setTimeout(() => { els.toast.hidden = true; }, 240);
  }, 1600);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toISOString().slice(0, 10);
}
function setStatus(msg) { els.status.textContent = msg; }

init();
