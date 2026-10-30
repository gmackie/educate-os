import { readFileSync } from 'node:fs';
import { Store } from './store.mjs';
import { createDashboard } from './server.mjs';
import { importContacts } from './domain.mjs';
import { check } from './safety.mjs';

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'help') {
    console.log('EducateOS Foundation Launch Operations (Node 22+)\n\nnode tools/launch-ops/src/cli.mjs serve [--port 4318]\nnode tools/launch-ops/src/cli.mjs demo\nnode tools/launch-ops/src/cli.mjs suggest --allow-network --allow-expense educator teaching,training\n\nAll state and exports: tools/launch-ops/.private/ (gitignored). No send action.'); return;
  }
  if (command === 'suggest') {
    const { suggest } = await import('./llm.mjs');
    check(args.length === 4 && args[0] === '--allow-network' && args[1] === '--allow-expense', 'Use suggest --allow-network --allow-expense <educator|technical> <comma-separated-tags>');
    console.log(JSON.stringify(await suggest({ allowNetwork: true, allowExpense: true, council: args[2], tags: args[3].split(',') }), null, 2)); return;
  }
  check(['serve', 'demo'].includes(command), 'Unknown command');
  const store = new Store();
  if (command === 'demo') {
    check(args.length === 0, 'Demo takes no arguments');
    const csv = readFileSync(new URL('../examples/fictional-contacts.csv', import.meta.url), 'utf8');
    console.log(store.transaction(s => importContacts(s, { csv, publicProfessionalOnly: true, noStudentData: true, operator: 'Fictional example loader' }))); return;
  }
  check(args.length === 0 || (args.length === 2 && args[0] === '--port' && /^\d+$/.test(args[1])), 'Use serve [--port <1024–65535>]');
  const port = args.length ? Number(args[1]) : 4318;
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Port must be 1024–65535');
  const { server, token } = createDashboard(store);
  server.on('error', () => { console.error('Could not start loopback dashboard; check whether the port is already in use.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local private dashboard: http://127.0.0.1:${port}/#${token}\nTreat this URL as a local session secret. No email actions. Stop with Ctrl+C.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
