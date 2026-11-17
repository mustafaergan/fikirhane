#!/usr/bin/env node
// Fikirhane'yi başlatır: node src/cli.js [--port 3310] [--no-open]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';
import { startDailyCheck } from './update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Kurulum klasöründeki .env (yalnızca ANAHTAR=değer satırları) okunur
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* .env yoksa varsayılanlar */ }

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(flag('--port') || process.env.FIKIRHANE_PORT || 3310);
const noOpen = args.includes('--no-open') || process.env.FIKIRHANE_NO_OPEN === '1';
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

try {
  await createServer({ port });
} catch (err) {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} kullanımda. Fikirhane zaten çalışıyor olabilir: http://127.0.0.1:${port}` : `Fikirhane başlatılamadı: ${err.message}`);
  process.exit(1);
}
startDailyCheck();
const url = `http://127.0.0.1:${port}`;
console.log(`[fikirhane] sürüm ${version}, Node ${process.version}\n\n  Fikirhane çalışıyor → ${url}\n  Durdurmak için Ctrl+C\n`);
if (!noOpen) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* adres konsolda */ }
}
