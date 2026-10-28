import { defineConfig } from 'vite-plus';

export default defineConfig({ run: { tasks: {
  build: { command: 'tsc --noEmit && node build.mjs && node generate.ts', cache: false },
  test: { command: 'node --experimental-strip-types --test pairing.test.ts && node verify-relay.mjs', cache: false },
} } });
