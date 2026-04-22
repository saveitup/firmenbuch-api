// Standalone migrator — runnable as `npm run db:migrate`.
import { migrate } from './index.js';

const { path } = migrate();
console.log(`[kontur] migrated → ${path}`);
