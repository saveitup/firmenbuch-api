// Austrian Jahresabschluss (JAb) parser — Justiz v4.0 schema.
// The schema is positional (no POSTEN-CODE on POSTENZEILE), so we extract
// by semantic element names and take the first (top) POSTENZEILE in each
// named subtree. That's the summary line, which is what we need for KPIs.
//
// Companies file their JAbs on Justiz' submission format. Each file has
// <DARSTELLUNG_EINGEREICHT>/<DARSTELLUNG_VORHERGEHEND> telling us the unit
// scale for current-year / previous-year numbers (E = euros, TE = thousand,
// ME = million). We multiply accordingly.
//
// Returns a normalised row suitable for `financials_yearly` inserts, with
// a `balanceSheet` object carrying the full Aktiva/Passiva breakdown for
// the Bilanz/Kennzahlen view, a `guv` object with the GuV line items (null
// for balance-sheet-only filings) and a `priorYear` row of the same shape
// built from the filing's Vorjahr column.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  parseAttributeValue: false,
});

const SCALE = { E: 1, TE: 1000, ME: 1_000_000 };

// `col` picks the column: BETRAG_GJ (current year) or BETRAG_VJ (prior year).
function topBetrag(section, col = 'BETRAG_GJ') {
  if (!section) return null;
  const posten = section.POSTENZEILE;
  const first = Array.isArray(posten) ? posten[0] : posten;
  if (!first) return null;
  const raw = first[col];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function walk(obj, name) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[name]) return obj[name];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const found = walk(v, name);
      if (found) return found;
    }
  }
  return null;
}

// Try a list of candidate element names under `root` and return the first
// matching subtree. Lets us be tolerant to v4 variants (e.g. NENNKAPITAL vs
// STAMMKAPITAL, JAHRESUEBERSCHUSS vs JAHRESFEHLBETRAG).
function walkAny(root, names) {
  for (const n of names) {
    const hit = walk(root, n);
    if (hit) return hit;
  }
  return null;
}

function sectionAmount(root, names, mul, col = 'BETRAG_GJ') {
  const node = walkAny(root, names);
  return node ? mul(topBetrag(node, col)) : null;
}

// EBITDA = Betriebserfolg + Abschreibungen. Abschreibungen are an expense
// whatever sign the filing software used, so add back the absolute value.
function ebitdaOf(guv) {
  return (guv.betriebserfolg != null && guv.abschreibungen != null)
    ? guv.betriebserfolg + Math.abs(guv.abschreibungen)
    : null;
}

/**
 * Parse a JAb XML blob (already base64-decoded).
 * Returns a single KPI row, or null if the payload isn't a v4 JAb. BMF
 * legacy filings (namespace `finanzonline.bmf.gv.at/bilanz`, version 03.x)
 * use a different positional layout and are intentionally skipped here —
 * legacy support would warrant a second parser.
 */
export function parseJAb(xmlText) {
  if (!xmlText) return null;
  // BMF legacy format (namespace `finanzonline.bmf.gv.at/bilanz`) — still in
  // wide use for mid-sized GmbHs filing via BMD / RZL / Proaplha software.
  // Uses §224 UGB positional structure (HGB_224_2_* / HGB_224_3_*).
  if (xmlText.includes('finanzonline.bmf.gv.at/bilanz')) return parseBmfLegacy(xmlText);
  if (!xmlText.includes('justiz.gv.at/Bilanzierung/v4')) return null;
  let tree;
  try { tree = parser.parse(xmlText); } catch { return null; }
  const envelope = tree?.UEBERMITTLUNG;
  if (!envelope) return null;

  const ag = envelope.ALLGEMEINE_ANGABEN || {};
  const gj = ag.GESCHAEFTSJAHR || {};
  const stichtag = gj.ENDE || null;
  if (!stichtag) return null;

  const eingereicht = gj.EINGABEDARSTELLUNG?.DARSTELLUNG_EINGEREICHT || {};
  const scale = SCALE[eingereicht.EINHEIT] ?? 1;
  const mul = (x) => x == null ? null : x * scale;

  // Prior-year column: same positions in BETRAG_VJ, with its own unit. Only
  // EINGABEDARSTELLUNG (how the numbers were entered) matters for scaling —
  // ZIELDARSTELLUNG is a display hint and may say TE for euro values.
  const vorhergehend = gj.EINGABEDARSTELLUNG?.DARSTELLUNG_VORHERGEHEND || {};
  const scaleVj = SCALE[vorhergehend.EINHEIT] ?? 1;
  const mulVj = (x) => x == null ? null : x * scaleVj;
  const priorStichtag = ag.GESCHAEFTSJAHR_VORANGEGANGEN?.ENDE || null;
  const prior = priorStichtag ? v4Year(envelope, mulVj, 'BETRAG_VJ') : null;

  return {
    stichtag,
    currency: 'EUR',
    ...v4Year(envelope, mul, 'BETRAG_GJ'),
    arbeitnehmer: null,
    priorYear: prior?.bilanzsumme != null ? { stichtag: priorStichtag, ...prior } : null,
  };
}

// All KPIs of one column (current or prior year) of a v4 filing.
function v4Year(envelope, mul, col) {
  // Pull named sections anywhere under the envelope.
  const umsatz       = walk(envelope, 'UMSATZERLOESE');
  const aktiva       = walk(envelope, 'AKTIVA');
  const passiva      = walk(envelope, 'PASSIVA');
  const eigenkapital = walk(envelope, 'EIGENKAPITAL');
  const betriebs     = walk(envelope, 'ZWISCHENSUMME_BETRIEBSERFOLG');
  const ergebnisNach = walk(envelope, 'ERGEBNIS_NACH_STEUERN');

  const bilanzsumme       = mul(topBetrag(aktiva, col));
  const eigenkapitalBetrag = mul(topBetrag(eigenkapital, col));
  const jahresergebnis    = mul(topBetrag(ergebnisNach, col));

  return {
    umsatzerloese:    mul(topBetrag(umsatz, col)),
    bilanzsumme,
    eigenkapital:     eigenkapitalBetrag,
    jahresergebnis,
    betriebsergebnis: mul(topBetrag(betriebs, col)),
    ek_quote: (bilanzsumme && eigenkapitalBetrag != null) ? eigenkapitalBetrag / bilanzsumme : null,
    balanceSheet: extractBalanceSheet(aktiva, passiva, mul, col),
    guv: extractV4Guv(walkAny(envelope, ['GUV_GKV', 'GUV_UKV']), mul, col),
  };
}

// ─── GuV (v4) ────────────────────────────────────────────────────────────
// Element names as seen in GUV_GKV (Gesamtkostenverfahren). The tree nests
// each subtotal around its components, so a depth-first walk below the GuV
// root finds every position. Umsatzkostenverfahren filings (GUV_UKV) have no
// separate Abschreibungen line — EBITDA comes back null for them.
const V4_GUV = {
  umsatzerloese:                    ['UMSATZERLOESE'],
  rohergebnis:                      ['ROHERGEBNIS'], // assumed name, not yet seen in a v4 filing
  bestandsveraenderung:             ['VERAENDERUNG_DES_BESTANDS_AN_ERZEUGNISSEN_UND_LEISTUNGEN'],
  aktivierteEigenleistungen:        ['ANDERE_AKTIVIERTE_EIGENLEISTUNGEN'],
  sonstigeBetrieblicheErtraege:     ['SONSTIGE_BETRIEBLICHE_ERTRAEGE'],
  materialaufwand:                  ['AUFWENDUNGEN_FUER_HERSTELLUNGSLEISTUNGEN', 'MATERIALAUFWAND'],
  personalaufwand:                  ['PERSONALAUFWAND'],
  abschreibungen:                   ['ABSCHREIBUNGEN'],
  sonstigeBetrieblicheAufwendungen: ['SONSTIGE_BETRIEBLICHE_AUFWENDUNGEN'],
  betriebserfolg:                   ['ZWISCHENSUMME_BETRIEBSERFOLG'],
  finanzerfolg:                     ['ZWISCHENSUMME_FINANZERFOLG'],
  zinsaufwand:                      ['ZINSEN_UND_AEHNLICHE_AUFWENDUNGEN'],
  ergebnisVorSteuern:               ['ERGEBNIS_VOR_STEUERN'],
  steuernEinkommen:                 ['STEUERN_VOM_EINKOMMEN_UND_ERTRAG'],
  ergebnisNachSteuern:              ['ERGEBNIS_NACH_STEUERN'],
  jahresueberschuss:                ['JAHRESUEBERSCHUSS_JAHRESFEHLBETRAG'],
};

function extractV4Guv(guvRoot, mul, col) {
  if (!guvRoot) return null;
  const guv = {};
  for (const [field, names] of Object.entries(V4_GUV)) {
    guv[field] = sectionAmount(guvRoot, names, mul, col);
  }
  if (guv.betriebserfolg == null && guv.jahresueberschuss == null) return null;
  guv.ebitda = ebitdaOf(guv);
  return guv;
}

// ─── Bilanz‑Breakdown ────────────────────────────────────────────────────
// Walks the AKTIVA / PASSIVA subtrees and extracts each named sub‑section's
// summary line. Everything is null‑safe: if an element is absent in the
// filing, the field comes back as null and downstream ratios return null
// for the affected metric. Element names follow §224 UGB and the Justiz v4
// schema. We accept a handful of known synonyms (e.g. JAHRESUEBERSCHUSS vs
// JAHRESFEHLBETRAG) to cover both positive and negative reporters.

function extractBalanceSheet(aktiva, passiva, mul, col = 'BETRAG_GJ') {
  if (!aktiva && !passiva) return null;
  const top = (node) => (node ? mul(topBetrag(node, col)) : null);
  const amount = (root, names) => sectionAmount(root, names, mul, col);

  const anlageNode = aktiva && walk(aktiva, 'ANLAGEVERMOEGEN');
  const umlaufNode = aktiva && walk(aktiva, 'UMLAUFVERMOEGEN');
  const aktivaRechAbgr = aktiva && walk(aktiva, 'RECHNUNGSABGRENZUNGSPOSTEN');

  const ekNode     = passiva && walk(passiva, 'EIGENKAPITAL');
  const bilanzgewinnNode = ekNode && walk(ekNode, 'BILANZGEWINN');
  const rueckstNode = passiva && walk(passiva, 'RUECKSTELLUNGEN');
  const verbindNode = passiva && walk(passiva, 'VERBINDLICHKEITEN');
  const passivaRechAbgr = passiva && walkAny(passiva, ['PASSIVE_RECHNUNGSABGRENZUNGSPOSTEN', 'RECHNUNGSABGRENZUNGSPOSTEN']);

  // Verbindlichkeiten: try to find the "davon mit Restlaufzeit > 1 Jahr" line.
  // In v4 it's either a flagged POSTENZEILE or a child element — we fall back
  // to null if not recognisable.
  let verbindLangfristig = null;
  if (verbindNode) {
    const davon = walkAny(verbindNode, ['DAVON_RESTLAUFZEIT_GROESSER_EIN_JAHR', 'RESTLAUFZEIT_GROESSER_EIN_JAHR']);
    if (davon) verbindLangfristig = top(davon);
  }

  return {
    aktiva: {
      total: top(aktiva),
      anlagevermoegen: {
        total:        top(anlageNode),
        immaterielle: amount(anlageNode, ['IMMATERIELLE_VERMOEGENSGEGENSTAENDE']),
        sachanlagen:  amount(anlageNode, ['SACHANLAGEN']),
        finanzanlagen: amount(anlageNode, ['FINANZANLAGEN']),
      },
      umlaufvermoegen: {
        total:       top(umlaufNode),
        vorraete:    amount(umlaufNode, ['VORRAETE']),
        forderungen: amount(umlaufNode, ['FORDERUNGEN_UND_SONSTIGE_VERMOEGENSGEGENSTAENDE', 'FORDERUNGEN']),
        wertpapiere: amount(umlaufNode, ['WERTPAPIERE_UND_ANTEILE', 'WERTPAPIERE']),
        kassenbestand: amount(umlaufNode, ['KASSENBESTAND_SCHECKS_GUTHABEN_BEI_KREDITINSTITUTEN', 'KASSENBESTAND']),
      },
      rechnungsabgrenzung: top(aktivaRechAbgr),
    },
    passiva: {
      total: top(passiva),
      eigenkapital: {
        total:            top(ekNode),
        stammkapital:     amount(ekNode, ['EINGEFORDERTES_STAMMKAPITAL', 'STAMMKAPITAL', 'NENNKAPITAL', 'GRUNDKAPITAL']),
        kapitalruecklagen: amount(ekNode, ['KAPITALRUECKLAGEN']),
        gewinnruecklagen:  amount(ekNode, ['GEWINNRUECKLAGEN']),
        bilanzgewinn: {
          total:           top(bilanzgewinnNode),
          gewinnvortrag:   amount(bilanzgewinnNode, ['GEWINNVORTRAG', 'VERLUSTVORTRAG']),
          jahresueberschuss: amount(bilanzgewinnNode, ['JAHRESUEBERSCHUSS', 'JAHRESFEHLBETRAG']),
        },
      },
      unversteuerteRuecklagen: amount(passiva, ['UNVERSTEUERTE_RUECKLAGEN']),
      rueckstellungen: top(rueckstNode),
      verbindlichkeiten: {
        total:       top(verbindNode),
        langfristig: verbindLangfristig,
      },
      rechnungsabgrenzung: passivaRechAbgr && passivaRechAbgr !== aktivaRechAbgr ? top(passivaRechAbgr) : null,
    },
  };
}

// ─── BMF legacy parser (namespace finanzonline.bmf.gv.at/bilanz, vers 03.x) ───
// Positional §224 UGB structure, different tag names than v4 Justiz schema:
//   Aktiva:  HGB_224_2   (A=Anlage, B=Umlauf, C=RAP, D=latente Steuern)
//   Passiva: HGB_224_3   (A=EK mit IV=Bilanzgewinn/x=Gewinnvortrag,
//                         B=unversteuerte Rücklagen, C=Rückst., D=Verb., E=RAP)
//   GuV:     HGB_231_2_* (Gesamtkostenverfahren). Only full-form filings
//                         (ALLG_JUSTIZ/JABFORM/HGBFORM "JAB") carry it; the
//                         small form ("UGB23", HGB_Form_2/3) is balance sheet only.
// Current-year amounts live in <BETRAG> in euros. <BETRAG_VJ> holds the prior
// year — in thousand-euros when ALLG_JUSTIZ/VOR_GJ/WERT_TSD is "j", else euros.

function bmfAmount(section, col = 'BETRAG') {
  if (!section) return null;
  const pz = section.POSTENZEILE;
  const first = Array.isArray(pz) ? pz[0] : pz;
  if (!first) return null;
  const raw = first[col];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// §231 Abs 2 positions as numbered in the BMF schema, verified against the
// subtotals of real filings: Z1–Z8 sum to Z9, Z10–Z15 to Z16, Z9 + Z16 = Z17,
// Z17 + Z21 = Z30 and Z30 + Z31 = Z22. Expenses carry a negative sign.
const BMF_GUV = {
  umsatzerloese:                    'HGB_231_2_1',
  rohergebnis:                      'HGB_231_2_HGB_279', // mittelgroße GmbH: replaces Z1–Z3 and Z5
  bestandsveraenderung:             'HGB_231_2_2',
  aktivierteEigenleistungen:        'HGB_231_2_3',
  sonstigeBetrieblicheErtraege:     'HGB_231_2_4',
  materialaufwand:                  'HGB_231_2_5',
  personalaufwand:                  'HGB_231_2_6',
  abschreibungen:                   'HGB_231_2_7',
  sonstigeBetrieblicheAufwendungen: 'HGB_231_2_8',
  betriebserfolg:                   'HGB_231_2_9',
  finanzerfolg:                     'HGB_231_2_16',
  zinsaufwand:                      'HGB_231_2_15',
  ergebnisVorSteuern:               'HGB_231_2_17',
  steuernEinkommen:                 'HGB_231_2_21',
  ergebnisNachSteuern:              'HGB_231_2_30',
  jahresueberschuss:                'HGB_231_2_22',
};

function extractBmfGuv(guvNode, mul, col) {
  if (!guvNode) return null;
  const guv = {};
  for (const [field, tag] of Object.entries(BMF_GUV)) {
    const node = walk(guvNode, tag);
    guv[field] = node ? mul(bmfAmount(node, col)) : null;
  }
  if (guv.betriebserfolg == null && guv.jahresueberschuss == null) return null;
  guv.ebitda = ebitdaOf(guv);
  return guv;
}

function parseBmfLegacy(xmlText) {
  let tree;
  try { tree = parser.parse(xmlText); } catch { return null; }
  const env = tree?.UEBERMITTLUNG;
  if (!env) return null;

  const gl = env.BILANZ_GLIEDERUNG;
  if (!gl) return null;

  const allg = walk(gl, 'ALLG_JUSTIZ') || {};
  const gj = allg.GJ || {};
  const stichtag = gj.ENDE;
  if (!stichtag) return null;

  if (!walk(gl, 'HGB_224_2') && !walk(gl, 'HGB_224_3')) return null;

  const vjScale = allg.VOR_GJ?.WERT_TSD === 'j' ? 1000 : 1;
  const priorStichtag = allg.VOR_GJ?.ENDE || null;
  const prior = priorStichtag ? bmfYear(gl, (x) => x == null ? null : x * vjScale, 'BETRAG_VJ') : null;

  return {
    stichtag,
    currency: env.BILANZ_GLIEDERUNG?.ALLG_JUSTIZ?.WAEHRUNG || 'EUR',
    ...bmfYear(gl, (x) => x, 'BETRAG'),
    arbeitnehmer: null,
    priorYear: prior?.bilanzsumme != null ? { stichtag: priorStichtag, ...prior } : null,
  };
}

// All KPIs of one column (current or prior year) of a BMF filing.
function bmfYear(gl, mul, col) {
  const amount = (node) => (node ? mul(bmfAmount(node, col)) : null);

  const aktiva  = walk(gl, 'HGB_224_2');
  const passiva = walk(gl, 'HGB_224_3');

  const anlage  = aktiva && walk(aktiva, 'HGB_224_2_A');
  const umlauf  = aktiva && walk(aktiva, 'HGB_224_2_B');
  const rap_akt = aktiva && walk(aktiva, 'HGB_224_2_C');

  const ek      = passiva && walk(passiva, 'HGB_224_3_A');
  const bgNode  = ek && walk(ek, 'HGB_224_3_A_IV');
  const rueck   = passiva && walk(passiva, 'HGB_224_3_C');
  const verb    = passiva && walk(passiva, 'HGB_224_3_D');
  const rap_pas = passiva && walk(passiva, 'HGB_224_3_E');

  const bilanzsumme = amount(aktiva);
  const eigenkapital = amount(ek);
  const bgTotal        = amount(bgNode);
  const gewinnvortrag  = bgNode ? amount(walk(bgNode, 'HGB_224_3_A_IV_x')) : null;
  // Jahresüberschuss is not a distinct balance-sheet element — derive from
  // Bilanzgewinn − Gewinnvortrag (ignores reserve movements).
  const jahresueberschuss = (bgTotal != null && gewinnvortrag != null)
    ? bgTotal - gewinnvortrag
    : null;

  const balanceSheet = {
    aktiva: {
      total: bilanzsumme,
      anlagevermoegen: {
        total:         amount(anlage),
        immaterielle:  anlage && amount(walk(anlage, 'HGB_224_2_A_I')),
        sachanlagen:   anlage && amount(walk(anlage, 'HGB_224_2_A_II')),
        finanzanlagen: anlage && amount(walk(anlage, 'HGB_224_2_A_III')),
      },
      umlaufvermoegen: {
        total:         amount(umlauf),
        vorraete:      umlauf && amount(walk(umlauf, 'HGB_224_2_B_I')),
        forderungen:   umlauf && amount(walk(umlauf, 'HGB_224_2_B_II')),
        wertpapiere:   umlauf && amount(walk(umlauf, 'HGB_224_2_B_III')),
        kassenbestand: umlauf && amount(walk(umlauf, 'HGB_224_2_B_IV')),
      },
      rechnungsabgrenzung: amount(rap_akt),
    },
    passiva: {
      total: amount(passiva),
      eigenkapital: {
        total:             eigenkapital,
        stammkapital:      ek && amount(walkAny(ek, ['HGB_229_1_A_I', 'HGB_224_3_A_I'])),
        kapitalruecklagen: ek && amount(walk(ek, 'HGB_224_3_A_II')),
        gewinnruecklagen:  ek && amount(walk(ek, 'HGB_224_3_A_III')),
        bilanzgewinn: {
          total: bgTotal,
          gewinnvortrag,
          jahresueberschuss,
        },
      },
      rueckstellungen: amount(rueck),
      verbindlichkeiten: {
        total: amount(verb),
        langfristig: null, // BMF legacy doesn't break out Restlaufzeit at this level
      },
      rechnungsabgrenzung: amount(rap_pas),
    },
  };

  const guv = extractBmfGuv(gl.GUV, mul, col);

  return {
    umsatzerloese: guv?.umsatzerloese ?? null,
    bilanzsumme,
    eigenkapital,
    // The GuV's Jahresüberschuss is exact; the balance-sheet derivation is
    // only the fallback for small-form filings without GuV.
    jahresergebnis: guv?.jahresueberschuss ?? jahresueberschuss,
    betriebsergebnis: guv?.betriebserfolg ?? null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    balanceSheet,
    guv,
  };
}
