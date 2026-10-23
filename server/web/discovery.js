// Website discovery for AT firms (plans/investor-screening.md, Phase 5).
//
// Candidates are the Firmenbuch homepage (rare) and domains guessed from the
// Firmenwortlaut. A candidate counts as the firm's site only if its homepage
// or Impressum carries the firm's FN — § 14 UGB and § 5 ECG require it there,
// and the check letter makes a chance hit practically impossible. Name + PLZ
// is the weaker fallback for sites without an FN. No search engine, no LLM.
//
// Politeness: robots.txt per host, ≥ 1 s between requests to one host, at
// most a homepage and three Impressum/Kontakt pages per candidate domain.
import { Resolver } from 'node:dns/promises';
import { fnCanonFromDigits } from '../adapters/at.js';

const UA = 'Mozilla/5.0 (compatible; KonturBot/0.1; Impressum-Abgleich)';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const HOST_GAP_MS = 1_000;
const TLDS = ['at', 'com', 'eu', 'de'];
const MAX_LABELS = 7;
const MAX_HTTP_DOMAINS = 8;      // resolving candidates fetched per firm
const MAX_SUBPAGES = 3;          // Impressum/Kontakt pages per domain

// ─── Domain candidates ───────────────────────────────────────────────────

const fold = (s, umlaut = 'e') => String(s || '').toLowerCase()
  .replace(/ä/g, umlaut === 'e' ? 'ae' : 'a').replace(/ö/g, umlaut === 'e' ? 'oe' : 'o')
  .replace(/ü/g, umlaut === 'e' ? 'ue' : 'u').replace(/ß/g, 'ss')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

// Legal forms and connectors, matched on folded text before tokenising.
const LEGAL_FORM = /\b(gesellschaft\s*m\.?\s*b\.?\s*h\.?|ges\.?\s*m\.?\s*b\.?\s*h\.?|gesmbh|gmbh|m\.\s*b\.\s*h\.?|mbh|aktiengesellschaft|ag|kg|og|keg|oeg|e\.\s*u\.?|se|nfg\.?|co\.?|und|u\.|the|of)(?=\W|$)/g;
// Dropped for the short variants ("Bernard Gruppe ZT" → bernard), kept in the full one.
const GENERIC = new Set(['handelsgesellschaft', 'handels', 'handel', 'gruppe', 'group', 'austria', 'oesterreich',
  'osterreich', 'international', 'holding', 'gesellschaft', 'ges', 'zt', 'ziviltechniker', 'dipl', 'ing', 'mag', 'dr',
  'gmbh', 'vertrieb', 'vertriebs', 'service', 'services', 'werk', 'werke', 'technik', 'solutions', 'systems']);

const COMPOUND_TAIL = /^(.{4,}?)(fabrik|werke?|technik|anlagen|bau|handel|logistik|systeme?|transporte?)$/;

function nameTokens(name, umlaut) {
  return fold(name, umlaut).replace(LEGAL_FORM, ' ').split(/[^a-z0-9]+/).filter(Boolean);
}

/** Host labels to try, most likely first ("cms electronics gmbh" → cms-electronics, cms, …). */
export function domainLabels(name) {
  const labels = [];
  const add = (parts) => {
    if (!parts.length) return;
    for (const l of [parts.join('-'), parts.join('')]) {
      if (l.length >= 3 && l.length <= 40 && !labels.includes(l)) labels.push(l);
    }
  };
  for (const umlaut of ['e', 'a']) {
    const all = nameTokens(name, umlaut);
    const sig = all.filter((t) => !GENERIC.has(t));
    if (sig[0] && sig[0].length >= 3) add(sig.slice(0, 1));
    if (sig.length >= 2) add(sig.slice(0, 2));
    if (sig.length > 2) add(sig);
    if (all.length > sig.length) add(all);
    // Initials, compounds split first: "Leobersdorfer Maschinenfabrik" → l·m·f → lmf.
    const initials = sig.slice(0, 4).flatMap((t) => COMPOUND_TAIL.exec(t)?.slice(1) || [t]).map((t) => t[0]).join('');
    if (sig.length >= 2 && initials.length >= 3 && sig[0] !== initials) add([initials]);
  }
  return labels.slice(0, MAX_LABELS);
}

const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : `http://${u}`).host.toLowerCase(); } catch { return null; } };
const bareHost = (h) => (h || '').replace(/^www\./, '');

/** Ordered candidate domains: Firmenbuch homepage first, then guesses × TLD. */
export function domainCandidates({ name, homepage }, extra = []) {
  const out = [];
  const fb = homepage ? bareHost(hostOf(homepage)) : null;
  if (fb) out.push({ domain: fb, source: 'firmenbuch' });
  domainLabels(name).forEach((label, i) => {
    // .co.at is common for older Austrian firms; only for the two likeliest labels.
    for (const tld of i < 2 ? [...TLDS, 'co.at'] : TLDS) {
      const domain = `${label}.${tld}`;
      if (!out.some((c) => c.domain === domain)) out.push({ domain, source: 'domain' });
    }
  });
  for (const domain of extra) {
    if (!out.some((c) => c.domain === domain)) out.push({ domain, source: 'suche' });
  }
  return out;
}

// ─── Page text and matching ──────────────────────────────────────────────

const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', copy: '©', middot: '·', ndash: '–', mdash: '—',
  ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwnj: '' };

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m)
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// "FN 123456 a", "FN: 123456a", "Firmenbuchnummer 123456 a", "FN-Nr. 123456a",
// "Commercial register no. 123456 a" — the check letter must be valid.
const FN_MENTION = /(?:\bfn|\bfbn|firmenbuch[a-z-]*|register(?:ed)?(?: no\.?| number| nr\.?)?|registernummer)\s*[:.\-]?\s*(?:nr\.?|no\.?)?\s*[:.]?\s*(\d{1,6})\s*[-/ ]?\s*([a-z])(?![a-z0-9])/gi;

export function extractFns(text) {
  const found = new Set();
  for (const m of String(text).matchAll(FN_MENTION)) {
    const canon = `${m[1].padStart(6, '0')}${m[2].toLowerCase()}`;
    if (fnCanonFromDigits(m[1]) === canon) found.add(canon);
  }
  return [...found];
}

function ownFnPattern(canon) {
  const digits = canon.slice(0, 6).replace(/^0+/, '');
  const letter = canon.slice(6);
  return new RegExp(`(?<![0-9])0*${digits}\\s?[-/ ]?\\s?${letter}(?![a-z0-9])`, 'i');
}

const snippet = (text, idx, len) => text.slice(Math.max(0, idx - 60), idx + len + 40).replace(/\s+/g, ' ').trim();

/** Classifies one page: own FN, other FNs, or Name + PLZ. */
export function matchPage(text, firm) {
  const own = text.match(ownFnPattern(firm.canon));
  const others = extractFns(text).filter((fn) => fn !== firm.canon);
  if (own) return { level: 'fn', evidence: snippet(text, own.index, own[0].length), others };
  if (others.length) return { level: 'andere_fn', evidence: null, others };
  const folded = fold(text);
  const core = firm.nameCore;
  if (firm.plz && core && new RegExp(`(?<![0-9])${firm.plz}(?![0-9])`).test(text) && folded.includes(core)) {
    const i = folded.indexOf(core);
    return { level: 'name_plz', evidence: snippet(text, i, core.length), others };
  }
  return { level: null, evidence: null, others };
}

/** Folded name core for the Name + PLZ check: the first two significant tokens. */
export function nameCore(name) {
  const sig = nameTokens(name, 'e').filter((t) => !GENERIC.has(t));
  const core = sig.slice(0, sig[0]?.length >= 5 ? 1 : 2).join(' ');
  return core.length >= 4 ? core : null;
}

/**
 * Is the firm named by another FN on the site related to ours (parent,
 * sister)? Same leading name token or same PLZ — "CANCOM a + d" and
 * "CANCOM Austria AG" are; "Faber-Castell Trading" and a "Faber" are not.
 */
export function relatedFirm(firm, other) {
  // Hyphenated brands stay whole: "faber-castell" ≠ "faber".
  const lead = (n) => fold(n).replace(LEGAL_FORM, ' ').split(/[^a-z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, '')).find((t) => t && !GENERIC.has(t));
  const a = lead(firm.name), b = lead(other.name);
  return Boolean((a && b && a === b) || (firm.plz && other.plz && firm.plz === other.plz));
}

// Impressum first, then legal/offenlegung, then Kontakt/About.
const SUBPAGE_RULES = [
  [3, /impressum|imprint/],
  [2, /offenlegung|legal|rechtliche|rechtliches|disclaimer/],
  [1, /kontakt|contact|about|ueber-uns|uber-uns|unternehmen|company/],
];

export function subpageLinks(html, baseUrl) {
  const links = new Map();
  for (const m of String(html).matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[2].trim();
    if (!href || /^(mailto|tel|javascript):/i.test(href) || href.startsWith('#')) continue;
    const label = fold(htmlToText(m[3]) + ' ' + href);
    const rule = SUBPAGE_RULES.find(([, re]) => re.test(label));
    if (!rule) continue;
    let url;
    try { url = new URL(href, baseUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || /\.(pdf|jpe?g|png|zip)$/i.test(url.pathname)) continue;
    url.hash = '';
    const key = url.href;
    if (!links.has(key) || links.get(key) < rule[0]) links.set(key, rule[0]);
  }
  return [...links].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

// ─── HTTP with robots.txt and per-host spacing ───────────────────────────

export function parseRobots(txt) {
  const groups = [];
  let cur = null, lastUa = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastUa) groups.push(cur = { agents: [], rules: [] });
      cur.agents.push(val.toLowerCase());
      lastUa = true;
      continue;
    }
    lastUa = false;
    if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', path: val });
  }
  const g = groups.find((x) => x.agents.some((a) => a.includes('konturbot'))) || groups.find((x) => x.agents.includes('*'));
  return g ? g.rules : [];
}

export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= MAX_BYTES) { reader.cancel().catch(() => {}); break; }
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
  let dec;
  try { dec = new TextDecoder(charset || 'utf-8'); } catch { dec = new TextDecoder('utf-8'); }
  return dec.decode(Buffer.concat(chunks));
}

/**
 * Shared fetch context: DNS cache, robots cache, per-host spacing and a page
 * cache, so firms sharing a guessed domain cost one request.
 */
export function createContext({ timeoutMs = TIMEOUT_MS } = {}) {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  const dnsCache = new Map(), robotsCache = new Map(), pageCache = new Map(), nextSlot = new Map();
  let requests = 0;

  async function throttle(host) {
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(host) || 0);
    nextSlot.set(host, at + HOST_GAP_MS);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  async function rawFetch(url) {
    await throttle(new URL(url).host);
    requests++;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow', signal: ac.signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'de-AT,de;q=0.9,en;q=0.6' },
      });
      const type = res.headers.get('content-type') || '';
      const body = res.ok && /html|xml|text\/plain/i.test(type) ? await readCapped(res) : null;
      if (!body) res.body?.cancel().catch(() => {});
      return { status: res.status, url: res.url || url, body };
    } catch (e) {
      return { status: 0, url, body: null, error: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
    } finally { clearTimeout(t); }
  }

  async function resolves(domain) {
    if (!dnsCache.has(domain)) {
      dnsCache.set(domain, (async () => {
        for (const h of [domain, `www.${domain}`]) {
          try { if ((await resolver.resolve4(h)).length) return true; } catch {}
        }
        return false;
      })());
    }
    return dnsCache.get(domain);
  }

  async function robotsFor(origin) {
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, rawFetch(`${origin}/robots.txt`).then((r) => {
        if (r.status >= 500) return [{ allow: false, path: '/' }];
        return r.status === 200 && r.body ? parseRobots(r.body) : [];
      }));
    }
    return robotsCache.get(origin);
  }

  /** GET an HTML page if robots.txt allows it; cached per URL. */
  async function page(url) {
    if (!pageCache.has(url)) {
      pageCache.set(url, (async () => {
        const u = new URL(url);
        if (!robotsAllows(await robotsFor(u.origin), u.pathname + u.search)) return { status: 'robots', url, body: null };
        return rawFetch(url);
      })());
    }
    return pageCache.get(url);
  }

  return { resolves, page, get requests() { return requests; } };
}

// ─── Discovery for one firm ──────────────────────────────────────────────

async function homepageOf(ctx, domain) {
  let last = { status: 0, body: null };
  for (const url of [`https://${domain}/`, `https://www.${domain}/`, `http://www.${domain}/`]) {
    const r = await ctx.page(url);
    if (r.body || r.status === 'robots') return r;
    if (r.status) last = r;        // keep a real HTTP status (403) over a later connection error
  }
  return last;
}

// The site answers but refuses us (WAF, bot protection): reported, never evaded.
const BLOCKED = new Set([401, 403, 429, 503]);

/**
 * firm: { canon, name, homepage?, plz? } → { status, domain, url,
 * impressumUrl, evidence, otherFns, source, candidates }.
 */
export async function discoverWebsite(ctx, firm) {
  const f = { ...firm, nameCore: nameCore(firm.name) };
  const candidates = [];
  let best = null;          // strongest non-FN result so far
  let blocked = null;       // first candidate that refused the request
  let fetched = 0;

  for (const cand of domainCandidates(f, firm.searchDomains || [])) {
    if (fetched >= MAX_HTTP_DOMAINS) break;
    if (!(await ctx.resolves(cand.domain))) continue;     // no DNS: not even logged
    fetched++;
    const home = await homepageOf(ctx, cand.domain);
    if (home.status === 'robots') { candidates.push({ domain: cand.domain, result: 'robots.txt' }); continue; }
    if (!home.body) {
      candidates.push({ domain: cand.domain, result: home.error || `HTTP ${home.status}` });
      if (BLOCKED.has(home.status) && !blocked) blocked = { domain: cand.domain, url: home.url, source: cand.source };
      continue;
    }

    const finalHost = bareHost(hostOf(home.url));
    const pages = [{ url: home.url, text: htmlToText(home.body) }];
    let result = null;
    const check = (p) => {
      const m = matchPage(p.text, f);
      if (m.level === 'fn') return { ...m, url: p.url };
      if (m.level && (!result || rank(m.level) > rank(result.level))) result = { ...m, url: p.url };
      else if (m.others.length && result) result.others = [...new Set([...result.others, ...m.others])];
      return null;
    };
    let hit = check(pages[0]);
    // Menus built by JavaScript leave no links; /impressum is the usual path then.
    const links = subpageLinks(home.body, home.url).slice(0, MAX_SUBPAGES);
    if (!links.length) links.push(new URL('/impressum', home.url).href);
    for (const link of hit ? [] : links) {
      const sub = await ctx.page(link);
      if (!sub.body) continue;
      hit = check({ url: sub.url, text: htmlToText(sub.body) });
      if (hit) break;
    }
    if (hit) {
      candidates.push({ domain: cand.domain, result: 'FN' });
      return { status: 'fn', domain: finalHost, url: home.url, impressumUrl: hit.url, evidence: hit.evidence,
        otherFns: hit.others, source: cand.source, candidates };
    }
    candidates.push({ domain: cand.domain, result: result ? (result.level === 'andere_fn' ? `andere FN ${result.others.join(', ')}` : 'Name + PLZ') : 'kein Treffer' });
    if (result && (!best || rank(result.level) > rank(best.level))) {
      best = { ...result, domain: finalHost, home: home.url, source: cand.source };
    }
  }

  if (best) {
    return { status: best.level, domain: best.domain, url: best.home, impressumUrl: best.url, evidence: best.evidence,
      otherFns: best.others, source: best.source, candidates };
  }
  if (blocked) {
    return { status: 'blockiert', domain: blocked.domain, url: blocked.url, impressumUrl: null, evidence: null,
      otherFns: [], source: blocked.source, candidates };
  }
  return { status: 'nicht_gefunden', domain: null, url: null, impressumUrl: null, evidence: null, otherFns: [], source: null, candidates };
}

// Name + PLZ beats a site that names another company's FN: the latter is
// usually a namesake or the parent's group site.
const rank = (level) => ({ name_plz: 2, andere_fn: 1 }[level] || 0);
