import { lstatSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs';
import type { FileSession } from './files.ts';
import { baseProperty, boolProperty, checked, fail, flag, identity, locked, manifest, pathProperty, requireBase, snapshot, stamp, tool } from './core/filesystem.ts';

export function removeDirectoryTool(session: FileSession) {
  return tool('remove_directory', 'Remove a repository directory, empty-only by default. Obtain a preview with preview:true, then execute with its base version. Recursive deletion additionally requires recursive:true; the complete bounded tree is preflighted and its version must match. No links, credentials or Git internals. Unexpected new entries cause failure, never unbounded deletion. Partial failures are reported.', {
    path: pathProperty, recursive: boolProperty, preview: boolProperty, base: baseProperty,
  }, ['path'], async input => {
    const recursive = flag(input['recursive'], 'recursive');
    const preview = flag(input['preview'], 'preview');
    const path = checked(session, input['path'], 'write');
    if (path.kind !== 'folder') fail('Path must be an existing writable directory.');
    const empty = (): void => {
      const directory = opendirSync(path.absolute);
      try { if (directory.readSync() !== null) fail('Directory is not empty; recursive:true and a fresh recursive preview are required.'); }
      finally { directory.closeSync(); }
    };
    if (!recursive) empty();
    const before = snapshot(session, path.absolute, 'write', recursive);
    if (preview) return { operation: 'remove_directory', recursive, ...manifest(before) as object };
    requireBase(before, input['base']);
    return locked(before.entries.map(entry => entry.path.absolute), () => {
      const fresh = snapshot(session, path.absolute, 'write', recursive);
      if (fresh.version !== before.version) fail('STALE: tree changed while waiting for locks.');
      if (!recursive) empty();
      let removed = 0;
      try {
        for (const entry of [...fresh.entries].reverse()) {
          const current = checked(session, entry.path.absolute, 'write');
          const stats = lstatSync(current.absolute, { bigint: true });
          if (identity(stats) !== entry.id || (entry.path.kind === 'file' && stamp(stats) !== entry.stamp)) fail('An entry changed during deletion.');
          if (entry.path.kind === 'folder') rmdirSync(current.absolute);
          else unlinkSync(current.absolute);
          removed++;
        }
      } catch (error) {
        fail(`Directory removal failed after ${removed} entries were removed (${(error as NodeJS.ErrnoException).code ?? 'path changed'}). Partial deletion is possible; inspect before retrying.`);
      }
      return { path: path.canonical, removed_entries: removed };
    });
  });
}
