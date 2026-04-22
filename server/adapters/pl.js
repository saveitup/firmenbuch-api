import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'PL',
  label: 'Polen',
  legalForms: {
    'O8CB': 'Spółka z ograniczoną odpowiedzialnością',
    'YOIU': 'Spółka akcyjna',
    '62S5': 'Spółka komandytowa',
    '93WI': 'Spółka jawna',
  },
  nationalIdPattern: '^(?:KRS|NIP|REGON)[-\\s]?\\d',
});
