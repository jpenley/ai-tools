// The studio's content search, `search_files` (FILES-find, studio-files.md): the lines of the task
// worktree's and its engine links' files that match a regular expression, each printed with the
// anchor view_file shows for it, so a brain can edit straight from a search. Every reading role has
// it, by the same name in every harness, when the studio found ripgrep at start (FILES-rg).
//
// ripgrep searches; the studio decides what is shown. rg runs once per root (the worktree, then each
// engine link at its real path), by the absolute path found at studio start, with no shell, none of
// the environment's ripgrep settings, no config file and no ignore file, never following a link (no
// --follow). A match is kept only in a file find_files' git listing holds (find-files.ts, on the
// session's pinned git place or the engine repo's own git, with ignored files when they are asked
// for), so both tools select the same files: rg's own reading of .gitignore would skip a tracked
// file the rules name, and rg would enter an untracked nested repository git lists only as a folder. The
// brain's pattern reaches it only after --regexp and its path only after --, and its glob only as an
// anchored --iglob prefilter, when ignored files are asked for and the glob is plain enough that
// rg's glob rules read it as the studio's matcher does. rg prints only each match's path and line
// number, never the line, so its output stays small whatever the files hold: every path
// is judged by the path layer (files.ts) against the roots worked out at the call's start, as
// view_file would judge it, and checked against the glob with the file tools' matcher (patterns.ts),
// so .git, credential names, dot folders in an engine link and anything reached through a link never
// appear, whatever rg read. The text and anchors shown come from the studio's own reader, as
// view_file's do, never from rg, so they are equal by construction (FILES Implementation Decision 6).
// A call gathers at most 10,000 matches and may run 30 s; then it is refused rather than stall.
// A folder the studio wrote for the session outside the worktree (FILES-readable) is searched only
// when `path` names it, selected by find_files' walk of it, as a git root is by its listing.
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { GatewayTool, ToolReply } from '../contract.ts';
import type { EngineRoot } from '../policy/path-rules.ts';
import { isCredentialFileName } from '../policy/sensitive-paths.ts';
import type { BuiltInTool } from '../contract.ts';
import { flagArgument, offsetArgument } from '../shared/arguments.ts';
import { anchorOf, CONTROL, readText, startCall, type AllowedPath, type FileCall, type FileSession } from './files.ts';
import { listIgnoredFolders, listRoot, readableRoot } from './find-files.ts';
import type { GitPlace } from '../git/git.ts';
import { compilePattern, type CompiledPattern } from './patterns.ts';
import { contextSearchReply } from './search-context.ts';
import { excludeProperty, pathExclusions, type PathExclusions } from './path-exclusions.ts';
import { parseSearchQuery, type SearchQuery } from './search-query.ts';
import { programPath } from '../program-path.ts';
import { cut, VIEW_MAX_BYTES } from './view-file.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';

const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** The most matches one reply shows. */
export const SEARCH_PAGE = 200;
/** The most matches one call gathers before it is refused (FILES-find). */
export const MAX_MATCHES = 10_000;
/**
 * The most of rg's records one call handles, kept or not: matches in files the path layer refuses or
 * the glob rejects don't count toward MAX_MATCHES, and without this a huge refused file would keep
 * the studio's thread busy until rg finished.
 */
export const MAX_RECORDS = 200_000;
/** How long one call's searches may run in all (FILES Implementation Decision 10). */
export const SEARCH_TIMEOUT_MS = 30_000;
/** The most of rg's error output kept. */
const MAX_STDERR = 64 * 1024;
/** The most bytes of one record of rg's output kept: a path and a line number, far past any real path. */
const MAX_RECORD = 64 * 1024;
/** The most file bytes one reply reads; past it no new file is started and the reply says where to go on. */
export const SEARCH_MAX_READ = 32 * 1024 * 1024;
/** The most unreadable files a reply names. */
const MAX_UNREADABLE = 20;
/** The most bytes of ignored folders passed to rg to skip, well inside Windows' 32 K command line. */
const MAX_SKIPPED_BYTES = 8 * 1024;

/** The content search as the gateway offers it. */
export const SEARCH_FILES_TOOL: GatewayTool = {
  name: 'search_files',
  description:
    'Provide exactly one of pattern (regex by default; literal:true selects fixed strings) or patterns (OR of single-line literals). context:0-20 adds anchored surrounding lines with a context prefix; only matching lines advance offset. exclude removes whole canonical paths before searching. ' +
    'Search the text of files in your task worktree and under engine/<repo> (read-only) for lines matching a regular expression (ripgrep\'s syntax). ' +
    'Each file with matches is printed as its path, then one line per match as N:hhhhhh|text, the same anchor view_file shows, so you can edit from it; ' +
    'a line longer than 2000 characters is cut, its anchor still covering the whole line (change such a line with edit_file\'s replace_text). ' +
    'glob narrows the files by their whole path from the worktree, ignoring case, as find_files\' pattern does: * stops at /, so *.ts is top-level files only, and **/*.ts is every depth. ' +
    'path only narrows where to look. Ignored files are skipped unless include_ignored: true; .git and credential files are never searched. ' +
    `A reply shows at most ${SEARCH_PAGE} matches; when there are more, its last line is "next: offset=K": send the same call with that offset to see the rest. ` +
    `More than ${MAX_MATCHES} matches in all is refused: narrow the pattern or path. ` +
    'A folder the studio wrote for this session outside the worktree, such as a skill\'s folder or a long change\'s, is searched only when path gives its absolute path.',
  inputSchema: {
    type: 'object',
    properties: {
      full: fullOutputProperty,
      exclude: excludeProperty,
      context: { type: 'integer', minimum: 0, maximum: 20, default: 0, description: 'Lines before and after each match (0-20); 0 by default. Overlapping windows merge. Context records have a context prefix; offset counts matches only. Oversized first windows omit context explicitly.' },
      patterns: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 2000 }, description: 'Match ANY of these single-line literal strings (OR), at most 8 KiB UTF-8 in total. Mutually exclusive with pattern; a matching line is returned once.' },
      literal: { type: 'boolean', description: 'Treat pattern as a literal string instead of a regular expression; false by default.' },
      pattern: { type: 'string', minLength: 1, maxLength: 2000, description: 'Mutually exclusive with patterns. literal:true treats this as a single-line literal; otherwise the regular expression to find in each line, such as function \\w+Tool or export const.' },
      path: { type: 'string', description: 'The folder or file to search, relative to your worktree, such as src or engine/world; the worktree and its engine repos by default.' },
      glob: { type: 'string', description: 'Only files whose whole path from the worktree matches this, such as **/*.ts or src/*.md.' },
      case_insensitive: { type: 'boolean', description: 'Ignore case in the pattern; false by default.' },
      include_ignored: { type: 'boolean', description: 'Also search files git ignores (node_modules, build output); false by default.' },
      offset: { type: 'integer', minimum: 0, description: 'How many matches to skip, from a previous reply\'s "next: offset=K"; 0 by default.' },
    },
    oneOf: [
      { required: ['pattern'], not: { required: ['patterns'] } },
      { required: ['patterns'], not: { required: ['pattern'] } },
    ],
  },
};

/** rg running, its output read and its input closed. */
export type RipgrepProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Starts rg with `args` in `cwd`; the studio's runner by default. */
export type RipgrepRunner = (args: readonly string[], cwd: string) => RipgrepProcess;

export interface SearchOptions {
  /** How long one call's searches may run in all; 30 s by default. */
  readonly timeoutMs?: number;
  /** Starts rg; tests hand in rg's output this way. */
  readonly run?: RipgrepRunner;
  /** Where the studio reports a problem, such as folders rg had to read because they could not all be skipped; none by default. */
  readonly report?: (message: string) => void;
  /** The most entries a walk of a readable folder lists; MAX_WALKED by default. */
  readonly maxWalked?: number | undefined;
}

/** One root to search: the worktree, an engine link or a readable folder, narrowed to `below` (a folder's or file's path inside it, or none). */
interface Root {
  readonly engine: EngineRoot | null;
  /** Where its files are on disk: the worktree's real path, the engine link's real target, or the readable folder's. rg runs there. */
  readonly real: string;
  readonly below: string | null;
  readonly belowIsFile: boolean;
  /** For a readable folder, its canonical form, which its paths print under; absent for a git root. */
  readonly readable?: string;
}

/** The files git lists for a root, keyed by `listedKey` of their path relative to it. */
type Listing = ReadonlySet<string>;

/** A kept match: a file the path layer allows reading, and a line number in it. */
export interface Match {
  readonly path: AllowedPath;
  readonly line: number;
}

/** What searching one root came to. */
type Searched =
  | { readonly ok: true; readonly unreadable: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * ripgrep, found once at studio start on the environment's PATH (never in a worktree), with
 * run.ts's programPath. Null when there is none, and the studio says so in one line.
 */
export function locateRipgrep(report: (line: string) => void, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const strings: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) strings[name] = value;
  // On Windows only rg.exe: a rg.cmd or rg.bat on PATH can't be started without a shell.
  const found = programPath(process.platform === 'win32' ? 'rg.exe' : 'rg', process.cwd(), strings);
  if (found === null) {
    report('ripgrep (rg) was not found on PATH: search_files is not offered to any session; the other file tools are.');
    return null;
  }
  // Once, so a broken program found at start is not offered to every session.
  const version = spawnSync(found, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (version.status !== 0 || !version.stdout.startsWith('ripgrep ')) {
    report(`ripgrep at ${found} did not run (rg --version failed): search_files is not offered to any session; the other file tools are.`);
    return null;
  }
  return found;
}

/** The content search for one session: its worktree, project and role, the git place the studio pinned for it, and ripgrep's absolute path. */
export function searchFilesTool(session: FileSession, place: GitPlace, ripgrep: string, options: SearchOptions = {}): BuiltInTool {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const run = options.run ?? ripgrepRunner(ripgrep);
  return {
    tool: SEARCH_FILES_TOOL,
    async call(input): Promise<ToolReply> {
      const full = fullOutputArgument(input['full']);
      if (full === null) return answer(false, 'full must be true or false.');
      const parsed = parseSearchQuery(input);
      if (!parsed.ok) return answer(false, parsed.reason);
      const query = parsed.query;
      const context = input['context'] === undefined ? 0 : input['context'];
      if (typeof context !== 'number' || !Number.isInteger(context) || context < 0 || context > 20) return answer(false, 'context must be an integer from 0 to 20.');
      const exclusions = pathExclusions(input['exclude']);
      if (!exclusions.ok) return answer(false, exclusions.reason);
      let glob: CompiledPattern | null = null;
      if (input['glob'] !== undefined && input['glob'] !== null) {
        const compiled = compilePattern(input['glob']);
        if (!compiled.ok) return answer(false, compiled.reason.replace(/^pattern/, 'glob'));
        glob = compiled;
      }
      const caseInsensitive = flagArgument(input['case_insensitive']);
      if (caseInsensitive === null) return answer(false, 'case_insensitive must be true or false.');
      const includeIgnored = flagArgument(input['include_ignored']);
      if (includeIgnored === null) return answer(false, 'include_ignored must be true or false.');
      const offset = offsetArgument(input['offset']);
      if (offset === null) return answer(false, 'offset must be a whole number from 0.');
      const call = startCall(session);
      const target = call.judge(input['path'] ?? '.', 'read');
      if (!target.ok) return answer(false, target.reason);
      if (target.kind === 'missing') return answer(false, `${target.canonical} not found.`);

      let worktreeReal: string;
      try {
        worktreeReal = realpathSync.native(session.worktree);
      } catch {
        return answer(false, 'The task worktree could not be found.');
      }
      const roots = rootsOf(call, target, worktreeReal);
      const deadline = Date.now() + timeoutMs;
      const matches: Match[] = [];
      const unreadable: string[] = [];
      const handled = { records: 0, seen: new Set<string>() };
      for (const root of roots) {
        const left = deadline - Date.now();
        if (left <= 0) return answer(false, `search stopped after ${Math.ceil(timeoutMs / 1000)} s; narrow the path`);
        const preauthorize = call.restricted || target.throughLink === true || exclusions.active || query.literal;
        const [listed, ignored] = await Promise.all([
          listRoot(root, place, includeIgnored, left, { limitMs: timeoutMs, maxWalked: options.maxWalked, canRead: path => call.judge(path, 'read').ok }),
          includeIgnored || preauthorize ? Promise.resolve([]) : listIgnoredFolders(root, place, left),
        ]);
        if (!listed.ok) return answer(false, listed.reason);
        const listing: Listing = new Set(listed.names.map(listedKey));
        // git lists an untracked nested repository as its folder (name/), and nothing in it: rg skips
        // those, and without include_ignored the folders git ignores whole, only to save reading them.
        const skip = skipGlobs(preauthorize ? [] : [...listed.names.filter((name) => name.endsWith('/')), ...(ignored ?? [])]);
        if (skip.left > 0) {
          options.report?.(`search_files in ${session.worktree} had rg read ${skip.left} folder${skip.left === 1 ? '' : 's'} git lists nothing in${root.engine === null ? '' : ` in engine/${root.engine.repo}`}: ${skip.why}.`);
        }
        // With overrides, rg receives only pre-authorized regular files, never a
        // directory scan that could read denied contents before post-filtering.
        const batches: string[][] = [];
        // Explicit selections need no ignored-folder globs. Bound the entire Windows command,
        // including executable, --regexp overhead and worst-case quote/backslash expansion.
        const commandLimit = process.platform === 'win32' ? 30_000 : Infinity;
        let baseArgs = preauthorize
          ? ripgrepArguments({ ...root, belowIsFile: true }, query, glob, caseInsensitive, includeIgnored, []).slice(0, -1)
          : ripgrepArguments(root, query, glob, caseInsensitive, includeIgnored, skip.globs);
        if (!preauthorize && commandSize(ripgrep, baseArgs) > commandLimit) {
          baseArgs = ripgrepArguments(root, query, glob, caseInsensitive, includeIgnored, []);
        }
        const baseSize = commandSize(ripgrep, baseArgs);
        if (baseSize > commandLimit) return answer(false, 'Search arguments exceed the process command budget; use fewer or shorter patterns.');
        if (preauthorize) {
          let batch: string[] = [], bytes = 0, command = baseSize;
          const selected = new Set<string>();
          for (const name of listed.names) {
            if (selected.has(listedKey(name))) continue;
            selected.add(listedKey(name));
            if (Date.now() >= deadline) return answer(false, `search stopped after ${Math.ceil(timeoutMs / 1000)} s; narrow the path`);
            if (selected.size % 500 === 0) await new Promise<void>(resolve => { setImmediate(resolve); });
            const allowed = call.judge(join(root.real, name), 'read');
            if (!allowed.ok || allowed.kind !== 'file') continue;
            if (exclusions.matches(allowed.canonical) || (glob !== null && !glob.matches(allowed.canonical))) continue;
            const cost = 2 * name.length + 3;
            if (baseSize + cost > commandLimit) return answer(false, 'A file path and the patterns exceed the process command budget; shorten the patterns.');
            if (batch.length > 0 && (batch.length >= 64 || bytes + Buffer.byteLength(name) + 1 > 8 * 1024 || command + cost > commandLimit)) {
              batches.push(batch); batch = []; bytes = 0; command = baseSize;
            }
            batch.push(name); bytes += Buffer.byteLength(name) + 1; command += cost;
          }
          if (batch.length > 0) batches.push(batch);
        } else batches.push([]);
        if (exclusions.exhausted()) return answer(false, 'exclude is too costly; narrow the path or use simpler exclusions.');
        if (glob?.exhausted()) return answer(false, 'glob is too costly; narrow the path or glob.');
        for (const batch of batches) {
          if (preauthorize && batch.length === 0) continue;
          const args = preauthorize ? baseArgs.concat(batch) : baseArgs;
          const searched = await searchRoot(run, args, root, call, glob, exclusions, listing, matches, handled, deadline, timeoutMs);
          if (!searched.ok) return answer(false, searched.reason);
          unreadable.push(...searched.unreadable);
        }
        // Past its work budget the glob matches nothing more, so the list would be short.
        if (glob?.exhausted() === true) return answer(false, `${glob.pattern} is too costly to match against this many files; narrow the glob or the path.`);
      }
      if (exclusions.exhausted()) return answer(false, 'exclude is too costly; narrow the path or use simpler exclusions.');
      matches.sort((a, b) => ordinal(a.path.canonical, b.path.canonical) || a.line - b.line);
      return answer(true, searchReply(matches, unreadable, offset, { regex: query.label, glob: glob?.pattern ?? null, where: target.canonical, includeIgnored }, SEARCH_MAX_READ, full, context));
    },
  };
}

/** The roots a search looks in, as find_files lists them: the worktree, and its engine links from the worktree or engine/. */
function rootsOf(call: FileCall, target: AllowedPath, worktreeReal: string): Root[] {
  const belowIsFile = target.kind === 'file';
  if (target.readable !== undefined) return [{ ...readableRoot(target.readable, target.canonical), belowIsFile }];
  if (target.engine === null) {
    const roots: Root[] = [{ engine: null, real: worktreeReal, below: target.canonical === '.' ? null : target.canonical, belowIsFile }];
    if (target.canonical === '.' || target.canonical.toLowerCase() === 'engine') {
      for (const engine of call.roots.engines) roots.push({ engine, real: engine.real, below: null, belowIsFile: false });
    }
    return roots;
  }
  const engine = call.roots.engines.find((candidate) => candidate.repo === target.engine)!;
  const prefix = `engine/${engine.repo}`;
  return [{ engine, real: engine.real, below: target.canonical === prefix ? null : target.canonical.slice(prefix.length + 1), belowIsFile }];
}

/** Safe upper bound in UTF-16 units: quoting doubles at most every character, plus quotes/space. */
function commandSize(executable: string, args: readonly string[]): number {
  return args.reduce((sum, argument) => sum + 2 * argument.length + 3, 2 * executable.length + 3);
}

/**
 * rg's arguments for one root. The brain's text appears only as the value after --regexp, after --
 * (the path, already judged), and as an --iglob value that starts with /, so none of it is ever read
 * as a flag. --hidden finds dot files; .git is skipped at any depth, and every dot folder inside an
 * engine link. rg reads no ignore file (--no-ignore, --no-ignore-dot, --no-ignore-parent), so a
 * .ignore or .rgignore the brain writes changes nothing: the studio keeps only files git lists, and
 * `skip` (skipGlobs') has rg pass by folders git lists nothing in, only to save reading them. Never
 * --follow: rg follows no link it meets.
 */
function ripgrepArguments(root: Root, query: SearchQuery, glob: CompiledPattern | null, caseInsensitive: boolean, includeIgnored: boolean, skip: readonly string[]): string[] {
  // The prefilter only narrows what rg reads, and only when ignored files are asked for; otherwise
  // the listing and the matcher alone select.
  // A readable folder's glob names absolute paths, which an anchored prefilter can't take.
  const prefilter = root.belowIsFile || glob === null || !includeIgnored || root.readable !== undefined ? null : prefilterOf(glob.pattern, root.engine);
  return [
    // One short record per matching line, `<path>NUL<line>:`, with the line's text left out
    // (--max-columns 1): the studio reads the text itself, and a 16 MB one-line file must not
    // come through the pipe.
    '--null', '--line-number', '--no-heading', '--with-filename', '--color', 'never', '--max-columns', '1',
    '--no-config', '--no-ignore', '--no-ignore-dot', '--no-ignore-parent', '--hidden', '--max-filesize', '16M',
    caseInsensitive ? '--ignore-case' : '--case-sensitive',
    // Later globs win, so the exclusions hold whatever the prefilter says.
    ...(prefilter === null ? [] : ['--iglob', prefilter]),
    ...skip,
    '--glob', '!.git',
    ...(root.engine === null ? [] : ['--glob', '!.*/']),
    ...(query.literal ? ['--fixed-strings'] : []),
    ...query.patterns.flatMap(pattern => ['--regexp', pattern]),
    '--', root.below ?? '.',
  ];
}

/** The --glob exclusions for folders rg need not read, and how many could not be passed and why. */
export interface SkipGlobs {
  readonly globs: readonly string[];
  readonly left: number;
  readonly why: string;
}

/**
 * The --glob exclusions that have rg skip `folders` (each `name/`, relative to the root), anchored
 * at the root as the prefilter is, up to MAX_SKIPPED_BYTES. Each glob-special character of a name is
 * wrapped in a one-character class (`[@]`, `[*]`, `[{]`), so a name matches only itself, and other
 * characters pass literally; ! and ^, which rg can't take in a class, are literal past the glob's
 * leading !/. A name holding \ or a control character, and every folder past the budget, is left for
 * rg to read: that costs time, never a wrong answer, since the listing decides.
 */
export function skipGlobs(folders: readonly string[]): SkipGlobs {
  const globs: string[] = [];
  let used = 0;
  let unsafe = 0;
  let over = 0;
  for (const folder of folders) {
    if (!folder.endsWith('/') || folder.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(folder)) {
      unsafe += 1;
      continue;
    }
    const escaped = [...folder.slice(0, -1)].map((char) => (/[A-Za-z0-9._\- /!^]/.test(char) || char.codePointAt(0)! > 0x7f ? char : `[${char}]`)).join('');
    // rg 15.2.0 skips the folder for !/name/** but reads it for !/name/.
    const skip = `!/${escaped}/**`;
    if (used + skip.length + 8 > MAX_SKIPPED_BYTES) {
      over += 1;
      continue;
    }
    used += skip.length + 8;
    globs.push('--glob', skip);
  }
  const why = [over > 0 ? `${over} past the ${MAX_SKIPPED_BYTES / 1024} KB of names rg is given` : '', unsafe > 0 ? `${unsafe} with a name rg can't be given` : ''].filter((part) => part !== '').join(', ');
  return { globs, left: over + unsafe, why };
}

/** A listed path's key: case folded where the file system folds it, since rg prints a name as it is on disk and git as its index holds it. */
function listedKey(relative: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? relative.toLowerCase() : relative;
}

/** Whether a path rg printed is one the root's git listing holds. */
function inListing(listing: Listing, reported: string): boolean {
  const relative = relativeOf(reported);
  return relative !== null && listing.has(listedKey(relative));
}

/**
 * The anchored --iglob prefilter for a root (FILES Implementation Decision 10), or null for none.
 * Only a glob plain enough that rg's glob rules and the studio's matcher read it alike is passed
 * (ASCII names, * and ?, ** as whole folders, and one level of {a,b} groups): the prefilter only
 * narrows what rg reads, and the matcher still decides every match, so a glob it can't pass safely
 * costs time, never a wrong answer.
 */
export function prefilterOf(glob: string, engine: EngineRoot | null): string | null {
  let rest = glob;
  if (engine !== null) {
    const prefix = `engine/${engine.repo}/`;
    if (rest.toLowerCase().startsWith(prefix.toLowerCase())) rest = rest.slice(prefix.length);
    else return null;
  }
  if (rest === '' || !/^[A-Za-z0-9._\- /*?{},]+$/.test(rest)) return null;
  if (!/^[^{}]*(\{[^{}]*\}[^{}]*)*$/.test(rest)) return null;
  for (const group of rest.matchAll(/\{([^{}]*)\}/g)) {
    const options = group[1]!.split(',');
    if (options.length < 2 || options.some((option) => option === '')) return null;
  }
  // ** only as a whole folder: rg reads a ** inside a name as *, the matcher as crossing /.
  for (const segment of rest.split('/')) if (segment.includes('**') && segment !== '**') return null;
  if (rest.includes(',') && !rest.includes('{')) return null;
  return `/${rest}`;
}

/** Starts rg by its absolute path, with no shell and none of the environment's ripgrep settings. */
function ripgrepRunner(ripgrep: string): RipgrepRunner {
  return (args, cwd) => {
    const env: Record<string, string> = {};
    // RIPGREP_CONFIG_PATH would add flags the studio never chose; --no-config ignores it as well.
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.toUpperCase().startsWith('RIPGREP')) env[name] = value;
    return spawn(ripgrep, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  };
}

/**
 * Runs rg over one root and keeps, in `matches`, each match whose file the path layer allows reading
 * and the glob selects. Stops rg when the call passes 10,000 matches, 200,000 records handled, or
 * its deadline. rg's exit codes
 * (FILES Failure Map): 0 matches, 1 none, 2 an error: after matches, or with only files it couldn't
 * read, the matches stand and those files are named; otherwise (a pattern it can't parse) a refusal
 * with rg's message.
 */
function searchRoot(run: RipgrepRunner, args: readonly string[], root: Root, call: FileCall, glob: CompiledPattern | null, exclusions: PathExclusions, listing: Listing, matches: Match[], handled: { records: number; seen: Set<string> }, deadline: number, timeoutMs: number): Promise<Searched> {
  const stopped = `search stopped after ${Math.ceil(timeoutMs / 1000)} s; narrow the path`;
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve({ ok: false, reason: stopped });
  return new Promise((resolve) => {
    let child: RipgrepProcess;
    try {
      child = run(args, root.real);
    } catch (error) {
      resolve({ ok: false, reason: `ripgrep could not be started (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).` });
      return;
    }
    const judged = new Map<string, AllowedPath | null>();
    // The bytes of a record that has not ended yet; a record past MAX_RECORD is dropped whole.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let overlong = false;
    let stderr = '';
    let sawMatch = false;
    let over = false;
    let flooded = false;
    let timedOut = false;
    let failed: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, left);

    /** The allowed file rg's path names, or null when the path layer would refuse it or the glob doesn't select it. */
    const fileOf = (reported: string): AllowedPath | null => {
      let path = judged.get(reported);
      if (path !== undefined) return path;
      path = allowedFile(call, root, reported, glob, exclusions);
      judged.set(reported, path);
      return path;
    };
    /** One record of rg's output: the path up to its NUL, then the line number up to its colon. */
    const record = (line: Buffer): void => {
      if (over || flooded || timedOut) return;
      const nul = line.indexOf(0);
      if (nul <= 0) return;
      const rest = line.subarray(nul + 1);
      const colon = rest.indexOf(0x3a);
      const digits = colon < 0 ? '' : rest.subarray(0, colon).toString('latin1');
      if (!/^\d{1,9}$/.test(digits)) return;
      const reported = line.subarray(0, nul).toString('utf8');
      // A match in a file the path layer refuses by name changes nothing the brain can see: not the
      // record cap, nor whether rg's exit 2 came after matches. Otherwise a pattern such as
      // PAD|^API_TOKEN=k over a pad file of 200,000 lines would tell, one guess a call, what a
      // refused .env holds. It costs only parse time, which the chunked reading and the deadline bound.
      if (hiddenByName(root, reported)) return;
      // A file git doesn't list (ignored, or in a nested repository) is not searched, so its matches
      // count for nothing, as a refused name's don't; the skipped folders keep most of them from rg.
      if (!inListing(listing, reported)) return;
      const path = fileOf(reported);
      if (exclusions.active && path === null) return;
      sawMatch = true;
      handled.records += 1;
      if (handled.records > MAX_RECORDS) {
        flooded = true;
        child.kill();
        return;
      }
      if (path === null) return;
      const key = `${path.canonical}\0${digits}`;
      if (handled.seen.has(key)) return;
      handled.seen.add(key);
      matches.push({ path, line: Number(digits) });
      if (matches.length > MAX_MATCHES) {
        over = true;
        child.kill();
      }
    };
    // Only each chunk's new bytes are scanned for line breaks.
    child.stdout.on('data', (chunk: Buffer) => {
      if (over || flooded || timedOut) return;
      // One chunk at a time, letting the deadline's timer and other work run between them.
      child.stdout.pause();
      setImmediate(() => child.stdout.resume());
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, end);
        if (!overlong && pendingBytes + piece.length <= MAX_RECORD) record(pendingBytes === 0 ? piece : Buffer.concat([...pending, piece]));
        pending = [];
        pendingBytes = 0;
        overlong = false;
        start = end + 1;
        if (over || flooded || timedOut) return;
      }
      const rest = chunk.subarray(start);
      if (rest.length === 0 || overlong) return;
      if (pendingBytes + rest.length > MAX_RECORD) {
        overlong = true;
        pending = [];
        pendingBytes = 0;
        return;
      }
      pending.push(Buffer.from(rest));
      pendingBytes += rest.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failed = `ripgrep could not be started (${error.code ?? 'unknown error'}).`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!over && !flooded && !timedOut && !overlong && pendingBytes > 0) record(Buffer.concat(pending));
      if (over) return resolve({ ok: false, reason: `more than ${MAX_MATCHES.toLocaleString('en-US')} matches; narrow the pattern or path` });
      if (flooded) return resolve({ ok: false, reason: `rg reported more than ${MAX_RECORDS.toLocaleString('en-US')} matching lines; narrow the pattern or path` });
      if (timedOut) return resolve({ ok: false, reason: stopped });
      if (failed !== null) return resolve({ ok: false, reason: failed });
      if (code === 0 || code === 1) return resolve({ ok: true, unreadable: [] });
      const errors = stderrOf(stderr, root, call, listing, exclusions);
      if (sawMatch || errors.other.length === 0) return resolve({ ok: true, unreadable: errors.files });
      const message = errors.other.join('\n').replace(CONTROL_ALL, '?').slice(0, 2000);
      const why = /regex parse error|error parsing/i.test(message) ? 'rg could not read the pattern as a regular expression' : `rg failed (exit code ${code ?? 'none'})`;
      resolve({ ok: false, reason: `${why}:\n${message}` });
    });
  });
}

/** The file a path rg printed names, if the path layer allows reading it as a file and the glob selects it. */
/** A path rg printed, relative to its root with `/`, or null when it is no such path. */
function relativeOf(reported: string): string | null {
  // On Windows rg prints \ and no name holds one; elsewhere \ is part of a name.
  let relative = process.platform === 'win32' ? reported.replaceAll('\\', '/') : reported;
  if (relative.startsWith('./')) relative = relative.slice(2);
  return relative === '' || relative.startsWith('/') ? null : relative;
}

/**
 * Whether a path rg printed is one the path layer refuses by its names alone, with the layer's own
 * tests: a credential file name, a .ssh, .secrets or .git folder, a writer's temporary file, or a
 * dot folder inside an engine link. Cheap and without touching the disk, so it can run on every record.
 */
function hiddenByName(root: Root, reported: string): boolean {
  const relative = relativeOf(reported);
  if (relative === null) return true;
  const parts = relative.split('/');
  const last = parts.at(-1)!;
  if (parts.some((part) => ['.git', '.secrets', '.ssh'].includes(part.toLowerCase()))) return true;
  if (isCredentialFileName(last) || /\.ff-tmp$/i.test(last)) return true;
  return root.engine !== null && parts.slice(0, -1).some((part) => part.startsWith('.'));
}

function allowedFile(call: FileCall, root: Root, reported: string, glob: CompiledPattern | null, exclusions: PathExclusions): AllowedPath | null {
  const relative = relativeOf(reported);
  if (relative === null) return null;
  const canonical = root.readable !== undefined ? `${root.readable.replace(/\/$/, '')}/${relative}` : root.engine === null ? relative : `engine/${root.engine.repo}/${relative}`;
  // The glob first, on the path as rg printed it, so a file it doesn't select costs no walk; then
  // again on the name the path layer found on disk, which decides.
  if (glob !== null && !glob.matches(canonical)) return null;
  const path = call.judge(canonical, 'read');
  if (!path.ok || path.kind !== 'file') return null;
  if (exclusions.matches(path.canonical)) return null;
  // A writer's temporary file is readable but half written; find_files and list_dir hide it too.
  if (/\.ff-tmp$/i.test(path.canonical)) return null;
  // The worktree's engine/<repo> entries are searched as their own roots.
  if (root.engine === null && path.engine !== null) return null;
  if (glob !== null && !glob.matches(path.canonical)) return null;
  return path;
}

/**
 * rg's error output, split into the files it couldn't read ("rg: <path>: <reason>"), named only
 * when the path layer allows reading them, and every other line. A file the layer refuses is left
 * out of both, so no refused name is ever printed.
 */
function stderrOf(stderr: string, root: Root, call: FileCall, listing: Listing, exclusions: PathExclusions): { files: string[]; other: string[] } {
  const files: string[] = [];
  const other: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const file = /^rg: (.+?): (.+)$/.exec(line);
    if (file !== null && !/^(regex parse error|error parsing)/i.test(file[1]!)) {
      // A file outside the listing was never to be searched, so it is not named either.
      const path = inListing(listing, file[1]!) ? allowedFile(call, root, file[1]!, null, exclusions) : null;
      if (path !== null) files.push(`${path.canonical} (${file[2]!.replace(CONTROL_ALL, '?')})`);
      continue;
    }
    other.push(line.replace(/^rg: /, ''));
  }
  return { files, other };
}

/** How a reply names the search it answers. */
export interface SearchAsked {
  readonly regex: string;
  readonly glob: string | null;
  /** The path searched, canonical; `.` for the whole worktree. */
  readonly where: string;
  readonly includeIgnored: boolean;
}

/**
 * The reply for the gathered, sorted matches from `offset`: each file's path, then its matches as
 * N:hhhhhh|text read by the studio's reader, as view_file shows them, at most 200 matches and
 * 50 KB (one match always shows), starting no new file once `maxRead` bytes are read; then the
 * files rg could not read; then `next: offset=K` when more follow. A file the reader refuses now (not UTF-8, changed into a binary) prints its reason in
 * place of its lines.
 */
export function searchReply(matches: readonly Match[], unreadable: readonly string[], offset: number, asked: SearchAsked, maxRead = SEARCH_MAX_READ, full = false, context = 0): string {
  const named = unreadableLines(unreadable, full);
  if (matches.length === 0) {
    const place = asked.where === '.' ? '' : ` in ${asked.where}`;
    const files = asked.glob === null ? '' : ` in files matching ${asked.glob}`;
    const ignored = asked.includeIgnored ? '' : ' (ignored files are skipped; include_ignored: true searches them)';
    return [`No line matches ${shown(asked.regex)}${files}${place}${ignored}.`, ...named].join('\n');
  }
  if (offset >= matches.length) return [`${matches.length} lines match ${shown(asked.regex)}; nothing from offset=${offset}.`, ...named].join('\n');
  if (context > 0) return contextSearchReply(matches, named, offset, context, maxRead, full, SEARCH_PAGE);
  // The next line and the unreadable files are reserved at their longest, so the reply stays under the cap.
  let budget = VIEW_MAX_BYTES - bytes(`\nnext: offset=${matches.length}`) - named.reduce((sum, line) => sum + bytes(line) + 1, 0);
  const lines: string[] = [];
  let index = offset;
  let file: string | null = null;
  let read = 0;
  let text: { ok: true; lines: readonly string[] } | { ok: false; reason: string } | null = null;
  while (index < matches.length && (full || index - offset < SEARCH_PAGE)) {
    const match = matches[index]!;
    const printed: string[] = [];
    if (match.path.canonical !== file) {
      // A page of matches in many large files would read them all: past 32 MB read, the next file waits for the next page.
      if (index > offset && read >= maxRead) break;
      const opened = readText(match.path);
      if (opened.ok) read += opened.file.bytes.length;
      text = opened.ok ? { ok: true, lines: opened.file.lines.map((line) => line.text) } : { ok: false, reason: opened.reason };
      printed.push(text.ok ? match.path.canonical : text.reason);
    }
    // A line gone since rg read the file (it shrank) shows nothing; its file's reason was printed once.
    const lineText = text !== null && text.ok ? text.lines[match.line - 1] : undefined;
    if (lineText !== undefined) printed.push(`${anchorOf(match.line, lineText)}|${cut(lineText, full)}`);
    const cost = printed.reduce((sum, line) => sum + bytes(line) + 1, 0);
    if (!full && index > offset && cost > budget) break;
    lines.push(...printed);
    budget -= cost;
    file = match.path.canonical;
    index += 1;
  }
  lines.push(...named);
  if (index < matches.length) lines.push(`next: offset=${index}`);
  return lines.join('\n');
}

function unreadableLines(unreadable: readonly string[], full: boolean): string[] {
  if (unreadable.length === 0) return [];
  const names = unreadable.slice(0, full ? undefined : MAX_UNREADABLE).map((name) => `rg could not read ${name}`);
  if (!full && unreadable.length > MAX_UNREADABLE) names.push(`and ${unreadable.length - MAX_UNREADABLE} more files rg could not read`);
  return names;
}

/** The brain's pattern as a reply repeats it: control characters hidden and its length capped. */
function shown(text: string): string {
  const safe = text.replace(CONTROL_ALL, '?');
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}
