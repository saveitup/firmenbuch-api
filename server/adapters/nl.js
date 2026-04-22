import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'NL',
  label: 'Niederlande',
  legalForms: {
    'JHN6': 'Besloten vennootschap',
    'JDUO': 'Naamloze vennootschap',
    '6MIQ': 'Coöperatie',
    'LFO4': 'Stichting',
    '9UBM': 'Vereniging',
  },
});
