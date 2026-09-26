/**
 * scripts/dev.js
 * One command for local development: starts the RedStone price relay and the Next.js dev server
 * together, with prefixed output. Ctrl+C stops both; if either exits, the other is stopped too.
 *
 * Usage: npm run dev
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
