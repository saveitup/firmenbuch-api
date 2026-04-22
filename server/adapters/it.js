import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'IT',
  label: 'Italien',
  legalForms: {
    'LX8Q': 'Società a responsabilità limitata',
    '1GF1': 'Società per azioni',
    'MVII': 'Società in nome collettivo',
    'JC2D': 'Società in accomandita semplice',
    'G3MG': 'Società cooperativa',
  },
});
