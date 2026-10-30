import { writeFileSync } from 'node:fs';
import { renderWorkerConfig } from '../../scripts/generate-worker-configs.ts';

const dir = import.meta.dirname;
writeFileSync(`${dir}/wrangler.jsonc`, await renderWorkerConfig(dir));
