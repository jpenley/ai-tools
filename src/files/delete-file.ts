import { lstatSync, unlinkSync } from 'node:fs';
import type { FileSession, RemoverFaults } from './files.ts';
import type { GatewayTool } from '../contract.ts';
import { withFileLock } from './files.ts';
import { baseProperty, checked, fail, MAX_TREE_BYTES, pathProperty, snapshot, stamp, tool, version } from './core/filesystem.ts';

const properties = { path: pathProperty, base: baseProperty };
export const DELETE_FILE_TOOL: GatewayTool = {
  name: 'delete_file',
  description: 'Delete one regular file (text or binary). Require base from stat_path; a view_file hash also works up to 64 MiB. Above 64 MiB require the metadata version from stat_path (identity, size, mode and timestamps; not a content hash). Links, hard-linked files, folders and protected paths are refused. Stale versions delete nothing.',
  inputSchema: { type: 'object', properties, required: ['path', 'base'], additionalProperties: false },
};

/** Raw-file deletion: content hashes up to 64 MiB, metadata versions above it. */
export function deleteFileTool(session: FileSession, faults: RemoverFaults = {}) {
  return tool(DELETE_FILE_TOOL.name, DELETE_FILE_TOOL.description, properties, ['path', 'base'], async input => {
    if (typeof input['base'] !== 'string' || !input['base'].trim()) fail('base is required: use stat_path or view_file.');
    const base = input['base'].trim().toLowerCase();
    const path = checked(session, input['path'], 'write');
    return withFileLock(path.absolute, async () => {
      const inspect = () => {
        const current = checked(session, input['path'], 'write');
        if (current.kind !== 'file') fail('STALE: expected an existing regular file; folders are never deleted.');
        const stats = lstatSync(current.absolute, { bigint: true });
        if (!stats.isFile() || stats.nlink !== 1n) fail('Only non-linked regular files may be deleted.');
        if (stats.size > BigInt(MAX_TREE_BYTES)) return { current, token: version([['', stamp(stats), undefined]]), hash: undefined, stamp: stamp(stats) };
        const snap = snapshot(session, input['path'], 'write', false);
        return { current, token: snap.version, hash: snap.entries[0]?.hash, stamp: snap.entries[0]!.stamp };
      };
      const before = inspect();
      if (base !== before.token && base !== before.hash) fail('STALE: file changed; inspect it again. Nothing was deleted.');
      await faults.beforeRecheck?.();
      const fresh = inspect();
      if (fresh.token !== before.token || fresh.current.absolute !== before.current.absolute) fail('STALE: file changed before deletion. Nothing was deleted.');
      // No await between the final policy/version check and unlink. Other OS writers can still race.
      if (stamp(lstatSync(fresh.current.absolute, { bigint: true })) !== fresh.stamp) fail('STALE: file changed before deletion.');
      (faults.unlink ?? unlinkSync)(fresh.current.absolute);
      return `deleted ${path.canonical} (was ${before.hash ? `file=${before.hash}` : `version=${before.token}`})`;
    });
  });
}
