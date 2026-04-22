// Germany — thin wrapper around the shared GLEIF factory.
// Transitional adapter until Bundesanzeiger / Unternehmensregister SOAP
// access is granted; see README.md "Phase B" for the swap.
import { makeGleifAdapter } from './gleif-factory.js';

// Common ISO-20275 ELF codes for DE-registered entities.
const LEGAL_FORMS_DE = {
  '2HBR': 'Gesellschaft mit beschränkter Haftung',
  '6QQB': 'Aktiengesellschaft',
  'K4GH': 'Kommanditgesellschaft',
  'D1VF': 'GmbH & Co. KG',
  '8XKG': 'Offene Handelsgesellschaft',
  'V2YH': 'Partnerschaftsgesellschaft',
  'XTIQ': 'Unternehmergesellschaft (haftungsbeschränkt)',
  '9HYW': 'Eingetragener Verein',
  '2PFC': 'Eingetragene Genossenschaft',
  'SQKS': 'Societas Europaea',
};

const adapter = makeGleifAdapter({
  country: 'DE',
  label: 'Deutschland',
  legalForms: LEGAL_FORMS_DE,
  nationalIdPattern: '^HR[AB]\\s*\\d+',
});

// Country-specific overrides so the UI attribution matches what users expect.
adapter.license = 'CC0 — GLEIF (Übergangs-Adapter; Bundesanzeiger in Vorbereitung)';
adapter.attribution = 'Quelle: GLEIF (CC0). Nur Firmen mit LEI. Kein amtlicher Handelsregisterauszug.';

export default adapter;
