import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileHash, type FileSession } from '../files.ts';
import { baseProperty, boolProperty, checked, fail, flag, identity, locked, manifest, pathProperty, readBytes, requireBase, snapshot, stamp, tool, within, type Entry, type Snapshot } from './filesystem.ts';

/** Synchronous after lock acquisition: no in-process writer can interleave a tree mutation. */
export interface TransferFaults { readonly beforeEntry?: (entry: Entry) => void }
export function transferPathTool(session: FileSession, moving: boolean, faults: TransferFaults = {}) {
  const name = moving ? 'move_path' : 'copy_path';
  return tool(name,
    `${moving ? 'Move/rename' : 'Copy bytes from'} a regular file or explicitly recursive directory tree. ${moving ? 'Both paths must be writable repository paths; no Git staging. Moves require the same filesystem.' : 'The source may be any readable path; the destination must be in the repository.'} Require base from stat_path (recursive:true for trees), or preview:true to obtain it. Existing destinations are refused unless overwrite:true and destination_base match; overwrite is file-only. Source links may be followed for reads only; mutations through links and link creation are prohibited. Bounds: 1,000 entries/64 MiB. Recursive operations are not atomic; failures report partial completion.`,
    { source: pathProperty, destination: pathProperty, base: baseProperty, destination_base: baseProperty, recursive: boolProperty, overwrite: boolProperty, preview: boolProperty }, ['source', 'destination'], async input => {
      const recursive = flag(input['recursive'], 'recursive');
      const overwrite = flag(input['overwrite'], 'overwrite');
      const preview = flag(input['preview'], 'preview');
      const sourcePath = checked(session, input['source'], moving ? 'write' : 'read');
      if (sourcePath.kind === 'folder' && !recursive) fail('Directory transfer requires recursive:true and a recursive stat_path version.');
      const source = snapshot(session, input['source'], moving ? 'write' : 'read', recursive);
      const destination = checked(session, input['destination'], 'write');
      if (within(source.path.absolute, destination.absolute) || within(destination.absolute, source.path.absolute)) fail('Source and destination must be distinct and neither may contain the other.');
      if (source.path.kind === 'folder' && overwrite) fail('Directory overwrite/merge is not supported.');
      let previous: Snapshot | null = null;
      if (destination.kind !== 'missing') {
        if (!overwrite || source.path.kind !== 'file' || destination.kind !== 'file') fail('Destination exists; file replacement requires overwrite:true and destination_base.');
        previous = snapshot(session, destination.absolute, 'write', false);
        if (!preview) requireBase(previous, input['destination_base'], 'destination_base');
      }
      const parent = checked(session, dirname(destination.absolute), 'read');
      if (parent.kind !== 'folder') fail('Destination parent must already exist; use make_directory with parents:true first.');
      const targets = source.entries.map(entry => checked(session, entry.relative === '' ? destination.absolute : join(destination.absolute, entry.relative), 'write'));
      if (moving) {
        const device = lstatSync(source.path.absolute, { bigint: true }).dev;
        if (device !== lstatSync(parent.absolute, { bigint: true }).dev || source.entries.some(entry => lstatSync(entry.path.absolute, { bigint: true }).dev !== device)) fail('Cross-filesystem moves are refused; copy and explicitly remove the source instead.');
      }
      if (preview) return { operation: name, source: manifest(source), destination: destination.canonical, destination_version: previous?.version ?? null, overwrite, recursive };
      requireBase(source, input['base']);
      const paths = [...source.entries.map(entry => entry.path.absolute), ...targets.map(path => path.absolute)];
      return locked(paths, () => {
        const fresh = snapshot(session, input['source'], moving ? 'write' : 'read', recursive);
        if (fresh.version !== source.version) fail('STALE: source changed while waiting for locks.');
        const now = checked(session, destination.absolute, 'write');
        if (previous === null) {
          if (now.kind !== 'missing') fail('STALE: destination appeared while waiting for locks.');
        } else if (snapshot(session, now.absolute, 'write', false).version !== previous.version) fail('STALE: destination changed while waiting for locks.');
        if (checked(session, parent.absolute, 'read').kind !== 'folder') fail('Destination parent changed.');
        // Revalidate the complete mapped destination before the first mutation.
        for (const target of targets) checked(session, target.absolute, 'write');
        const completed: string[] = [];
        try {
          for (const entry of fresh.entries) {
            faults.beforeEntry?.(entry);
            const target = checked(session, entry.relative === '' ? destination.absolute : join(destination.absolute, entry.relative), 'write');
            if (entry.path.kind === 'folder') {
              if (target.kind !== 'missing') fail('Destination directory appeared during transfer.');
              mkdirSync(target.absolute);
            } else {
              if (moving) moveFile(session, entry, target.absolute, previous !== null && entry.relative === '' ? previous : null);
              else copyFile(session, entry, target.absolute, previous !== null && entry.relative === '' ? previous : null);
            }
            completed.push(target.canonical);
          }
          if (moving && source.path.kind === 'folder') {
            for (const entry of [...fresh.entries].reverse()) {
              if (entry.path.kind !== 'folder') continue;
              const path = checked(session, entry.path.absolute, 'write');
              if (identity(lstatSync(path.absolute, { bigint: true })) !== entry.id) fail('Source directory identity changed.');
              rmdirSync(path.absolute); // Never recursive: an unexpected new entry causes failure.
            }
          }
          return { operation: name, source: source.path.canonical, destination: destination.canonical, completed_entries: completed.length, atomic: source.path.kind === 'file' && overwrite && moving };
        } catch (error) {
          const os = error as NodeJS.ErrnoException;
          fail(`${name} failed${os.code ? ` (${os.code})` : `: ${error instanceof Error ? error.message : 'unknown error'}`}. Partial completion: ${completed.length} destination entries completed. Inspect source and destination before retrying; no recursive rollback was attempted.`);
        }
      });
    });
}

function moveFile(session: FileSession, entry: Entry, destination: string, previous: Snapshot | null): void {
  const source = checked(session, entry.path.absolute, 'write');
  const fresh = snapshot(session, source.absolute, 'write', false);
  if (fresh.entries[0]?.stamp !== entry.stamp || fresh.entries[0]?.hash !== entry.hash) fail('Source file changed during move.');
  const target = checked(session, destination, 'write');
  if (previous !== null) {
    if (snapshot(session, target.absolute, 'write', false).version !== previous.version) fail('STALE: destination changed before overwrite.');
    renameSync(source.absolute, target.absolute); return;
  }
  if (target.kind !== 'missing') fail('Destination appeared during move.');
  // link/unlink provides exclusive no-clobber publication (rename alone could replace a raced destination).
  linkSync(source.absolute, target.absolute);
  try {
    const now = lstatSync(source.absolute, { bigint: true });
    if (identity(now) !== entry.id || !now.isFile() || now.nlink !== 2n || Number(now.size) !== entry.size || now.mtimeNs.toString() !== entry.mtime) fail('Source changed during relocation.');
    unlinkSync(source.absolute);
  } catch (error) {
    if (identity(lstatSync(target.absolute, { bigint: true })) === entry.id) unlinkSync(target.absolute);
    throw error;
  }
}

function copyFile(session: FileSession, entry: Entry, destination: string, previous: Snapshot | null): void {
  const source = checked(session, entry.path.requested ?? entry.path.absolute, 'read');
  const fresh = snapshot(session, source.requested ?? source.absolute, 'read', false);
  if (fresh.entries[0]?.stamp !== entry.stamp || fresh.entries[0]?.hash !== entry.hash) fail('Source file changed during copy.');
  const read = readBytes(source);
  const bytes = read.bytes;
  if (stamp(read.stats) !== entry.stamp || fileHash(bytes) !== entry.hash) fail('Source changed before copying bytes.');
  const target = checked(session, destination, 'write');
  const temp = join(dirname(target.absolute), `.${randomUUID()}.ff-tmp`);
  let ownedTemp = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    ownedTemp = true;
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const current = checked(session, target.absolute, 'write');
    if (previous !== null) {
      if (snapshot(session, current.absolute, 'write', false).version !== previous.version) fail('STALE: destination changed before overwrite.');
      renameSync(temp, current.absolute);
      ownedTemp = false;
    } else {
      if (current.kind !== 'missing') fail('Destination appeared during copy.');
      linkSync(temp, current.absolute); // Atomic no-clobber publication.
    }
  } finally { if (ownedTemp) unlinkSync(temp); }
}
