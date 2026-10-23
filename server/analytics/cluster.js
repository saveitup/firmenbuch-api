// Business-model clusters of the MBI search mandate (§ 4), assigned by rules
// from the Firmenbuch Geschäftszweig, the Firmenwortlaut and the structure of
// the latest Jahresabschluss. Deterministic and explainable: every result
// carries the evidence it rests on. Firms the rules cannot place stay "U"
// (unklar) instead of being forced into a cluster.
//
//   A1 Spezialisierter B2B-Großhandel / Distribution
//   A2 Technische B2B-Dienstleistungen
//   A3 Industrielle Nischenunternehmen
//   B1 Healthcare / MedTech / Pharma-Distribution
//   B2 B2B-Software / Tech-Services
//   B3 Asset-light-Logistik / Infrastrukturservices
//   X  außerhalb der Cluster (Bau, Immobilien, Holding, Tourismus, B2C, …)
//   U  unklar

export const CLUSTERS = {
  A1: 'B2B-Großhandel / Distribution',
  A2: 'Technische B2B-Dienstleistungen',
  A3: 'Industrielle Nischenunternehmen',
  B1: 'Healthcare / MedTech / Pharma',
  B2: 'B2B-Software / Tech-Services',
  B3: 'Logistik / Infrastrukturservices',
  X: 'Außerhalb der Cluster',
  U: 'Unklar',
};

// Ordered from specific to generic: on equal score the earlier rule wins.
// Patterns run on lower-cased text with umlauts folded (ä → ae, ß → ss).
const RULES = [
  // Not acquirable as an operating business, or clearly outside the mandate
  ['X', 'In Liquidation', /\bi\.? ?l\.?$|\bin liqu|\bliqu\b|\bi\.l\./],
  ['X', 'Tochter einer bekannten Gruppe', /voestalpine|\bomv\b|\bmagna\b|boehler|red bull|mediamarkt|\bsaturn\b|\bspar\b|\brewe\b|\bbilla\b|\bhofer kg\b|\blidl\b|\bporr\b|strabag|swietelsky|andritz|wienerberger|\bverbund\b|\bevn\b|raiffeisen|\berste (bank|group|digital|campus|operations)\b|\bbawag\b|\buniqa\b|siemens|robert bosch|bosch rexroth|infineon|asfinag|\boebb\b|novomatic|lenzing|agrana|swarovski|palfinger|rosenbauer|\bmiba\b|\bamag\b|semperit|mayr-melnhof|egger holz|fritz egger|egger corporate|doppelmayr|\bkapsch\b|telekom austria|\ba1 (telekom|open fiber|digital)\b|deutsche telekom|tuerk telekom|vorwerk/],
  ['X', 'Konzerndienstleister', /shared service|tochtergesellschaften und zweigniederlassungen/],
  ['X', 'Holding / Beteiligungen', /holding|beteiligung|vermoegensverwalt|privatstiftung|verwaltung von beteiligungen/],
  ['X', 'Immobilien', /immobilien|realitaeten|liegenschaft|bautraeger|wohnbau|wohnungs|\bwohnen\b|hausverwaltung|grundstueck|vermietung|projektentwicklung|shopping|einkaufszentrum/],
  ['X', 'Finanz / Versicherung', /\bbank\b|versicherung|leasing|finanzdienst|kredit|vermoegensberat/],
  ['X', 'Energie / Versorgung', /energie|\benergy\b|kraftwerk|wasserkraft|windkraft|windpark|fernwaerme|stromerzeug|biogas|photovoltaik|wasserversorgung|stadtwerke|mineraloel|stromhandel|gashandel|strom und gas|erdgas/],
  ['X', 'Öffentlich / gemeinnützig', /gemeinnuetzig|\bgemeinde|\bstadt\b|landesgesellschaft|bundesanstalt|\bverein\b|wohlfahrt|soziale|sozialer|behinderten|mildtaetig|\begen\b|genossenschaft/],
  ['X', 'Tourismus / Gastronomie', /hotel|gasthof|gastgewerbe|gastronomie|restaurant|catering|beherbergung|tourismus|reisebuero|\breisen\b|bergbahn|seilbahn|therme|camping|\bsport\b|fussball|freizeit|casino/],
  ['X', 'Kfz-Handel', /autohaus|\bkfz\b|kraftfahrzeug|fahrzeughandel|autohandel|\bauto\b/],
  ['X', 'Einzelhandel / B2C', /einzelhandel|versandhandel|onlinehandel|onlineshop|e-commerce|supermarkt|filial|boutique|\bmode\b|schuh|bekleidungshandel|sportartikelhandel|lebensmittelhandel|apotheke|optik|parfum|moebelhaus|tankstelle|trafik|franchise/],

  // Mandate clusters, specific trades first
  ['B1', 'Pharma / Medizinprodukte', /pharma|pharm\b|arznei|medizinprodukt|medizinische produkte|medizintechn|medical|\bmedtech|healthcare|dental|orthopaed|diagnost|labormedizin/],
  ['B1', 'Gesundheitsdienstleistung', /klinik|krankenhaus|sanatorium|\bpflege|gesundheit|therapie|rehabilit|labordienst|medizinische labor|tierarzt|tieraerzt|\bvet\b|ordination|\barzt/],
  ['B2', 'Software / IT-Services', /software|\bit\b|\bit-|\bedv\b|informatik|informationstechn|datenverarbeitung|rechenzentrum|systemhaus|\bdigital|\bcloud|cyber|\bweb\b|\bdata\b|netzwerk|telekom/],
  ['A2', 'Haus- und Gebäudetechnik', /haustechnik|gebaeudetechnik|installation|elektroinstall|elektrotechn|\belektro\b|heizung|sanitaer|lueftung|klima|kaelte|sicherheitstechn|brandschutz|aufzug|treppenlift|lifttechn|lufttechn|umwelttechnische anlagen|wassertechn/],
  ['A2', 'Engineering / Prüfung', /ziviltechnik|\bzt\b|ingenieur|engineering|technisches buero|planungsleistung|forschung und entwicklung|\bresearch\b|pruefanst|materialpruef|\bpruef|vermessung|gutacht|\blabor\b|institut fuer .*technik|messdienst/],
  ['A2', 'Wartung / Montage / Facility', /wartung|instandhalt|montage|reparatur|facility|gebaeudereinig|reinigung|industrieservice/],
  ['B3', 'Spedition / Logistik', /spedition|logistik|logistic|supply chain|\blager|umschlag|terminal|kurier|paketdienst|zustell|frachtbuero/],
  ['B3', 'Transport', /transport(?!ger|beton)|fuhrwerk|frachter|\bbus\b|reisebus|taxi|\brail\b|personennahverkehr/],
  ['B3', 'Entsorgung / Recycling', /entsorgung|recycling|abfall|altstoff|umweltservice|kanalservice/],
  ['A3', 'Maschinen- und Anlagenbau', /maschinenbau|anlagenbau|apparatebau|\bmaschinen|automation|automatisier|robot|antriebstechn|hydraulik|pneumatik/],
  ['A3', 'Metall / Kunststoff / Werkstoffe', /metall|\bstahl|alumin|giesserei|\bguss|schmiede|kunststoff|gummi|beschichtung|lackier|oberflaechentechn|werkzeug|praezision|blech|draht|glas|keramik|chemie|lacke|transportbeton|betonwerk|fertigteil|ziegel/],
  ['A3', 'Elektronik / Komponenten', /elektronik|electronic|sensor|komponenten|halbleiter|leiterplatte|baugruppe|messtechn|optoelektron/],
  ['A3', 'Holz / Papier / Verpackung', /saegewerk|holzindustr|holzverarb|\bholz|tischlerei|papier|karton|verpackung|packaging|druckerei|etikett/],
  ['A3', 'Lebensmittelproduktion', /molkerei|kaeserei|fleisch|wurst|baeckerei|backwaren|brauerei|getraenke|muehle|lebensmittelprod|nahrungsmittel|konditor|schokolad|gewuerz/],

  // Services outside the mandate — after the clusters, so "IT Consulting" stays B2
  ['X', 'Beratung / freie Berufe', /unternehmensberat|beratungsdienst|steuerberat|wirtschaftspruef|rechtsanw|notar|\bconsulting\b|werbeagentur|werbung|\bagentur\b|marketing|universitaet|weiterbildung|ausbildung|schule\b/],
  ['X', 'Medien / Verlag', /verlag|zeitung|\bmedien|\bmedia\b|rundfunk|\bkino|luftfahrt|flugzeug/],
  ['X', 'Personaldienstleistung', /personalbereitstell|arbeitskraefteueberlass|ueberlassung von arbeitskraeften|personalverleih|personalleasing|personaldienst|personalservice|\bpersonal\b/],
  ['X', 'Landwirtschaft / Rohstoffe', /landwirtschaft|\bforst|schotter|\bkies\b|\bsand\b|steinbruch|bergbau/],

  // Generic last
  ['A3', 'Produktion (allgemein)', /herstellung|erzeugung|produktion|fertigung|fabrik|\bwerk\b|industrie/],
  ['X', 'Bau', /baugewerbe|bauunternehm|baumeister|hochbau|tiefbau|strassenbau|erdbau|betonbau|\bbau\b|baugesellschaft|zimmerei|dachdeck|spengler|pflaster|fassade/],
  ['A1', 'Großhandel / Distribution', /grosshandel|baustoffhandel|bauwarenhandel|warenhandel|weinhandel|distribution|distributor|vertrieb|\bimport|\bexport|trading|\bhandel/],
];

const GENERIC_SEGMENTS = new Set(['Großhandel / Distribution', 'Produktion (allgemein)']);
// Out of scope whatever else the text says: "OMV Gas Marketing & Trading" is
// a group subsidiary even though "Handel"/"Trading" score higher.
const ABSOLUTE_SEGMENTS = new Set(['In Liquidation', 'Tochter einer bekannten Gruppe']);
// Group names identify a subsidiary only in the Firmenwortlaut — in the
// Geschäftszweig "Telekommunikation" or "Spar…" says nothing about ownership.
const NAME_ONLY_SEGMENTS = new Set(['Tochter einer bekannten Gruppe']);

// Trades that contain "bau" but are manufacturing, not construction.
const NOT_BAU = /maschinenbau|anlagenbau|stahlbau|metallbau|apparatebau|werkzeugbau|fahrzeugbau|formenbau|modellbau/;

const fold = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');

function textMatches(text, weight, source) {
  const hits = [];
  if (!text) return hits;
  RULES.forEach(([cluster, segment, re], order) => {
    if (segment === 'Bau' && NOT_BAU.test(text)) return;
    if (source !== 'Firmenname' && NAME_ONLY_SEGMENTS.has(segment)) return;
    const m = text.match(re);
    if (m) hits.push({ cluster, segment, order, weight, evidence: `${source}: „${m[0].trim()}“` });
  });
  return hits;
}

// Structural fingerprint of the latest filing.
function structure(row) {
  const bs = row?.balanceSheet || {}, g = row?.guv || {};
  const total = bs.aktiva?.total || null;
  const vorraete = bs.aktiva?.umlaufvermoegen?.vorraete ?? null;
  const sach = bs.aktiva?.anlagevermoegen?.sachanlagen ?? null;
  const fin = bs.aktiva?.anlagevermoegen?.finanzanlagen ?? null;
  const roh = g.rohergebnis ?? (g.umsatzerloese != null && g.materialaufwand != null ? g.umsatzerloese - Math.abs(g.materialaufwand) : null);
  const s = {
    vorraeteQuote: total && vorraete != null ? vorraete / total : null,
    anlagenQuote: total && sach != null ? sach / total : null,
    finanzanlagenQuote: total && fin != null ? fin / total : null,
    personalQuote: roh > 0 && g.personalaufwand != null ? Math.abs(g.personalaufwand) / roh : null,
    rohertragsQuote: g.umsatzerloese > 0 && g.materialaufwand != null ? 1 - Math.abs(g.materialaufwand) / g.umsatzerloese : null,
    holding: g.finanzerfolg != null && g.finanzerfolg > Math.max(0, g.betriebserfolg ?? 0),
  };
  s.handelTypisch = (s.rohertragsQuote != null && s.rohertragsQuote < 0.35)
    || (s.vorraeteQuote > 0.2 && s.personalQuote != null && s.personalQuote < 0.5);
  s.dienstleistungTypisch = s.personalQuote > 0.6 && (s.vorraeteQuote ?? 0) < 0.1 && (s.anlagenQuote ?? 0) < 0.3;
  s.produktionTypisch = s.anlagenQuote > 0.25 && s.vorraeteQuote > 0.1;
  return s;
}

// Does the structure support or contradict a cluster?
function structureFit(cluster, segment, s) {
  if (cluster === 'A1') return s.handelTypisch ? 1 : s.dienstleistungTypisch ? -1 : 0;
  if (cluster === 'A2' || cluster === 'B2') return s.dienstleistungTypisch ? 1 : s.handelTypisch ? -1 : 0;
  if (cluster === 'A3') return s.produktionTypisch ? 1 : s.dienstleistungTypisch ? -1 : 0;
  if (cluster === 'B3') return segment === 'Spedition / Logistik' && s.anlagenQuote > 0.5 ? -1 : 0;
  return 0;
}

const pct = (x) => `${Math.round(x * 100)} %`;

/**
 * @param firm { name, geschaeftszweig, row } — row = parsed latest filing
 *             (balanceSheet, guv) as stored in financials_yearly
 * @returns { cluster, segment, confidence: 'hoch'|'mittel'|'niedrig', basis: string[] }
 */
export function classifyCluster({ name, geschaeftszweig, row }) {
  const s = structure(row);
  const hits = [
    ...textMatches(fold(geschaeftszweig), 3, 'Geschäftszweig'),
    ...textMatches(fold(name), 2, 'Firmenname'),
  ];
  if (s.holding && s.finanzanlagenQuote > 0.5) {
    hits.push({ cluster: 'X', segment: 'Holding / Beteiligungen', order: 0, weight: 3,
      evidence: `Struktur: Finanzanlagen ${pct(s.finanzanlagenQuote)} der Bilanzsumme, Ergebnis aus Finanzerfolg` });
  }

  // Score per cluster/segment from text evidence. On a tie the structure
  // decides between two mandate clusters (e.g. Handel vs. Transport); an
  // exclusion (X) is never outvoted by structure — a car dealer is
  // "handelstypisch" too — so there rule order decides.
  const scored = new Map();
  for (const h of hits) {
    const key = `${h.cluster}|${h.segment}`;
    const cur = scored.get(key) || { ...h, score: 0, evidence: [] };
    cur.score += h.weight;
    cur.order = Math.min(cur.order, h.order);
    cur.evidence.push(h.evidence);
    scored.set(key, cur);
  }
  for (const c of scored.values()) c.fit = structureFit(c.cluster, c.segment, s);
  // A specific trade beats the catch-alls ("Pharmavertrieb" is B1, not A1).
  const generic = (c) => (GENERIC_SEGMENTS.has(c.segment) ? 1 : 0);
  const absolute = (c) => (ABSOLUTE_SEGMENTS.has(c.segment) ? 1 : 0);
  const best = [...scored.values()].sort((a, b) => absolute(b) - absolute(a)
    || b.score - a.score
    || generic(a) - generic(b)
    || (a.cluster !== 'X' && b.cluster !== 'X' ? b.fit - a.fit : 0)
    || a.order - b.order)[0];

  const structureNotes = [
    s.rohertragsQuote != null && `Rohertragsquote ${pct(s.rohertragsQuote)}`,
    s.vorraeteQuote != null && `Vorräte ${pct(s.vorraeteQuote)} der Bilanz`,
    s.anlagenQuote != null && `Sachanlagen ${pct(s.anlagenQuote)}`,
    s.personalQuote != null && `Personal ${pct(s.personalQuote)} des Rohergebnisses`,
  ].filter(Boolean);

  if (!best) {
    // No textual evidence: report the structural pattern, keep the firm unclassified.
    const hint = s.handelTypisch ? 'Struktur handelstypisch' : s.dienstleistungTypisch ? 'Struktur dienstleistungstypisch'
      : s.produktionTypisch ? 'Struktur produktionstypisch' : 'kein Muster';
    return { cluster: 'U', segment: hint, confidence: 'niedrig', basis: structureNotes };
  }
  const fit = structureFit(best.cluster, best.segment, s);
  const fromGz = best.evidence.some((e) => e.startsWith('Geschäftszweig'));
  const confidence = fromGz && fit >= 0 ? 'hoch' : (fromGz || fit > 0) && fit >= 0 ? 'mittel' : 'niedrig';
  return {
    cluster: best.cluster,
    segment: best.segment,
    confidence,
    basis: [...best.evidence, ...(fit !== 0 ? [`Struktur ${fit > 0 ? 'passt' : 'widerspricht'}: ${structureNotes.join(', ')}`] : [])],
  };
}
