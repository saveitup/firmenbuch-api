// Website crawler for verified firm domains (plans/investor-screening.md,
// Phase 5). Loads the start page and up to 14 linked pages of the kinds an
// investor profile needs (Über uns, Leistungen, Referenzen, Team, Karriere,
// News, Standorte, Zertifikate, Kontakt, Impressum) and keeps cleaned text
// only. Robots.txt and per-host spacing come from the discovery context.
//
// Besides the text, the crawl records what only the HTML shows: language
// versions (hreflang, language switcher), shop markers and links to
// external job portals. Signals are drawn from all of it in signals.js.
import { htmlToText } from './discovery.js';

export const MAX_PAGES = 15;
const MAX_TEXT = 60_000;

// Page kinds with how many pages of each to load, most useful first.
// Patterns run on the folded link text plus URL path.
export const PAGE_KINDS = [
  ['impressum',   1, /impressum|imprint/],
  ['ueber_uns',   2, /ueber-?uns|uber-?uns|about|unternehmen|company|geschichte|history|historie|philosophie|wir-sind|who-we-are|portrait|portraet/],
  ['leistungen',  3, /leistung|services?\b|produkte|products|loesung|solution|kompetenz|portfolio|(?<!stellen)angebot|sortiment|technolog/],
  ['karriere',    2, /karriere|career|jobs?\b|stellen|bewerb|arbeiten-bei|work-with-us|join/],
  ['referenzen',  2, /referenz|reference|projekte|projects|kunden|customers|branchen|industries|case-stud/],
  ['team',        1, /team|management|geschaeftsfuehrung|geschaftsfuhrung|ansprechpartner|people|leitung|fuehrung/],
  ['standorte',   1, /standort|location|niederlassung|filiale|vertriebsnetz|weltweit|worldwide/],
  ['zertifikate', 1, /zertifi|certifi|qualitaet|qualitat|quality|iso-?\d/],
  ['news',        1, /news|aktuell|presse|press|blog|neuigkeit/],
  ['kontakt',     1, /kontakt|contact/],
];

const LANG_PREFIX = /^\/(de|en|fr|it|es|cs|cz|hu|pl|sk|sl|hr|ro|ru|nl|tr|zh|bg|sr|pt|sv|da|fi|no|ja)(?:[-_][a-z]{2})?(?:\/|$)/i;
const EXTERNAL_JOBS = /(^|\.)(personio\.(de|com)|softgarden\.(io|de)|prescreen\.io|lever\.co|greenhouse\.io|myworkdayjobs\.com|successfactors\.(com|eu)|rexx-systems\.com|dvinci|onlyfy\.(jobs|io)|recruitee\.com|smartrecruiters\.com|join\.com|karriere\.at|jobbase\.io|talentsconnect|umantis\.com|haufe-umantis|jobs\.ams\.at|hokify\.at|stepstone\.at|workwise\.io|bewerbung\.jobs)$/i;
const JOB_LIST = /offene|stellenangebot|stellenausschreibung|jobs|vacanc|openings|positionen/;
// A shop shows itself by buy buttons (visible text, see signals.js) or a
// Shopify store. Script names like "wc-add-to-cart" do not count —
// WooCommerce loads them on every page of a WordPress site — and neither
// does a bare /cart link from the theme header unless a link says "Shop".
const SHOPIFY = /cdn\.shopify\.com/i;
const CART_LINK = /href\s*=\s*["'][^"']*\/(?:warenkorb|cart|checkout)\b/i;
const SHOP_LABEL = /^(?:zum |zu unserem )?(?:online-?|web-?)?shop$|^shop\b|onlineshop|webshop/i;

const fold = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
const bare = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
const sameSite = (host, site) => { const h = bare(host); return h === site || h.endsWith(`.${site}`) || site.endsWith(`.${h}`); };

/** Visible text without navigation, header and (except on the start page) footer. */
export function mainText(html, { keepFooter = false } = {}) {
  let s = String(html || '')
    .replace(/<(nav|header|aside|form|button|select|dialog)\b[\s\S]*?<\/\1>/gi, ' ')
    // Cookie banners are the most common boilerplate that is not in a nav.
    .replace(/<div\b[^>]*(cookie|consent|gdpr|borlabs|cmplz)[^>]*>[\s\S]*?<\/div>/gi, ' ');
  if (!keepFooter) s = s.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');
  return htmlToText(s).slice(0, MAX_TEXT);
}

export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).replace(/\s+/g, ' ').slice(0, 200) : null;
}

/** Anchors as {url, text} — same-site HTML pages and external hosts separately. */
export function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const site = bare(base.host);
  const internal = [], external = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[2].trim().replace(/&amp;/g, '&');
    if (!href || /^(mailto|tel|javascript|data):/i.test(href) || href.startsWith('#')) continue;
    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const text = htmlToText(m[3]).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!sameSite(url.host, site)) { external.push({ url: url.href, host: bare(url.host), text }); continue; }
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|ics)$/i.test(url.pathname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    internal.push({ url: url.href, text });
  }
  return { internal, external };
}

/** Language codes the site offers: <html lang>, hreflang alternates, switcher links. */
export function siteLanguages(html, links) {
  const langs = new Set();
  const doc = /<html\b[^>]*\blang\s*=\s*["']?([a-z]{2})/i.exec(html || '');
  if (doc) langs.add(doc[1].toLowerCase());
  for (const m of String(html || '').matchAll(/hreflang\s*=\s*["']?([a-z]{2})(?:-[a-z]+)?["']?/gi)) langs.add(m[1].toLowerCase());
  for (const l of links) {
    const p = LANG_PREFIX.exec(new URL(l.url).pathname);
    const t = l.text.trim().toLowerCase();
    if (p && (t.length <= 12 || /^(deutsch|english|français|italiano|čeština|magyar|polski|slovenčina)/.test(t))) langs.add(p[1].toLowerCase().replace('cz', 'cs'));
    if (/^(english|en)$/.test(t)) langs.add('en');
    if (/^(deutsch|de)$/.test(t)) langs.add('de');
  }
  return [...langs].sort();
}

/**
 * Picks the pages to load from the start page's links: per kind the best
 * matches (link text before URL, shallow paths first), in the start page's
 * language, at most MAX_PAGES − 1 in all.
 */
export function selectPages(links, startUrl) {
  const start = new URL(startUrl);
  const startLang = LANG_PREFIX.exec(start.pathname)?.[1]?.toLowerCase() || null;
  const picked = [];
  const taken = new Set([start.href, `${start.origin}/`]);
  for (const [kind, limit, re] of PAGE_KINDS) {
    const scored = [];
    for (const l of links) {
      const u = new URL(l.url);
      if (taken.has(u.href) || u.search.length > 40) continue;
      const lang = LANG_PREFIX.exec(u.pathname)?.[1]?.toLowerCase() || null;
      if (lang && lang !== startLang && !(startLang === null && lang === 'de')) continue;
      const inText = re.test(fold(l.text));
      const inPath = re.test(fold(decodeURIComponent(u.pathname)));
      if (!inText && !inPath) continue;
      const depth = u.pathname.split('/').filter(Boolean).length;
      scored.push({ url: u.href, kind, score: (inText ? 10 : 0) + (inPath ? 5 : 0) - depth });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, limit)) {
      if (picked.length >= MAX_PAGES - 1) break;
      taken.add(s.url);
      picked.push(s);
    }
  }
  return picked;
}

/**
 * Crawls one site. Returns the pages (cleaned text, no HTML) and what the
 * HTML alone shows: languages, shop markers, external job portals and the
 * job-ad link texts of the career pages.
 */
export async function crawlSite(ctx, startUrl) {
  const home = await ctx.page(startUrl);
  if (!home.body) return { ok: false, status: home.status, error: home.error || null, pages: [], meta: {} };

  const homeUrl = home.url || startUrl;
  const { internal, external } = extractLinks(home.body, homeUrl);
  const pages = [{ url: homeUrl, kind: 'start', title: pageTitle(home.body), text: mainText(home.body, { keepFooter: true }), status: 200 }];
  const meta = {
    languages: siteLanguages(home.body, internal),
    shop: { shopify: SHOPIFY.test(home.body), cart: CART_LINK.test(home.body),
      label: [...internal, ...external].some((l) => SHOP_LABEL.test(l.text)) },
    jobsExternal: new Set(external.filter((l) => EXTERNAL_JOBS.test(l.host)).map((l) => l.host)),
    jobLinks: [],
  };

  const queue = selectPages(internal, homeUrl);
  const queued = new Set(queue.map((p) => p.url));
  for (let i = 0; i < queue.length && pages.length < MAX_PAGES; i++) {
    const p = queue[i];
    const r = await ctx.page(p.url);
    if (!r.body) continue;
    pages.push({ url: r.url || p.url, kind: p.kind, title: pageTitle(r.body), text: mainText(r.body), status: 200 });
    if (SHOPIFY.test(r.body)) meta.shop.shopify = true;
    const links = extractLinks(r.body, r.url || p.url);
    for (const l of links.external) if (EXTERNAL_JOBS.test(l.host)) meta.jobsExternal.add(l.host);
    // Job ads usually are links on the career page; their text carries the title.
    if (p.kind === 'karriere') {
      meta.jobLinks.push(...links.internal.map((l) => l.text), ...links.external.map((l) => l.text));
      // The openings often sit one level below the career page.
      const list = links.internal.find((l) => !queued.has(l.url)
        && JOB_LIST.test(fold(`${l.text} ${decodeURIComponent(new URL(l.url).pathname)}`)));
      if (list) { queued.add(list.url); queue.push({ url: list.url, kind: 'karriere' }); }
    }
    // Embedded job widgets (iframes) of external portals.
    for (const m of r.body.matchAll(/<iframe\b[^>]*src\s*=\s*["']([^"']+)/gi)) {
      try { const h = bare(new URL(m[1], r.url || p.url).host); if (EXTERNAL_JOBS.test(h)) meta.jobsExternal.add(h); } catch {}
    }
  }
  return { ok: true, pages: dropBoilerplate(pages), meta: { ...meta, jobsExternal: [...meta.jobsExternal] } };
}

/**
 * Removes lines that repeat on most pages of a site (menus, footers, cookie
 * notes the markup did not reveal) — except on the start page.
 */
export function dropBoilerplate(pages) {
  const others = pages.filter((p) => p.kind !== 'start');
  if (others.length < 3) return pages;
  const counts = new Map();
  for (const p of others) for (const line of new Set(p.text.split('\n'))) counts.set(line, (counts.get(line) || 0) + 1);
  const limit = Math.ceil(others.length * 0.6);
  return pages.map((p) => (p.kind === 'start' ? p
    : { ...p, text: p.text.split('\n').filter((l) => l.length > 60 || (counts.get(l) || 0) < limit).join('\n') }));
}
