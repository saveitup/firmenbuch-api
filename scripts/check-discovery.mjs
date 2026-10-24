#!/usr/bin/env node
// Offline checks for server/web/discovery.js: domain guesses, FN matching,
// robots.txt rules and the group test. No network.
// Usage: node scripts/check-discovery.mjs        (exit code 1 on failure)

import {
  domainLabels, domainCandidates, extractFns, matchPage, nameCore, parseRobots, robotsAllows,
  relatedFirm, subpageLinks, htmlToText,
} from '../server/web/discovery.js';

let failures = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
};

// Domain guesses
const labels = (n) => domainLabels(n);
ok(labels('GETEC Gebäudetechnik GmbH')[0] === 'getec', 'erstes Namenswort zuerst', labels('GETEC Gebäudetechnik GmbH'));
ok(labels('Leobersdorfer Maschinenfabrik GmbH').includes('lmf'), 'Initialen mit Kompositum (lmf)');
ok(labels('Pörner Ingenieurgesellschaft m.b.H.').includes('poerner') && labels('Pörner Ingenieurgesellschaft m.b.H.').includes('porner'), 'Umlaut als ae und a');
ok(labels('WIMEX Handelsgesellschaft m.b.H.')[0] === 'wimex', 'Rechtsform und Handelsgesellschaft entfernt');
ok(labels('cms electronics gmbh').includes('cms-electronics'), 'Bindestrich-Variante');
ok(domainCandidates({ name: 'X GmbH', homepage: 'http://www.foo.at/de' })[0]?.domain === 'foo.at', 'Firmenbuch-Homepage zuerst');
ok(!domainCandidates({ name: 'GETEC GmbH' }).some((c) => c.domain === 'undefined'), 'ohne Homepage kein Platzhalter');
ok(domainCandidates({ name: 'GETEC GmbH' }).some((c) => c.domain === 'getec.co.at'), '.co.at für die wahrscheinlichsten Labels');

// FN matching
ok(JSON.stringify(extractFns('FN 55036 k · FN 123456a · Commercial register no. 250425y')) === '["055036k","250425y"]',
  'FN-Erwähnungen mit gültigem Prüfbuchstaben', extractFns('FN 55036 k · FN 123456a · Commercial register no. 250425y'));
const firm = { canon: '516815y', plz: '7423', nameCore: nameCore('GETEC Gebäudetechnik GmbH') };
ok(matchPage('Impressum … Firmenbuchnummer: 516815 y, LG Eisenstadt', firm).level === 'fn', 'eigene FN mit Leerzeichen');
ok(matchPage('FN 0516815Y', firm).level === 'fn', 'eigene FN mit führender Null, Großbuchstabe');
ok(matchPage('FN 516815 z', firm).level === null, 'falscher Prüfbuchstabe zählt nicht');
ok(matchPage('GETEC Holding GmbH, FN 515962v', firm).level === 'andere_fn', 'fremde FN erkannt');
ok(matchPage('GETEC Gebäudetechnik, 7423 Pinkafeld', firm).level === 'name_plz', 'Name + PLZ ohne FN');
ok(matchPage('GETEC, 74230 Pinkafeld', firm).level === null, 'PLZ nur als ganze Zahl');

// Page text and links
ok(htmlToText('Firmen\u00adbuch\u00adnummer') === 'Firmenbuchnummer', 'weiche Trennzeichen entfernt');
ok(extractFns('FBNr: 166638g · CRN: 120334 m').length === 2, 'FBNr und CRN als FN-Kennung', extractFns('FBNr: 166638g · CRN: 120334 m'));
ok(htmlToText('<p>FN&nbsp;123</p><script>var fn=1</script>&ensp;x') === 'FN 123\nx', 'HTML-Text ohne Skripte, Entities', JSON.stringify(htmlToText('<p>FN&nbsp;123</p><script>var fn=1</script>&ensp;x')));
const links = subpageLinks('<a href="/kontakt">Kontakt</a><a href="/de/impressum">Impressum</a><a href="mailto:x@y">Mail</a>', 'https://a.at/');
ok(links[0] === 'https://a.at/de/impressum' && links.length === 2, 'Impressum vor Kontakt, mailto verworfen', links);

// robots.txt
const rules = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*.pdf$');
ok(robotsAllows(rules, '/impressum'), 'robots: erlaubt');
ok(!robotsAllows(rules, '/wp-admin/x'), 'robots: Disallow-Präfix');
ok(robotsAllows(rules, '/wp-admin/admin-ajax.php'), 'robots: längere Allow-Regel gewinnt');
ok(!robotsAllows(rules, '/a.pdf'), 'robots: Wildcard mit $');
ok(!robotsAllows(parseRobots('User-agent: KonturBot\nDisallow: /'), '/'), 'robots: eigener User-Agent');

// Group test
ok(relatedFirm({ name: 'CANCOM a + d IT solutions GmbH' }, { name: 'CANCOM Austria AG' }), 'Gruppe: gleiches Leitwort');
ok(relatedFirm({ name: 'Dorninger Hytronics GmbH' }, { name: 'Dorninger Tech Group GmbH' }), 'Gruppe: Schwester mit anderem Zusatz');
ok(!relatedFirm({ name: 'Faber-Castell Trading GmbH' }, { name: 'Faber KFZ-Vertriebs GmbH' }), 'keine Gruppe: Marke mit Bindestrich');
ok(relatedFirm({ name: 'A GmbH', plz: '4020' }, { name: 'B GmbH', plz: '4020' }), 'Gruppe: gleiche PLZ');

console.log(failures ? `\n✗ ${failures} Prüfung(en) fehlgeschlagen` : '\n✓ alle Discovery-Prüfungen bestanden');
process.exit(failures ? 1 : 0);
