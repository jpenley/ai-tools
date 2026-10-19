// The studio's file finder, `find_files` (FILES-find, studio-files.md): the files of the task worktree
// and its engine links whose canonical path matches a pattern (patterns.ts), one per line, sorted
// ordinally, paged at 200 with `next: offset=K`. Every reading role has it, by the same name in every
// harness.
//
// The worktree is listed by its git, on the git folder the studio pinned for the session (GitPlace)
// with git.ts's hardened invocation; each engine link by its own repo's git at its real path, with
// consultation-source.ts's hardening and none of the environment's GIT_* settings, so no inherited
// GIT_DIR points it at another repo. Ignored files are skipped unless `include_ignored`. A listing
// reveals names, so it never shows one the path layer (files.ts) would refuse to read: `.git`,
// credential names, `.secrets` and `.ssh` folders, the writer's `*.ff-tmp` files, files reached
// through a link, and inside an engine link anything in a dot folder (an engine repo's main checkout
// holds other sessions' worktrees under .claude/worktrees). A link git lists is shown as a link and
// never followed. git gets 30 s a call; then the call is refused.
//
// A folder the studio wrote for the session outside the worktree (FILES-readable) is no git
// repository, so it is listed only when `path` names it, by walking it: every file in it, since
// nothing there is ignored, under the same hiding rules, with links shown and never entered. Its
// paths print absolute, and the pattern names that whole absolute path, as it names the whole path
// from the worktree elsewhere.
import { lstatSync, realpathSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { GatewayTool, ToolReply } from '../contract.ts';
import type { EngineRoot } from '../policy/path-rules.ts';
import { isCredentialFileName } from '../policy/sensitive-paths.ts';
import type { BuiltInTool } from '../contract.ts';
import { flagArgument, offsetArgument } from '../shared/arguments.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';
import { CONTROL, startCall, type FileSession } from './files.ts';
import { gitArguments, runGit, type GitPlace, type GitRun } from '../git/git.ts';
import { compareFuzzy, compileFuzzyQuery, type FuzzyRank } from './fuzzy-files.ts';
import { excludeProperty, pathExclusions } from './path-exclusions.ts';
import { compilePattern } from './patterns.ts';

const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** The most paths one reply lists. */
export const FIND_PAGE = 200;
/** How long each git listing may run (FILES Implementation Decision 10). */
export const FIND_TIMEOUT_MS = 30_000;
/** How many listed entries are checked before the studio's thread is let go for a turn. */
const ENTRIES_PER_TURN = 500;
/** The most entries a walk of a readable folder lists: far past a skills folder or a long change. */
export const MAX_WALKED = 100_000;

/** The file finder as the gateway offers it. */
export const FIND_FILES_TOOL: GatewayTool = {
  name: 'find_files',
  description:
    'mode:glob (default) uses path globs; mode:fuzzy finds case-insensitive ordered subsequences, ranking basename matches before path-only matches, without spelling correction. exclude removes whole canonical paths matching up to 16 glob patterns. ' +
    'Find files in your task worktree and under engine/<repo> (read-only) whose path matches a pattern. ' +
    'The pattern is matched against the whole path from the worktree, ignoring case: * and ? stop at /, ** crosses it, so *.ts is top-level files only, src/*.ts the files directly in src, ' +
    '**/*.ts every depth and engine/world/**/*.ts only that engine repo\'s; [abc] is a class and {ts,tsx} alternatives. path only narrows where to look; the pattern still names the whole path. ' +
    'One path per line, sorted; "[link] <path>" for a link, which is never followed. Ignored files are skipped unless include_ignored: true; .git and credential files never appear. ' +
    'A name holding a control character shows it as ?; view_file can\'t open such a file. ' +
    `A reply lists at most ${FIND_PAGE} paths; when there are more, its last line is "next: offset=K": send the same call with that offset to see the rest. ` +
    'A folder the studio wrote for this session outside the worktree, such as a skill\'s folder, is looked in only when path gives its absolute path; the pattern then names whole absolute paths, so start it with **/.',
  inputSchema: {
    type: 'object',
    properties: {
      full: fullOutputProperty,
      mode: { type: 'string', enum: ['glob', 'fuzzy'], default: 'glob', description: 'glob (default) matches the whole path with glob syntax. fuzzy matches query characters in order, allowing gaps, with basename matches first; it does not correct spelling. Ties use ordinal path order.' },
      exclude: excludeProperty,
      pattern: { type: 'string', minLength: 1, maxLength: 512, description: 'In fuzzy mode, literal query characters in order with gaps, such as srchfl. In glob mode, the pattern for the whole path from the worktree, such as **/*.ts, src/*.ts or engine/world/**/*.md.' },
      path: { type: 'string', description: 'The folder to look in, relative to your worktree, such as src or engine/world; the worktree and its engine repos by default.' },
      include_ignored: { type: 'boolean', description: 'Also find files git ignores (node_modules, build output); false by default.' },
      offset: { type: 'integer', minimum: 0, description: 'How many paths to skip, from a previous reply\'s "next: offset=K"; 0 by default.' },
    },
    required: ['pattern'],
  },
};

export interface FindOptions {
  /** How long each git listing may run; 30 s by default. */
  readonly timeoutMs?: number;
  /** The most entries a walk of a readable folder lists; MAX_WALKED by default. */
  readonly maxWalked?: number | undefined;
}

/** How listRoot bounds a listing beyond the time it is given, and how a walk lets the thread go. */
export interface ListOptions {
  /** The limit a refusal names, when the time given is what is left of a longer one; that time by default. */
  readonly limitMs?: number | undefined;
  /** The most entries a walk of a readable folder lists; MAX_WALKED by default. */
  readonly maxWalked?: number | undefined;
  /** Lets the studio's thread go for a turn during a walk; the next setImmediate by default, and tests count the turns. */
  readonly turn?: (() => Promise<unknown>) | undefined;
  /** Permission filtering before an external directory walk enters a child. */
  readonly canRead?: ((absolute: string) => boolean) | undefined;
}

/** `options` with its defaults filled in, for a listing given `timeoutMs`. */
export function listLimits(timeoutMs: number, options: ListOptions = {}): { readonly limitMs: number; readonly maxWalked: number; readonly turn: () => Promise<unknown> } {
  return { limitMs: options.limitMs ?? timeoutMs, maxWalked: options.maxWalked ?? MAX_WALKED, turn: options.turn ?? nextTurn };
}

/** One root to list: the worktree, an engine link or a readable folder, narrowed to `below` (a path inside it, or none). */
export interface ListedRoot {
  readonly engine: EngineRoot | null;
  /** Where its files are on disk: the worktree's real path, the engine link's real target, or the readable folder's real path. */
  readonly real: string;
  readonly below: string | null;
  /** For a readable folder, its canonical form (FILES-readable), which its paths print under; absent for a git root. */
  readonly readable?: string;
}

/** Why a listing stopped, or the names it gave. */
export type Listed = { readonly ok: true; readonly names: readonly string[] } | { readonly ok: false; readonly reason: string };

/** The file finder for one session: its worktree, project and role, and the git place the studio pinned for it. */
export function findFilesTool(session: FileSession, place: GitPlace, options: FindOptions = {}): BuiltInTool {
  const timeoutMs = options.timeoutMs ?? FIND_TIMEOUT_MS;
  return {
    tool: FIND_FILES_TOOL,
    async call(input): Promise<ToolReply> {
      const full = fullOutputArgument(input['full']);
      if (full === null) return answer(false, 'full must be true or false.');
      const mode = input['mode'] === undefined ? 'glob' : input['mode'];
      if (mode !== 'glob' && mode !== 'fuzzy') return answer(false, 'mode must be glob or fuzzy.');
      const pattern = mode === 'fuzzy' ? compileFuzzyQuery(input['pattern']) : compilePattern(input['pattern']);
      if (!pattern.ok) return answer(false, pattern.reason);
      const exclusions = pathExclusions(input['exclude']);
      if (!exclusions.ok) return answer(false, exclusions.reason);
      const includeIgnored = flagArgument(input['include_ignored']);
      if (includeIgnored === null) return answer(false, 'include_ignored must be true or false.');
      const offset = offsetArgument(input['offset']);
      if (offset === null) return answer(false, 'offset must be a whole number from 0.');
      const call = startCall(session);
      const folder = call.judge(input['path'] ?? '.', 'read');
      if (!folder.ok) return answer(false, folder.reason);
      if (folder.kind === 'missing') return answer(false, `${folder.canonical} not found.`);
      if (folder.kind === 'file') return answer(false, `${folder.canonical} is a file, not a folder; find_files looks in folders.`);

      let worktreeReal: string;
      try {
        worktreeReal = realpathSync.native(session.worktree);
      } catch {
        return answer(false, 'The task worktree could not be found.');
      }
      const roots: ListedRoot[] = [];
      if (folder.readable !== undefined) {
        roots.push(readableRoot(folder.readable, folder.canonical));
      } else if (folder.engine === null) {
        roots.push({ engine: null, real: worktreeReal, below: folder.canonical === '.' ? null : folder.canonical });
        // The engine links sit in engine/, so a look from the worktree itself or from engine/ takes them in.
        if (folder.canonical === '.' || folder.canonical.toLowerCase() === 'engine') {
          for (const engine of call.roots.engines) roots.push({ engine, real: engine.real, below: null });
        }
      } else {
        const engine = call.roots.engines.find((candidate) => candidate.repo === folder.engine)!;
        const prefix = `engine/${engine.repo}`;
        roots.push({ engine, real: engine.real, below: folder.canonical === prefix ? null : folder.canonical.slice(prefix.length + 1) });
      }

      const found = new Map<string, string>();
      const ranks = new Map<string, FuzzyRank>();
      const bounded = mode === 'fuzzy' || exclusions.active;
      const deadline = Date.now() + timeoutMs;
      let examined = 0, retained = 0;
      for (const root of roots) {
        const left = bounded ? deadline - Date.now() : timeoutMs;
        if (left <= 0) return answer(false, 'Filename search timed out; narrow the path.');
        const listed = await listRoot(root, place, includeIgnored, left, { maxWalked: options.maxWalked, canRead: path => call.judge(path, 'read').ok });
        if (!listed.ok) return answer(false, listed.reason);
        const folders = new Map<string, boolean>();
        let checked = 0;
        for (const name of listed.names) {
          // One lstat an entry, and a listing with ignored files can hold every file of node_modules:
          // the studio's other sessions get the thread between batches.
          checked += 1;
          examined += 1;
          if (bounded && (examined > MAX_WALKED || Date.now() >= deadline)) return answer(false, 'Filename search exceeded its entry/time budget; narrow the path.');
          if (checked % ENTRIES_PER_TURN === 0) await nextTurn();
          const parts = name.split('/');
          if (root.engine === null && root.readable === undefined && isEngineEntry(parts, call.roots.engines)) continue;
          if (hidden(parts, root.engine !== null)) continue;
          const canonical = root.readable !== undefined ? `${root.readable.replace(/\/$/, '')}/${name}` : root.engine === null ? name : `engine/${root.engine.repo}/${name}`;
          if (!call.judge(join(root.real, ...parts), 'read').ok) continue;
          if (found.has(canonical) || exclusions.matches(canonical)) continue;
          const rank = 'rank' in pattern ? pattern.rank(canonical) : null;
          if ('matches' in pattern ? !pattern.matches(canonical) : rank === null) continue;
          const line = lineFor(root.real, parts, canonical, folders);
          if (line !== null) {
            retained += Buffer.byteLength(canonical);
            if (bounded && retained > 16 * 1024 * 1024) return answer(false, 'Filename results exceed 16 MiB; narrow the path or query.');
            found.set(canonical, line);
            if (rank !== null) ranks.set(canonical, rank);
          }
        }
        // Past its work budget the pattern matches nothing more, so the list would be short.
        if (pattern.exhausted()) return answer(false, `${pattern.pattern} is too costly to match against this many files; narrow the pattern or the path.`);
      }
      if (exclusions.exhausted()) return answer(false, 'exclude is too costly; narrow the path or use simpler exclusions.');
      const sorted = [...found.keys()].sort((a, b) => (mode === 'fuzzy' ? compareFuzzy(ranks.get(a)!, ranks.get(b)!) : 0) || ordinal(a, b)).map((canonical) => found.get(canonical)!);
      return answer(true, pageOf(sorted, offset, pattern.pattern, folder.canonical, includeIgnored, full));
    },
  };
}

/**
 * Lists one root's files with its git: the worktree on the session's place, an engine link with its
 * own repo's git. search_files selects by this listing too, so both tools take the same files.
 * `options` holds the limit a refusal names and a walk's cap and turn, defaulted by listLimits.
 */
export function listRoot(root: ListedRoot, place: GitPlace, includeIgnored: boolean, timeoutMs: number, options: ListOptions = {}): Promise<Listed> {
  const { limitMs, maxWalked, turn } = listLimits(timeoutMs, options);
  if (root.readable !== undefined) return walkListing(root, timeoutMs, limitMs, maxWalked, turn, options.canRead);
  // Without --exclude-standard, --others lists the ignored files too.
  return gitListing(root, place, ['-z', '--cached', '--others', ...(includeIgnored ? [] : ['--exclude-standard']), '--'], timeoutMs, limitMs);
}

/**
 * The folders of a root that git ignores whole and that hold no tracked file, each as `name/`, or
 * null when git couldn't say. Nothing in them is in listRoot's listing without include_ignored, so
 * search_files has rg skip them rather than read all of node_modules to throw it away.
 */
export async function listIgnoredFolders(root: ListedRoot, place: GitPlace, timeoutMs: number): Promise<readonly string[] | null> {
  // A readable folder has no git, so nothing in it is ignored.
  if (root.readable !== undefined) return [];
  // --directory names a wholly ignored, untracked folder once instead of every file in it; a folder
  // holding a tracked file is entered, and its ignored files are named one by one.
  const listed = await gitListing(root, place, ['-z', '--others', '--ignored', '--exclude-standard', '--directory', '--'], timeoutMs, timeoutMs);
  return listed.ok ? listed.names.filter((name) => name.endsWith('/')) : null;
}

/** Runs `git ls-files <listing> [narrowing]` for one root, on the session's place or the engine repo's own git. */
async function gitListing(root: ListedRoot, place: GitPlace, listing: readonly string[], timeoutMs: number, limitMs: number): Promise<Listed> {
  // literal: a folder's name is never read as a pathspec pattern.
  const narrowed = root.below === null ? [] : [`:(top,literal)${root.below}`];
  let ran: GitRun;
  if (root.engine === null) {
    ran = await runGit(gitArguments(place, ['ls-files', ...listing, ...narrowed]), place.worktree, timeoutMs);
  } else {
    const real = root.real;
    // As consultationGit checks: the engine repo's .git must be its own folder or worktree file, not
    // a link that hands git another repository.
    if (!isGitEntry(join(real, '.git'))) return { ok: false, reason: `engine/${root.engine.repo} could not be listed: its .git is not a git folder or file.` };
    ran = await runGit([
      '--no-pager', '--no-replace-objects', '--work-tree', real,
      '-c', `safe.directory=${real.replaceAll('\\', '/')}`,
      '-c', 'core.fsmonitor=false',
      '-c', `core.hooksPath=${place.hooksPath}`,
      '-c', 'core.quotePath=false',
      // Dot folders are never entered inside an engine link; the filter below holds that anyway.
      'ls-files', ...listing, ':(exclude,glob)**/.*/**', ...narrowed,
    ], real, timeoutMs, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_NO_LAZY_FETCH: '1',
      // git finds the engine repo at its own folder and never looks above it.
      GIT_CEILING_DIRECTORIES: dirname(real),
    });
  }
  const where = root.engine === null ? (root.below ?? 'the task worktree') : `engine/${root.engine.repo}`;
  if (ran.timedOut) return { ok: false, reason: `search stopped after ${Math.ceil(limitMs / 1000)} s; narrow the path` };
  if (ran.overflowed) return { ok: false, reason: `the listing of ${where} is over 16 MB; narrow the path.` };
  if (ran.code !== 0) {
    const why = (ran.stderr.trim().split('\n')[0] ?? '').slice(0, 300) || 'it gave no reason.';
    return { ok: false, reason: `${where} could not be listed: git ls-files failed (exit code ${ran.code ?? 'none'}): ${why}` };
  }
  return { ok: true, names: ran.stdout.split('\0').filter((name) => name !== '') };
}

/** The root for a readable folder `prefix` (its canonical form), narrowed to `canonical` when that is below it. */
export function readableRoot(prefix: string, canonical: string): ListedRoot {
  return { engine: null, real: prefix, below: canonical === prefix ? null : canonical.slice(prefix.length + 1), readable: prefix };
}

/**
 * Lists a readable folder's files by walking it, as git ls-files would print them: relative to the
 * root, with `/`. A link is listed by its own name and never entered, so lineFor shows it as a link;
 * .git is never entered. Refused past `maxWalked` entries or the deadline. It lets the studio's thread
 * go every ENTRIES_PER_TURN entries, as find_files' check of a git listing does.
 */
async function walkListing(root: ListedRoot, timeoutMs: number, limitMs: number, maxWalked: number, turn: () => Promise<unknown>, canRead?: (absolute: string) => boolean): Promise<Listed> {
  const deadline = Date.now() + timeoutMs;
  const stopped: Listed = { ok: false, reason: `search stopped after ${Math.ceil(limitMs / 1000)} s; narrow the path` };
  const names: string[] = [];
  const folders = [root.below ?? ''];
  const where = root.below === null ? root.readable! : `${root.readable!}/${root.below}`;
  // search_files narrows to one file: that file is the whole listing.
  if (root.below !== null && !isRealFolder(join(root.real, root.below))) return { ok: true, names: [root.below] };
  let walked = 0;
  while (folders.length > 0) {
    if (Date.now() > deadline) return stopped;
    const folder = folders.pop()!;
    try {
      // Read a batch at a time, so one large folder never holds the thread; leaving the loop closes it.
      for await (const entry of await opendir(join(root.real, folder))) {
        // A large folder can outlast the deadline on its own, so it is checked at every entry.
        if (Date.now() > deadline) return stopped;
        walked += 1;
        if (walked > maxWalked) return { ok: false, reason: `${where} holds more than ${maxWalked.toLocaleString('en-US')} entries; narrow the path.` };
        if (walked % ENTRIES_PER_TURN === 0) await turn();
        const name = folder === '' ? entry.name : `${folder}/${entry.name}`;
        if (canRead !== undefined && !canRead(join(root.real, name))) continue;
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() !== '.git') folders.push(name);
        } else {
          names.push(name);
        }
        if (names.length + folders.length > maxWalked) return { ok: false, reason: `${where} holds more than ${maxWalked.toLocaleString('en-US')} entries; narrow the path.` };
      }
    } catch (error) {
      return { ok: false, reason: `${where} could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).` };
    }
  }
  return { ok: true, names };
}

/** Whether a worktree entry is an engine link or inside one: each engine link is listed as its own root. */
function isEngineEntry(parts: readonly string[], engines: readonly EngineRoot[]): boolean {
  return parts.length >= 2 && parts[0]!.toLowerCase() === 'engine' && engines.some((engine) => engine.repo.toLowerCase() === parts[1]!.toLowerCase());
}

/** Whether an entry's name is one the path layer refuses to read, so the listing never shows it. */
function hidden(parts: readonly string[], inEngine: boolean): boolean {
  const last = parts.at(-1)!;
  // A nested repository git lists as a folder (name/); find_files lists files.
  if (last === '') return true;
  if (parts.some((part) => ['.git', '.secrets', '.ssh'].includes(part.toLowerCase()))) return true;
  if (isCredentialFileName(last) || last.toLowerCase().endsWith('.ff-tmp')) return true;
  return inEngine && parts.slice(0, -1).some((part) => part.startsWith('.'));
}

/**
 * How an entry prints, checked on disk: null when it is gone (a tracked file deleted), a folder (a
 * submodule), or reached through a link or junction, which the path layer follows only as
 * engine/<repo>. `folders` remembers which folders were checked during this root's listing.
 */
function lineFor(rootReal: string, parts: readonly string[], canonical: string, folders: Map<string, boolean>): string | null {
  let folder = rootReal;
  for (const part of parts.slice(0, -1)) {
    folder = join(folder, part);
    let real = folders.get(folder);
    if (real === undefined) {
      real = isRealFolder(folder);
      folders.set(folder, real);
    }
    if (!real) return null;
  }
  let stats;
  try {
    stats = lstatSync(join(folder, parts.at(-1)!));
  } catch {
    return null;
  }
  // A name holding a control character could print as another name, so it shows with ? in its
  // place, as list_dir shows it; the path layer refuses it as an argument anyway.
  const shown = canonical.replace(CONTROL_ALL, '?');
  if (stats.isSymbolicLink()) return `[link] ${shown}`;
  return stats.isFile() ? shown : null;
}

/** Whether `path` is a real folder or file, not a link or anything else. */
function isGitEntry(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && (stats.isDirectory() || stats.isFile());
  } catch {
    return false;
  }
}

function isRealFolder(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The page of `lines` from `offset`, with `next: offset=K` when more follow. */
function pageOf(lines: readonly string[], offset: number, pattern: string, where: string, includeIgnored: boolean, full: boolean): string {
  const place = where === '.' ? '' : ` in ${where}`;
  if (lines.length === 0) return `No file matches ${pattern}${place}${includeIgnored ? '' : ' (ignored files are skipped; include_ignored: true finds them)'}.`;
  if (offset >= lines.length) return `${lines.length} files match ${pattern}${place}; nothing from offset=${offset}.`;
  const next = full ? lines.length : offset + FIND_PAGE;
  const page = lines.slice(offset, next);
  if (next < lines.length) page.push(`next: offset=${next}`);
  return page.join('\n');
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}
