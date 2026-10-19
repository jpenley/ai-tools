import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileSession } from './files.ts';
import { boolProperty, checked, fail, flag, locked, MAX_ENTRIES, pathProperty, tool } from './core/filesystem.ts';

export function makeDirectoryTool(session: FileSession) {
  return tool('make_directory', 'Create an empty repository directory. parents:true explicitly allows creation of missing parent directories. Existing directories are a no-op; files, links, protected paths and external writes are refused. Partial parent creation is reported if an OS operation fails.', {
    path: pathProperty, parents: boolProperty,
  }, ['path'], async input => {
    const parents = flag(input['parents'], 'parents');
    const path = checked(session, input['path'], 'write');
    if (path.kind === 'folder') return { path: path.canonical, created: false };
    if (path.kind !== 'missing') fail('Path exists and is not a directory.');
    const missing = [path.absolute];
    let parent = checked(session, dirname(path.absolute), 'read');
    while (parent.kind === 'missing') {
      if (!parents) fail('Parent does not exist; explicitly use parents:true.');
      checked(session, parent.absolute, 'write');
      missing.push(parent.absolute);
      if (missing.length > MAX_ENTRIES) fail('Too many missing parent directories.');
      parent = checked(session, dirname(parent.absolute), 'read');
    }
    if (parent.kind !== 'folder') fail('An ancestor is not a directory.');
    return locked(missing, () => {
      let created = 0;
      try {
        for (const absolute of [...missing].reverse()) {
          const target = checked(session, absolute, 'write');
          if (target.kind !== 'missing') fail('A target appeared while waiting for locks; inspect and retry.');
          if (checked(session, dirname(target.absolute), 'read').kind !== 'folder') fail('Parent changed.');
          mkdirSync(target.absolute); created++;
        }
      } catch (error) {
        fail(`Directory creation failed after ${created} directories were created (${(error as NodeJS.ErrnoException).code ?? 'path changed'}). Inspect before retrying.`);
      }
      return { path: path.canonical, created: true, created_directories: created };
    });
  });
}
