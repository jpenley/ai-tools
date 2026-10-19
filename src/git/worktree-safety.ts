import { lstatSync, opendirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function linkedRootProblem(root: string): string | null {
  if (root.replaceAll('\\', '/').split('/').includes('..')) return 'Full-access roots must not contain parent traversal; select an explicit non-linked root.';
  try {
    for (let path = resolve(root); ; path = dirname(path)) {
      if (lstatSync(path).isSymbolicLink()) return 'Full-access roots may not traverse symlinks/junctions; select the actual non-linked repository root.';
      if (dirname(path) === path) break;
    }
    return null;
  } catch { return 'The repository root could not be checked safely for links.'; }
}

const REWRITES_WORKTREE = new Set(['mv', 'reset', 'restore', 'revert', 'rm', 'stash', 'clean', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'pull']);

/** Git has no path-policy callback. Conservatively refuse whole-worktree writes
 * when an existing link could be removed/replaced/traversed. Do not follow links,
 * including ignored ones; a new tracked tree could otherwise write through them.
 * Reads, staging and ordinary commits remain available. Owner helpers are trusted.
 */
export function worktreeWriteProblem(root: string, subcommand: string): string | null {
  if (!REWRITES_WORKTREE.has(subcommand)) return null;
  const deadline = Date.now() + 5000;
  let visited = 0;
  const folders = [root];
  try {
    const rootProblem = linkedRootProblem(root);
    if (rootProblem !== null) return rootProblem;
    while (folders.length) {
      const directory = opendirSync(folders.pop()!);
      try {
        for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
          if (++visited > 100_000 || Date.now() > deadline) return 'Git worktree link preflight exceeded its 100,000-entry/5-second budget; no Git write was started.';
          if (entry.name.toLowerCase() === '.git') continue;
          const path = join(directory.path, entry.name);
          const stats = lstatSync(path);
          if (stats.isSymbolicLink()) return 'Git worktree-changing commands are refused while the worktree contains symlinks/junctions (including ignored links). Links are unconditionally read-only. Use an owner-managed link-free checkout; reads/staging/ordinary commits remain available.';
          if (stats.isDirectory()) folders.push(path);
        }
      } finally { directory.closeSync(); }
    }
    return null;
  } catch { return 'Git worktree link preflight could not safely inspect the tree; no Git write was started.'; }
}
