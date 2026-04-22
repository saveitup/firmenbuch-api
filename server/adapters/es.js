import { makeGleifAdapter } from './gleif-factory.js';

export default makeGleifAdapter({
  country: 'ES',
  label: 'Spanien',
  legalForms: {
    'LI7D': 'Sociedad de Responsabilidad Limitada',
    'SRVL': 'Sociedad Anónima',
    'DCFW': 'Sociedad Colectiva',
    'DDHB': 'Sociedad Comanditaria',
    '8888': 'Sociedad Cooperativa',
  },
});
