import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'BE',
  label: 'Belgien',
  legalForms: {
    'JO3B': 'Société à responsabilité limitée / Besloten vennootschap',
    'VM5W': 'Société anonyme / Naamloze vennootschap',
    '7GVP': 'Société coopérative / Coöperatieve vennootschap',
  },
});
