// The path rules a task's brain works under (LINK decision 11): whether a path may be read or
// written in a session, for Claude's PreToolUse hook and roots, Pi's file policy, and the studio's
// own file tools. The task worktree is the brain's own; an engine root, a linked engine/<repo> the
// project's main checkout declares, is readable and never writable; anything else is left to each
// caller's own rule, as before engine links. The main checkout, not the task worktree, says which
// repos are engines, because a brain can edit its own worktree's package.json. verdict does not
// check hard links: each caller keeps its own refusal of a write to a file with nlink > 1, as
// Claude's hook has today and the studio's file tools add for themselves.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { declaredEngineRepos, keptTarget, REPO_ID } from './engine-roots.ts';

/** A linked engine/<repo> in a task worktree: the link itself and the real folder it leads to. */
export interface EngineRoot {
  readonly repo: string;
  readonly link: string;
  readonly real: string;
}

/** What a session's paths are judged against: its task worktree and that worktree's engine roots. */
export interface PathRoots {
  readonly worktree: string;
  readonly engines: readonly EngineRoot[];
}

/**
 * Who is asking. An implementer is a work session on a task that is no backlog item to plan (the
 * test Pi's launch uses); every other session reads only.
 */
export type PathRole = 'implementer' | 'reader';

/**
 * The answer for one path:
 * - allow: in the task worktree, and this access is allowed there.
 * - read-only: in an engine root. A read is allowed; a write is refused with `reason`.
 * - refused: a dot folder (`.git` among them) inside an engine root, for reads and writes alike.
 * - outside: anything else, a write the worktree doesn't allow included; each caller keeps its own rule.
 */
export type PathVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'read-only'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'outside' };

/** Why a write into an engine root is refused, in the words the brain sees. */
export const ENGINE_READ_ONLY = 'engine repos are read-only to tasks';

// Whether one name of a path is a Windows device name. Claude's hook, Pi's policy and the studio's
// file tools all refuse such a path, each in its own words; the rule itself is shared with the office.
export { isDeviceName } from './device-names.ts';

/**
 * The main checkout of the project `worktree` belongs to: the parent of its git common folder,
 * real-pathed. Read from the worktree's .git pointer and its commondir, as Pi's project-worktree
 * lookup does, so no git process runs. A main checkout gives itself. Null when the worktree's git
 * folder can't be read, so the caller has no engine roots.
 */
export function mainCheckoutOf(worktree: string): string | null {
  try {
    const marker = join(worktree, '.git');
    let gitDir = marker;
    if (!statSync(marker).isDirectory()) {
      const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, 'utf8'));
      if (pointer === null) return null;
      gitDir = resolve(worktree, pointer[1]!.trimEnd());
    }
    const commondir = join(gitDir, 'commondir');
    let common = gitDir;
    try {
      common = resolve(gitDir, readFileSync(commondir, 'utf8').trimEnd());
    } catch (error) {
      // A main checkout's own .git folder has no commondir: it is the common folder.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    return dirname(realpathSync.native(common));
  } catch {
    return null;
  }
}

/**
 * The engine roots of `worktree`: each engine/<repo> directly under it, for a repo `mainCheckout`'s
 * package.json declares, that is a link the link module would keep (keptTarget: a relative link to
 * the repo's own folder in the repos folder, or to a worktree in that repo's own list). A link to
 * the repo's own folder needs no git; a paired link's membership needs the repo's worktree list,
 * so when git fails or times out there the paired link is no root, and paths through it are
 * outside, as for any other link. Junctions, absolute links, links to undeclared repos, a declared
 * name that is the main checkout's own folder name, and links elsewhere are no roots. An
 * unreadable declaration, or an engine that is itself a link, gives none.
 */
export function engineRoots(worktree: string, mainCheckout: string): EngineRoot[] {
  let repos: string[];
  try {
    repos = declaredEngineRepos(mainCheckout);
  } catch {
    return [];
  }
  const engine = join(worktree, 'engine');
  try {
    // engine/<repo> must be directly under the worktree: through a linked engine it would be somewhere else.
    const folder = lstatSync(engine);
    if (folder.isSymbolicLink() || !folder.isDirectory()) return [];
  } catch {
    return [];
  }
  const reposFolder = dirname(mainCheckout);
  // As the link module refuses it, an engine never names the project's own folder (decision 1).
  const own = basename(mainCheckout).toLowerCase();
  return repos.filter((repo) => REPO_ID.test(repo) && repo !== own).flatMap((repo): EngineRoot[] => {
    const link = join(engine, repo);
    const real = keptTarget(link, join(reposFolder, repo));
    return real === null ? [] : [{ repo, link, real }];
  });
}

/**
 * The verdict for a `access` of `path` (relative to the worktree, or absolute) by `role`, judged on
 * the path's real path: its nearest existing folder followed through every link, then the rest as
 * written; a path through a dangling link is outside. So a path through engine/<repo> and the same file by its absolute path in the linked repo
 * get one verdict, and a nested link inside an engine root is judged by where it really leads. In an
 * engine root, a dot folder below the root's real path is refused (never one above it: a paired
 * worktree's real path is under the engine repo's own .claude/worktrees); dot files and node_modules
 * there stay readable. In the worktree, reads are allowed, and writes for an implementer outside .git.
 */
export function verdict(path: string, roots: PathRoots, role: PathRole, access: 'read' | 'write'): PathVerdict {
  const real = realPathOf(resolve(roots.worktree, path));
  if (real === null) return { kind: 'outside' };
  // The deepest engine root holding the path, in case one root's real path holds another's.
  const engine = roots.engines
    .filter((root) => below(root.real, real) !== null)
    .sort((a, b) => b.real.length - a.real.length)[0];
  if (engine !== undefined) {
    const parts = below(engine.real, real)!;
    const last = parts.length - 1;
    const dotFolder = parts.find((part, index) => part.startsWith('.') && (index < last || part.toLowerCase() === '.git' || isFolder(real)));
    if (dotFolder !== undefined) return { kind: 'refused', reason: `${dotFolder} is a dot folder inside engine/${engine.repo}, which tasks neither read nor write` };
    return { kind: 'read-only', reason: ENGINE_READ_ONLY };
  }
  const worktree = realOrNull(roots.worktree);
  const inside = worktree === null ? null : below(worktree, real);
  if (inside === null) return { kind: 'outside' };
  if (access === 'read') return { kind: 'allow' };
  const writable = role === 'implementer' && inside.length > 0 && !inside.some((part) => part.toLowerCase() === '.git');
  return writable ? { kind: 'allow' } : { kind: 'outside' };
}

/** The segments of `path` below the folder `root` (none for the folder itself), or null when `path` isn't in it. */
function below(root: string, path: string): string[] | null {
  // On Windows relative() matches folders whatever their case, as Windows does, and keeps the path's own spelling.
  const between = relative(root, path);
  if (between === '') return [];
  if (between === '..' || between.startsWith(`..${sep}`) || isAbsolute(between)) return null;
  return between.split(sep);
}

/** Where the absolute `path` really leads: its nearest existing folder followed to where it is, and the rest as written; null through a dangling link. */
export function realPathOf(path: string): string | null {
  let absolute = path;
  const rest: string[] = [];
  for (;;) {
    const found = realOrNull(absolute);
    if (found !== null) return rest.length === 0 ? found : join(found, ...rest.reverse());
    // A dangling link leads wherever its target is made, so the path's real place is unknown.
    if (isLink(absolute)) return null;
    const parent = dirname(absolute);
    if (parent === absolute) return null;
    rest.push(basename(absolute));
    absolute = parent;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
