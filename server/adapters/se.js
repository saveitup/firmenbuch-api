import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'SE',
  label: 'Schweden',
  legalForms: {
    '54WR': 'Aktiebolag',
    'Z42I': 'Publikt aktiebolag',
    '78OH': 'Handelsbolag',
    'B5UK': 'Kommanditbolag',
    '2Y87': 'Ekonomisk förening',
  },
});
