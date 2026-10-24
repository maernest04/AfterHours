// Cross-platform wrapper for the spacetime CLI, configured by environment variables.
// Usage: node scripts/db.mjs <publish|reset|generate|sql> [sql query]

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(root, 'backend', 'db', 'spacetime', 'spacetimedb');
const bindingsPath = join(root, 'backend', 'db', 'bindings');

const server = process.env.SPACETIMEDB_URI ?? 'http://localhost:3000';
const database = process.env.SPACETIMEDB_DATABASE ?? 'accrual-docs';

function spacetimeBin() {
  if (process.env.SPACETIME_BIN) return process.env.SPACETIME_BIN;
  const winDefault = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
  return winDefault && existsSync(winDefault) ? winDefault : 'spacetime';
}

const commands = {
  publish: ['publish', database, '--server', server, '--module-path', modulePath, '--no-config', '--yes'],
  reset: ['publish', database, '--server', server, '--module-path', modulePath, '--no-config', '--yes', '--delete-data=always'],
  generate: ['generate', '--lang', 'typescript', '--out-dir', bindingsPath, '--module-path', modulePath, '--no-config', '-y'],
  sql: ['sql', database, '--server', server, process.argv[3] ?? 'SELECT id, doc_type, version, reference_id FROM documents'],
};

const name = process.argv[2];
if (!(name in commands)) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
if (name !== 'generate') console.log(`[db] ${name}: database "${database}" on ${server}`);
const result = spawnSync(spacetimeBin(), commands[name], { stdio: 'inherit' });
process.exit(result.status ?? 1);
