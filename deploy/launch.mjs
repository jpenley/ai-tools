import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kind = process.argv[2];
if (kind !== 'files' && kind !== 'git') throw new Error('Expected files or git.');
const current = JSON.parse(readFileSync(new URL('./current.json', import.meta.url), 'utf8'));
if (!/^[a-f0-9]{40,64}$/.test(current.commit)) throw new Error('Invalid deployed commit.');
const entry = new URL(`./releases/${current.commit}/src/${kind}/server.ts`, import.meta.url);
// Preserve the server's ordinary argument contract; pin this process to one release.
process.argv = [process.execPath, fileURLToPath(entry), ...process.argv.slice(3)];
await import(entry.href);
