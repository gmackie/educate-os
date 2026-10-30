import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const dev = spawn('pnpm', ['exec', 'wrangler', 'dev', '--config', 'wrangler.jsonc', '--port', String(port), '--local-upstream', 'mobile.educateos.io', '--upstream-protocol', 'https'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'pipe'] });
let ready = false;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay test runtime did not start within 60s')), 60000);
    const check = chunk => {
      if (!ready && chunk.toString().includes('Ready on')) { ready = true; clearTimeout(timer); resolve(); }
    };
    dev.stdout.on('data', check);
    dev.stderr.on('data', check);
    dev.once('exit', code => { if (!ready) { clearTimeout(timer); reject(new Error('Relay test runtime exited: ' + code)); } });
  });
  const test = spawn(process.execPath, ['--experimental-transform-types', 'relay.integration.mjs'], { cwd: import.meta.dirname, env: { ...process.env, RELAY_TEST_ORIGIN: `http://127.0.0.1:${port}` }, stdio: 'inherit' });
  const code = await new Promise(resolve => test.once('exit', resolve));
  if (code !== 0) throw new Error('Relay integration failed');
} finally { dev.kill('SIGTERM'); }
