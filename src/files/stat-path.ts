import { lstatSync } from 'node:fs';
import type { FileSession } from './files.ts';
import { boolProperty, checked, fail, flag, MAX_TREE_BYTES, manifest, pathProperty, snapshot, stamp, tool, version } from './core/filesystem.ts';

export function statPathTool(session: FileSession) {
  return tool('stat_path', 'Inspect an allowed path; links/junctions may be followed for read-only access only. Returns existence, kind, size, timestamps and a version token. Readable/writable flags describe tool policy, not a guarantee of OS permissions. permission reports effective access, the selected directory rule and any global read-only cap. recursive:true previews a bounded directory tree (1,000 entries/64 MiB). Files up to 64 MiB include a content hash; larger files return metadata only and cannot be copied/moved by bounded operations.',
    { path: pathProperty, recursive: boolProperty }, ['path'], input => {
      const recursive = flag(input['recursive'], 'recursive');
      const path = checked(session, input['path'], 'read');
      const writable = (() => { try { checked(session, input['path'], 'write'); return true; } catch { return false; } })();
      const permission = path.permission ?? { access: session.role === 'implementer' && path.readable === undefined && path.engine === null ? 'full' : 'read-only', rule: null, capped_by_global_read_only: false };
      if (path.kind === 'missing') return { path: path.canonical, exists: false, kind: 'missing', readable: true, writable, permission };
      const stats = lstatSync(path.absolute, { bigint: true });
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) fail('Only regular files and directories may be inspected.');
      const canHash = path.kind !== 'file' || stats.size <= BigInt(MAX_TREE_BYTES);
      const snap = canHash ? snapshot(session, input['path'], 'read', recursive) : null;
      if ((snap !== null && snap.entries[0]?.stamp !== stamp(stats)) || stamp(lstatSync(path.absolute, { bigint: true })) !== stamp(stats)) fail('Path changed during metadata inspection; retry.');
      return {
        path: path.canonical, exists: true, kind: path.kind, size: Number(stats.size),
        modified_at: new Date(Number(stats.mtimeMs)).toISOString(), links: Number(stats.nlink), readable: true, writable, permission,
        content_hashed: path.kind === 'file' && canHash,
        version: snap?.version ?? version([['', stamp(stats), undefined]]),
        ...(snap?.entries[0]?.hash === undefined ? {} : { hash: snap.entries[0].hash }),
        ...(recursive && snap !== null ? { tree: manifest(snap) } : {}),
      };
    });
}
