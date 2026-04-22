import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'IE',
  label: 'Irland',
  legalForms: {
    'HJLT': 'Private Company Limited by Shares',
    '5WWO': 'Public Limited Company',
    '7T2F': 'Designated Activity Company',
    'RSDE': 'Company Limited by Guarantee',
  },
});
