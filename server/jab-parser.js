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
// the Bilanz/Kennzahlen view.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  parseAttributeValue: false,
});

const SCALE = { E: 1, TE: 1000, ME: 1_000_000 };

function topBetrag(section) {
  if (!section) return null;
  const posten = section.POSTENZEILE;
  const first = Array.isArray(posten) ? posten[0] : posten;
  if (!first) return null;
  const raw = first.BETRAG_GJ;
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

function sectionAmount(root, names, mul) {
  const node = walkAny(root, names);
  return node ? mul(topBetrag(node)) : null;
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

  // Pull named sections anywhere under the envelope.
  const umsatz       = walk(envelope, 'UMSATZERLOESE');
  const aktiva       = walk(envelope, 'AKTIVA');
  const passiva      = walk(envelope, 'PASSIVA');
  const eigenkapital = walk(envelope, 'EIGENKAPITAL');
  const betriebs     = walk(envelope, 'ZWISCHENSUMME_BETRIEBSERFOLG');
  const ergebnisNach = walk(envelope, 'ERGEBNIS_NACH_STEUERN');

  const bilanzsumme       = mul(topBetrag(aktiva));
  const eigenkapitalBetrag = mul(topBetrag(eigenkapital));
  const jahresergebnis    = mul(topBetrag(ergebnisNach));

  const balanceSheet = extractBalanceSheet(aktiva, passiva, mul);

  return {
    stichtag,
    currency: 'EUR',
    umsatzerloese:    mul(topBetrag(umsatz)),
    bilanzsumme,
    eigenkapital:     eigenkapitalBetrag,
    jahresergebnis,
    betriebsergebnis: mul(topBetrag(betriebs)),
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapitalBetrag != null) ? eigenkapitalBetrag / bilanzsumme : null,
    balanceSheet,
  };
}

// ─── Bilanz‑Breakdown ────────────────────────────────────────────────────
// Walks the AKTIVA / PASSIVA subtrees and extracts each named sub‑section's
// summary line. Everything is null‑safe: if an element is absent in the
// filing, the field comes back as null and downstream ratios return null
// for the affected metric. Element names follow §224 UGB and the Justiz v4
// schema. We accept a handful of known synonyms (e.g. JAHRESUEBERSCHUSS vs
// JAHRESFEHLBETRAG) to cover both positive and negative reporters.

function extractBalanceSheet(aktiva, passiva, mul) {
  if (!aktiva && !passiva) return null;

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
    if (davon) verbindLangfristig = mul(topBetrag(davon));
  }

  return {
    aktiva: {
      total: mul(topBetrag(aktiva)),
      anlagevermoegen: {
        total:        anlageNode ? mul(topBetrag(anlageNode)) : null,
        immaterielle: sectionAmount(anlageNode, ['IMMATERIELLE_VERMOEGENSGEGENSTAENDE'], mul),
        sachanlagen:  sectionAmount(anlageNode, ['SACHANLAGEN'], mul),
        finanzanlagen: sectionAmount(anlageNode, ['FINANZANLAGEN'], mul),
      },
      umlaufvermoegen: {
        total:       umlaufNode ? mul(topBetrag(umlaufNode)) : null,
        vorraete:    sectionAmount(umlaufNode, ['VORRAETE'], mul),
        forderungen: sectionAmount(umlaufNode, ['FORDERUNGEN_UND_SONSTIGE_VERMOEGENSGEGENSTAENDE', 'FORDERUNGEN'], mul),
        wertpapiere: sectionAmount(umlaufNode, ['WERTPAPIERE_UND_ANTEILE', 'WERTPAPIERE'], mul),
        kassenbestand: sectionAmount(umlaufNode, ['KASSENBESTAND_SCHECKS_GUTHABEN_BEI_KREDITINSTITUTEN', 'KASSENBESTAND'], mul),
      },
      rechnungsabgrenzung: aktivaRechAbgr ? mul(topBetrag(aktivaRechAbgr)) : null,
    },
    passiva: {
      total: mul(topBetrag(passiva)),
      eigenkapital: {
        total:            ekNode ? mul(topBetrag(ekNode)) : null,
        stammkapital:     sectionAmount(ekNode, ['EINGEFORDERTES_STAMMKAPITAL', 'STAMMKAPITAL', 'NENNKAPITAL', 'GRUNDKAPITAL'], mul),
        kapitalruecklagen: sectionAmount(ekNode, ['KAPITALRUECKLAGEN'], mul),
        gewinnruecklagen:  sectionAmount(ekNode, ['GEWINNRUECKLAGEN'], mul),
        bilanzgewinn: {
          total:           bilanzgewinnNode ? mul(topBetrag(bilanzgewinnNode)) : null,
          gewinnvortrag:   sectionAmount(bilanzgewinnNode, ['GEWINNVORTRAG', 'VERLUSTVORTRAG'], mul),
          jahresueberschuss: sectionAmount(bilanzgewinnNode, ['JAHRESUEBERSCHUSS', 'JAHRESFEHLBETRAG'], mul),
        },
      },
      unversteuerteRuecklagen: sectionAmount(passiva, ['UNVERSTEUERTE_RUECKLAGEN'], mul),
      rueckstellungen: rueckstNode ? mul(topBetrag(rueckstNode)) : null,
      verbindlichkeiten: {
        total:       verbindNode ? mul(topBetrag(verbindNode)) : null,
        langfristig: verbindLangfristig,
      },
      rechnungsabgrenzung: passivaRechAbgr && passivaRechAbgr !== aktivaRechAbgr ? mul(topBetrag(passivaRechAbgr)) : null,
    },
  };
}

// ─── BMF legacy parser (namespace finanzonline.bmf.gv.at/bilanz, vers 03.x) ───
// Positional §224 UGB structure, different tag names than v4 Justiz schema:
//   Aktiva:  HGB_224_2   (A=Anlage, B=Umlauf, C=RAP, D=latente Steuern)
//   Passiva: HGB_224_3   (A=EK mit IV=Bilanzgewinn/x=Gewinnvortrag,
//                         B=unversteuerte Rücklagen, C=Rückst., D=Verb., E=RAP)
// Current-year amounts live in <BETRAG> in euros (no scaling); VJ column is
// in thousand-euros but we don't surface it here. GuV is rarely included in
// BMF filings — we derive Jahresüberschuss from Bilanzgewinn − Gewinnvortrag.

function bmfAmount(section) {
  if (!section) return null;
  const pz = section.POSTENZEILE;
  const first = Array.isArray(pz) ? pz[0] : pz;
  if (!first) return null;
  const raw = first.BETRAG;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
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

  const aktiva  = walk(gl, 'HGB_224_2');
  const passiva = walk(gl, 'HGB_224_3');
  if (!aktiva && !passiva) return null;

  const anlage  = aktiva && walk(aktiva, 'HGB_224_2_A');
  const umlauf  = aktiva && walk(aktiva, 'HGB_224_2_B');
  const rap_akt = aktiva && walk(aktiva, 'HGB_224_2_C');

  const ek      = passiva && walk(passiva, 'HGB_224_3_A');
  const bgNode  = ek && walk(ek, 'HGB_224_3_A_IV');
  const rueck   = passiva && walk(passiva, 'HGB_224_3_C');
  const verb    = passiva && walk(passiva, 'HGB_224_3_D');
  const rap_pas = passiva && walk(passiva, 'HGB_224_3_E');

  const bilanzsumme = bmfAmount(aktiva);
  const eigenkapital = bmfAmount(ek);
  const bgTotal        = bmfAmount(bgNode);
  const gewinnvortrag  = bgNode ? bmfAmount(walk(bgNode, 'HGB_224_3_A_IV_x')) : null;
  // Jahresüberschuss is not a distinct BMF element — derive from Bilanzgewinn − Gewinnvortrag.
  const jahresueberschuss = (bgTotal != null && gewinnvortrag != null)
    ? bgTotal - gewinnvortrag
    : null;

  const balanceSheet = {
    aktiva: {
      total: bilanzsumme,
      anlagevermoegen: {
        total:         bmfAmount(anlage),
        immaterielle:  anlage && bmfAmount(walk(anlage, 'HGB_224_2_A_I')),
        sachanlagen:   anlage && bmfAmount(walk(anlage, 'HGB_224_2_A_II')),
        finanzanlagen: anlage && bmfAmount(walk(anlage, 'HGB_224_2_A_III')),
      },
      umlaufvermoegen: {
        total:         bmfAmount(umlauf),
        vorraete:      umlauf && bmfAmount(walk(umlauf, 'HGB_224_2_B_I')),
        forderungen:   umlauf && bmfAmount(walk(umlauf, 'HGB_224_2_B_II')),
        wertpapiere:   umlauf && bmfAmount(walk(umlauf, 'HGB_224_2_B_III')),
        kassenbestand: umlauf && bmfAmount(walk(umlauf, 'HGB_224_2_B_IV')),
      },
      rechnungsabgrenzung: bmfAmount(rap_akt),
    },
    passiva: {
      total: bmfAmount(passiva),
      eigenkapital: {
        total:             eigenkapital,
        stammkapital:      ek && bmfAmount(walkAny(ek, ['HGB_229_1_A_I', 'HGB_224_3_A_I'])),
        kapitalruecklagen: ek && bmfAmount(walk(ek, 'HGB_224_3_A_II')),
        gewinnruecklagen:  ek && bmfAmount(walk(ek, 'HGB_224_3_A_III')),
        bilanzgewinn: {
          total: bgTotal,
          gewinnvortrag,
          jahresueberschuss,
        },
      },
      rueckstellungen: bmfAmount(rueck),
      verbindlichkeiten: {
        total: bmfAmount(verb),
        langfristig: null, // BMF legacy doesn't break out Restlaufzeit at this level
      },
      rechnungsabgrenzung: bmfAmount(rap_pas),
    },
  };

  return {
    stichtag,
    currency: env.BILANZ_GLIEDERUNG?.ALLG_JUSTIZ?.WAEHRUNG || 'EUR',
    umsatzerloese: null,          // not in BMF filings without full GuV
    bilanzsumme,
    eigenkapital,
    jahresergebnis: jahresueberschuss,
    betriebsergebnis: null,
    arbeitnehmer: null,
    ek_quote: (bilanzsumme && eigenkapital != null) ? eigenkapital / bilanzsumme : null,
    balanceSheet,
  };
}
