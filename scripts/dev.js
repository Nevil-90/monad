/**
 * scripts/dev.js
 * One command for local development: starts the RedStone price relay and the Next.js dev server
 * together, with prefixed output. Ctrl+C stops both; if either exits, the other is stopped too.
 *
 * Usage: npm run dev                 relay + app
 *        npm run dev:testnet         relay + keeper (live, Monad testnet) + app; needs KEEPER_PRIVATE_KEY
 *                                    and NEXT_PUBLIC_CONTRACT_ADDRESS in .env. The keeper only sends
 *                                    transactions for rounds that have bets.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', name);

const procs = [
  { name: 'relay', color: 36, cmd: process.execPath, args: ['--env-file-if-exists=.env', 'scripts/price_relay.js'] },
  { name: 'app', color: 35, cmd: bin('next'), args: ['dev', '-p', process.env.PORT_APP || '3000'] }
];
if (process.argv.includes('--with-keeper')) {
  procs.push({ name: 'keeper', color: 33, cmd: process.execPath, args: ['--env-file-if-exists=.env', 'scripts/keeper_bot.js', '--mode', 'live', '--network', 'testnet'] });
}

let stopping = false;
const children = procs.map(({ name, color, cmd, args }) => {
  const child = spawn(cmd, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${tag}exited with code ${code}; stopping the rest`);
      stop(code || 1);
    }
  });
  return child;
});

function stop(code = 0) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGHUP', () => stop(0));
// If whatever started this (npm, a terminal) is killed outright, stop the children too instead of
// leaving a relay, keeper and app running in the background (a local check, no network)
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) stop(0); }, 2000).unref();
