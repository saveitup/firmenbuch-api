#!/usr/bin/env node
// Offline checks for server/web/crawler.js (page selection, cleaned text,
// languages) and server/web/signals.js (signal rules) on synthetic pages.
// Usage: node scripts/check-crawler.mjs        (exit code 1 on failure)

import { extractLinks, selectPages, mainText, siteLanguages, dropBoilerplate } from '../server/web/crawler.js';
import { extractSignals } from '../server/web/signals.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

// ─── Crawler ─────────────────────────────────────────────────────────────
const home = `<!doctype html><html lang="de"><head><title>Muster GmbH – Startseite</title>
<link rel="alternate" hreflang="en" href="https://muster.at/en/"></head><body>
<header><nav><a href="/ueber-uns">Über uns</a><a href="/leistungen">Leistungen</a><a href="/karriere">Karriere</a>
<a href="/en/">EN</a><a href="/cs/">CZ</a><a href="https://shop.other.com/">Shop</a></nav></header>
<main><h1>Willkommen</h1><p>Seit 1952 fertigen wir Präzisionsteile.</p></main>
<footer><a href="/impressum">Impressum</a><a href="/kontakt">Kontakt</a><a href="/datenschutz">Datenschutz</a>
<a href="/files/agb.pdf">AGB</a><a href="mailto:office@muster.at">Mail</a><a href="https://muster.jobs.personio.de/">Jobs</a>
<p>Muster GmbH · 4020 Linz · FN 123456a</p></footer></body></html>`;
const { internal, external } = extractLinks(home, 'https://www.muster.at/');
ok(internal.every((l) => l.url.startsWith('https://www.muster.at/')) && !internal.some((l) => l.url.endsWith('.pdf')), 'nur eigene HTML-Links', internal);
ok(external.some((l) => l.host === 'muster.jobs.personio.de'), 'externe Links getrennt (Personio)');
const sel = selectPages(internal, 'https://www.muster.at/');
const kinds = sel.map((p) => p.kind);
ok(kinds[0] === 'impressum' && kinds.includes('ueber_uns') && kinds.includes('karriere') && kinds.includes('kontakt'), 'Seitenauswahl nach Art', sel);
ok(!sel.some((p) => p.url.includes('/en/') || p.url.includes('/cs/')), 'keine fremdsprachigen Seiten', sel);
ok(!sel.some((p) => p.url.includes('datenschutz')), 'Datenschutz nicht geladen');
ok(JSON.stringify(siteLanguages(home, internal)) === '["cs","de","en"]', 'Sprachen aus lang, hreflang und Umschalter', siteLanguages(home, internal));
const text = mainText(home);
ok(text.includes('Seit 1952') && !text.includes('Über uns') && !text.includes('4020 Linz'), 'Text ohne Navigation und Footer', text);
ok(mainText(home, { keepFooter: true }).includes('4020 Linz'), 'Startseite behält den Footer');
const bp = dropBoilerplate([
  { kind: 'start', text: 'Menü\nWillkommen' },
  { kind: 'a', text: 'Menü\nA-Text' }, { kind: 'b', text: 'Menü\nB-Text' }, { kind: 'c', text: 'Menü\nC-Text' },
]);
ok(bp[0].text.includes('Menü') && !bp[1].text.includes('Menü') && bp[1].text === 'A-Text', 'Boilerplate-Zeilen entfernt', bp);

// ─── Signals ─────────────────────────────────────────────────────────────
const page = (kind, text, url = `https://x.at/${kind}`) => ({ kind, url, text });
const sig = (pages, meta) => extractSignals(pages, meta).signals;

const jobs = sig([
  page('karriere', 'Offene Stellen\nCNC-Fräser (m/w/d)\nGeschäftsführer (m/w/d) als Nachfolger\nBauleiter (m/w/d)\nLeiter Vertrieb (w/m/x)\nCNC-Fräser (m/w/d)'),
], { jobLinks: ['Lagerist (all genders)', 'Mehr erfahren'] });
ok(jobs.jobs === 5, 'Stellen: eindeutige Zeilen mit Gender-Marker', jobs);
ok(jobs.jobs_fuehrung === 2 && jobs.jobs_gf === 1, 'Führung ohne Bauleiter, GF-Suche erkannt', jobs);
ok(jobs.nachfolge === 1, 'GF-Ausschreibung zählt als offene Nachfolge');

const fam = sig([page('ueber_uns', 'Als Familienunternehmen in dritter Generation sind wir … Seit der Gründung 1898 durch Josef Muster. Gegründet 1923 als Schmiede.')]);
ok(fam.familienunternehmen === 1 && fam.generation === 3, 'Familienunternehmen + Generation', fam);
ok(fam.gruendungsjahr === 1898, 'frühestes Gründungsjahr', fam);
ok(sig([page('start', 'Wir sind seit 1978 Ihr Partner.')]).gruendungsjahr === 1978, '„seit“ als Rückfall');
ok(sig([page('news', 'Seit 2015 ISO-zertifiziert')]).gruendungsjahr === null, '„seit“ nur auf Start/Über uns');
ok(sig([page('ueber_uns', '1987 wurde das Unternehmen von Hans Muster gegründet')]).gruendungsjahr === 1987, 'Jahr vor „gegründet“');

ok(sig([page('news', 'Wir planen die Unternehmensnachfolge und suchen Gespräche.')]).nachfolge === 1, 'Nachfolge offen');
ok(sig([page('news', 'Die Unternehmensnachfolge ist geregelt: Anna Muster übernimmt.')]).nachfolge === 2, 'Nachfolge erfolgt');
ok(sig([page('leistungen', 'Der Nachfolger für den Millionenlüfter kommt 2025')]).nachfolge === 0, 'Produkt-Nachfolger zählt nicht');
ok(sig([page('ueber_uns', 'um unser Know-how an die nächste Generation von Technikern weiterzugeben')]).nachfolge === 0, '„nächste Generation von …“ zählt nicht');
ok(sig([page('ueber_uns', '1970–1979 Innovation und Generationenwechsel 1972 bei der Firma')]).nachfolge === 0, 'historischer Generationswechsel zählt nicht');
ok(sig([page('ueber_uns', 'Ruf. 1863 Generationswechsel: Isidor Braun übergibt den Besitz')]).nachfolge === 0, 'auch vor 1900');
ok(sig([{ kind: 'ueber_uns', url: 'https://x.at/de/geschichte', text: 'Unsere Geschichte\n1951 Gründung des Büros\n1972 Neubau\n2011 BIM' }]).gruendungsjahr === 1951, 'Gründung aus Zeitleiste');
ok(sig([{ kind: 'ueber_uns', url: 'https://x.at/de/historie', text: 'Historie\n1962\nErste Werkstatt\n1980\nNeue Halle' }]).gruendungsjahr === 1962, 'Zeitleiste ohne Stichwort');
ok(sig([page('start', 'Seit 2011 setzt FCP auf BIM. Seit 1978 Ihr Partner.')]).gruendungsjahr === 1978, '„seit“: frühestes Jahr');
ok(sig([page('ueber_uns', 'Vor mehr als 65 Jahren von Kurt Wenzel gegründet. 1999 Gründung der FCP ZT GmbH')]).gruendungsjahr === new Date().getFullYear() - 65, '„vor N Jahren gegründet“');
ok(sig([page('leistungen', 'Das Nachfolgemodell der Presse X200')]).nachfolge === 0, '„Nachfolgemodell“ ist kein Nachfolge-Hinweis');
ok(sig([page('ueber_uns', 'Seit 2019 sind wir Teil der Würth-Gruppe.')]).gruppe_hinweis === 1, 'Gruppenzugehörigkeit');
ok(sig([page('karriere', 'Werden Sie Teil der RICO Group!')]).gruppe_hinweis === 0, 'Recruiting-Floskel ist kein Gruppenhinweis');

const ex = sig([page('ueber_uns', 'Mit einer Exportquote von 85 % liefern wir in über 40 Länder.')], { languages: ['de', 'en', 'fr'] });
ok(ex.export_quote === 0.85 && ex.export_laender === 40 && ex.export_hinweis === 1, 'Exportquote und Länder', ex);
ok(sig([page('start', 'Regionaler Installateur')], { languages: ['de'] }).export_hinweis === 0, 'kein Export ohne Hinweis');
ok(sig([page('start', 'Weltweit führend in der Region')], { languages: ['de', 'en'] }).export_hinweis === 0, '„weltweit“ allein ist kein Export');

const certs = sig([page('zertifikate', 'Zertifiziert nach ISO 9001:2015, ISO 14001 und EN 1090-2. SCC** seit 2010. TÜV SÜD geprüft.')]).zertifikate;
ok(['ISO 9001', 'ISO 14001', 'EN 1090', 'SCC', 'TÜV'].every((c) => certs.includes(c)), 'Zertifikate', certs);

const st = sig([page('standorte', 'Zentrale\n4020 Linz\nNiederlassung 8010 Graz\nWerk A-5020 Salzburg\n1000 Mitarbeiter')]);
ok(st.standorte === 3, 'Standorte aus PLZ, ohne „1000 Mitarbeiter“', st);
ok(sig([page('ueber_uns', 'An 12 Standorten in Europa')]).standorte === 12, 'Standorte als Zahl');

ok(sig([page('start', 'x')], { shop: { strong: true } }).webshop === 1, 'Webshop aus Kauf-Buttons');
ok(sig([page('start', 'x')], { shop: { cart: true } }).webshop === 0, 'Warenkorb-Link allein ist kein Shop');
ok(sig([page('start', 'x')], { shop: { cart: true, label: true } }).webshop === 1, 'Shop-Link + Warenkorb');
ok(sig([page('start', 'Zum B2B-Shop für Fachhändler')]).b2b_portal === 1, 'B2B-Portal');
ok(sig([page('team', 'Geschäftsführung\nAnna Muster\nVertriebsleiter\nMax Muster\nProkuristin\nEva Muster')]).zweite_ebene === 1, 'zweite Führungsebene');

const ev = extractSignals([page('ueber_uns', 'Gegründet 1923 in Linz.')]).evidence;
ok(ev.gruendungsjahr?.[0]?.url === 'https://x.at/ueber_uns' && ev.gruendungsjahr[0].quote.includes('1923'), 'Beleg mit URL und Zitat', ev);

console.log(failures ? `\n✗ ${failures} Prüfung(en) fehlgeschlagen` : '\n✓ alle Crawler-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
