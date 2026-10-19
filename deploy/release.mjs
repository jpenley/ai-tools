import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const deploy = dirname(fileURLToPath(import.meta.url));
const root = resolve(deploy, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm run deploy.');
const npm = (cwd, ...args) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
const commit = git('rev-parse', '--verify', 'HEAD^{commit}').toString('utf8').trim();
if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit.');
mkdirSync(join(deploy, 'releases'), { recursive: true });
// Exclusive lock prevents two publishers from racing the active pointer.
const lock = join(deploy, '.release-lock');
mkdirSync(lock);
let staging;
let pointer;
try {
  staging = mkdtempSync(join(deploy, '.staging-'));
  // Copy committed blobs, never partially edited working-tree files or node_modules.
  const entries = git('ls-tree', '-rz', commit).toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Unsupported Git tree entry.');
    const [, mode, blob, path] = match;
    if (!(path.startsWith('src/') || ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'].includes(path) || path.startsWith('test/'))) continue;
    if (!['100644', '100755'].includes(mode) || path.split('/').some(p => p === '..' || p === '.') || path.includes('\\')) throw new Error('Unsafe release entry: ' + path);
    const destination = join(staging, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, git('cat-file', 'blob', blob), { flag: 'wx' });
  }
  npm(staging, 'ci', '--ignore-scripts', '--no-audit', '--no-fund');
  npm(staging, 'run', 'typecheck');
  npm(staging, 'test');
  npm(staging, 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund');
  writeFileSync(join(staging, 'release.json'), JSON.stringify({ commit, createdAt: new Date().toISOString() }, null, 2) + '\n');
  // Existing releases are never overwritten, even when publishing the same commit.
  renameSync(staging, join(deploy, 'releases', commit));
  staging = undefined;
  pointer = join(deploy, '.current-' + process.pid + '.json');
  writeFileSync(pointer, JSON.stringify({ commit }, null, 2) + '\n', { flag: 'wx' });
  renameSync(pointer, join(deploy, 'current.json'));
  pointer = undefined;
  console.log('Deployed ' + commit + '. Restart/reconnect both MCP servers to activate.');
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
  if (pointer) rmSync(pointer, { force: true });
  rmSync(lock, { recursive: true, force: true });
}
