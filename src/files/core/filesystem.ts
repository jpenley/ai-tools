import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, opendirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BuiltInTool, ToolReply } from '../../contract.ts';
import { fileHash, startCall, withFileLock, type AllowedPath, type FileAccess, type FileSession } from '../files.ts';

export const MAX_ENTRIES = 1000;
export const MAX_TREE_BYTES = 64 * 1024 * 1024;
export const MAX_REPLY_BYTES = 50 * 1024;

export function fail(message: string): never { throw new Error(message); }
export function reply(success: boolean, value: unknown): ToolReply {
  return { success, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
export function checked(session: FileSession, input: unknown, access: FileAccess): AllowedPath {
  const path = startCall(session).judge(input, access);
  if (!path.ok) fail(path.reason);
  return path;
}
export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}
export function flag(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') fail(`${name} must be true or false.`);
  return value === true;
}
export function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], run: (input: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>): BuiltInTool {
  return {
    tool: { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } },
    async call(input) {
      try { return reply(true, await run(input)); }
      catch (error) {
        const os = error as NodeJS.ErrnoException;
        return reply(false, os.code ? `Filesystem operation failed (${os.code}); no permission bypass or automatic retry was attempted.` : error instanceof Error ? error.message : 'Filesystem operation failed.');
      }
    },
  };
}
export const pathProperty = { type: 'string', description: 'Repository-relative or absolute path, subject to session access policy.' };
export const boolProperty = { type: 'boolean' };
export const baseProperty = { type: 'string', description: 'Version from stat_path, or a full file hash for a regular file. Directory trees require a recursive snapshot.' };

export function identity(stats: BigIntStats): string { return `${stats.dev}:${stats.ino}`; }
export function stamp(stats: BigIntStats): string {
  return `${identity(stats)}:${stats.mode}:${stats.nlink}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}
export function version(parts: unknown): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16); }

/** A valid file may fit the next call's input budget even when it cannot fit this call's remainder. */
export class ReadBudgetExceeded extends Error {
  readonly size: bigint;
  constructor(size: bigint, limit: number) {
    super(`Read budget exceeded (${limit} bytes).`);
    this.size = size;
  }
}

/** Bounded byte reader, with regular-file and before/after identity/version checks. */
export function readBytes(path: AllowedPath, limit = MAX_TREE_BYTES, offset = 0, window?: number): { bytes: Buffer; stats: BigIntStats } {
  const denied = path.recheck?.();
  if (denied) fail(denied);
  if (path.kind !== 'file') fail(`${path.canonical} is not a regular file.`);
  const fd = openSync(path.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd, { bigint: true });
    const there = lstatSync(path.absolute, { bigint: true });
    if (!stats.isFile() || there.isSymbolicLink() || stamp(stats) !== stamp(there)) fail('Path changed while opening; reread and retry.');
    if (window === undefined && stats.size > BigInt(limit)) throw new ReadBudgetExceeded(stats.size, limit);
    const available = stats.size > BigInt(offset) ? stats.size - BigInt(offset) : 0n;
    const length = Number(available < BigInt(window ?? limit) ? available : BigInt(window ?? limit));
    const bytes = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const n = readSync(fd, bytes, filled, length - filled, offset + filled);
      if (n === 0) fail('File changed while reading; reread and retry.');
      filled += n;
    }
    const after = lstatSync(path.absolute, { bigint: true });
    if (after.isSymbolicLink() || stamp(fstatSync(fd, { bigint: true })) !== stamp(stats) || stamp(after) !== stamp(stats)) fail('File changed while reading; reread and retry.');
    return { bytes, stats };
  } finally { closeSync(fd); }
}

export interface Entry { path: AllowedPath; relative: string; stamp: string; id: string; hash?: string; size: number; mtime: string }
export interface Snapshot { path: AllowedPath; entries: Entry[]; version: string; bytes: number }
export function snapshot(session: FileSession, input: unknown, access: FileAccess, recursive: boolean): Snapshot {
  const path = checked(session, input, access);
  if (path.kind === 'missing') fail(`${path.canonical} not found.`);
  const entries: Entry[] = [];
  let bytes = 0;
  let discovered = 1;
  const visit = (absolute: string, relativePath: string): void => {
    if (entries.length >= MAX_ENTRIES) fail(`Tree exceeds ${MAX_ENTRIES} entries; narrow the path.`);
    const current = checked(session, absolute, access);
    const stats = lstatSync(current.absolute, { bigint: true });
    if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) fail('Only regular files and directories are supported.');
    let hash: string | undefined;
    if (stats.isFile()) {
      if (stats.size > BigInt(MAX_TREE_BYTES - bytes)) fail(`Tree exceeds ${MAX_TREE_BYTES} bytes; narrow the path.`);
      const read = readBytes(current, MAX_TREE_BYTES - bytes);
      if (stamp(read.stats) !== stamp(stats)) fail('File changed during snapshot.');
      bytes += read.bytes.length;
      hash = fileHash(read.bytes);
    }
    entries.push({ path: current, relative: relativePath, stamp: stamp(stats), id: identity(stats), ...(hash === undefined ? {} : { hash }), size: Number(stats.size), mtime: stats.mtimeNs.toString() });
    if (recursive && stats.isDirectory()) {
      // Bound enumeration before materializing/sorting a directory's full contents.
      const names: string[] = [];
      const directory = opendirSync(current.absolute);
      try {
        for (let next = directory.readSync(); next !== null; next = directory.readSync()) {
          names.push(next.name);
          discovered++;
          if (discovered > MAX_ENTRIES) fail(`Tree exceeds ${MAX_ENTRIES} entries; narrow the path.`);
        }
      } finally { directory.closeSync(); }
      for (const name of names.sort()) visit(join(absolute, name), relativePath === '' ? name : `${relativePath}/${name}`);
      if (stamp(lstatSync(current.absolute, { bigint: true })) !== stamp(stats)) fail('Directory changed during snapshot.');
    }
  };
  visit(path.requested ?? path.absolute, '');
  return { path, entries, bytes, version: version(entries.map(entry => [entry.relative, entry.stamp, entry.hash])) };
}
export function matchesBase(snap: Snapshot, base: unknown): boolean {
  return typeof base === 'string' && (base === snap.version || (snap.entries.length === 1 && base === snap.entries[0]?.hash));
}
export function requireBase(snap: Snapshot, base: unknown, name = 'base'): void {
  if (!matchesBase(snap, base)) fail(`STALE: ${name} is missing or does not match; obtain a fresh stat_path snapshot.`);
}
export function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export async function locked<T>(paths: readonly string[], action: () => T): Promise<T> {
  const unique = [...new Map(paths.map(path => [path.toUpperCase(), path])).values()].sort((a, b) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
  const acquire = (index: number): Promise<T> => index === unique.length ? Promise.resolve(action()) : withFileLock(unique[index]!, () => acquire(index + 1));
  return acquire(0);
}
export function manifest(snap: Snapshot): unknown {
  const entries: unknown[] = [];
  let budget = 0;
  for (const entry of snap.entries) {
    const item = { path: entry.path.canonical, kind: entry.path.kind, bytes: entry.size };
    budget += Buffer.byteLength(JSON.stringify(item));
    if (budget > 16 * 1024) break;
    entries.push(item);
  }
  return { path: snap.path.canonical, version: snap.version, entries, entry_count: snap.entries.length, bytes: snap.bytes, manifest_truncated: entries.length !== snap.entries.length };
}
