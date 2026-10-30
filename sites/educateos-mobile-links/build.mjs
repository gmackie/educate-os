import { build } from 'esbuild';
await build({ entryPoints: [new URL('./pair-browser.ts', import.meta.url).pathname], bundle: true,
  platform: 'browser', format: 'esm', minify: true, outfile: new URL('../../apps/mobile/app-links/pair.js', import.meta.url).pathname });
