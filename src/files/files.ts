// Shared file tools: path checks, text hashes, anchors and atomic writes.
// every file tool decides a path here, the same way, at the start of each call.
//
// A path is allowed only in the task worktree (read and write) or in one of its engine links (read
// only), as LINK's path rules (../policy/path-rules.ts) decide those two roots; every other
// answer is a refusal, never a question. The roots are worked out once per tool call, never cached
// for the session, because the studio relinks after a catch-up merge and the owner can repoint a
// link. On top of LINK's verdict, which judges a path by its real path and so can't see the links it
// passed through, this layer refuses Windows path forms that alias other names before resolving
// anything. A bounded outer resolver permits read-only symlink/junction traversal,
// authorizing alias and target separately; writes through links always refuse.
// The direct walker rejects unresolved links and adds FILES' own refusals: .git anywhere, credential files by
// name, .secrets and .ssh folders, and for writes hard-linked files and the writer's temporary names.
// The rules are judged on the real names the walk finds, so an 8.3 short name aliases nothing.
// Beside those two roots, a session may have read-only folders the studio wrote for it outside the
// worktree (FILES-readable): its pinned skills and Pi's reading folder. They are named by absolute
// path only, are never written, and retain all credential/target protections during link reads.
//
// The text reader and the hashes follow (FILES-anchor): every tool that reads a file's text, and every
// anchor a tool prints or checks, comes from them, so view_file, edit_file, write_file and
// search_files agree on what a line is and what its anchor says.
//
// Last come the atomic writer, the remover, and the lock every writing tool takes (FILES-atomic): a
// write lands whole or not at all, and two writes to one file never interleave, whichever sessions send them.
// The sweep, run at session start and before the hand-in commits, removes temporary files a write
// that died left behind, each under its target's lock.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ENGINE_READ_ONLY, engineRoots, isDeviceName, verdict, type EngineRoot, type PathRole, type PathRoots } from '../policy/path-rules.ts';
import { isCredentialFileName } from '../policy/sensitive-paths.ts';
import type { DirectoryPermissions, EffectivePermission } from './directory-permissions.ts';
import { gitArguments, runGit, type GitPlace } from '../git/git.ts';

/** The session a file tool is bound to when the session starts. */
export interface FileSession {
  /** The task worktree, as the session was given it. */
  readonly worktree: string;
  /**
   * The project's main checkout, whose package.json declares the engine repos; null when it couldn't
   * be found, so the session has no engine links.
   */
  readonly project: string | null;
  /** An implementer writes; every other session reads only. */
  readonly role: PathRole;
  /** The folders the studio wrote for this session outside the worktree, which the reading tools read; none when absent. */
  readonly readable?: ReadableFolders;
  /** Standalone full mode: read external paths without project-specific engine roots. */
  readonly externalRead?: boolean;
  /** Frozen owner-selected directory overrides; absent for legacy adapters. */
  readonly permissions?: DirectoryPermissions;
}

/**
 * The read-only folders of a session (FILES-readable), handed to its file session once by the adapter
 * that wrote them, before the session's first tool call: Pi makes its reading folder only after the
 * gateway is prepared, so the tools are bound before the folders exist. The first tool call seals the
 * list, so what a session may read never changes once its brain has called a tool.
 */
export class ReadableFolders {
  private folders: readonly string[] | null = null;
  private sealed = false;

  constructor(folders?: readonly string[]) {
    if (folders !== undefined) this.give(folders);
  }

  /** Sets the folders; throws when they were given already, a tool call came first, or one is not an absolute folder below a drive's root. */
  give(folders: readonly string[]): void {
    if (this.folders !== null) throw new Error("The session's readable folders were given twice.");
    if (this.sealed) throw new Error("The session's readable folders came after its first file tool call.");
    for (const folder of folders) {
      // A drive's root would make every file on it readable.
      if (typeof folder !== 'string' || !isAbsolute(folder) || dirname(resolve(folder)) === resolve(folder)) throw new Error(`${String(folder)} is not a folder the studio's tools may read.`);
    }
    this.folders = [...folders];
  }

  /** The folders, sealing the list: a tool call has begun. */
  list(): readonly string[] {
    this.sealed = true;
    return this.folders ?? [];
  }
}

export type FileAccess = 'read' | 'write';

/** What a write access does to the file: replaces its content, or removes it; only a refusal's wording differs. */
export type WriteKind = 'write' | 'delete';

/** Which rule refused a path; each refusal's reason names it in words. */
export type PathRule =
  | 'form'
  | 'outside'
  | 'read-only'
  | 'engine-dot-folder'
  | 'reads-only'
  | 'directory-permission'
  | 'git'
  | 'link'
  | 'credential'
  | 'temp-file'
  | 'hard-link'
  | 'not-a-folder'
  | 'worktree-root'
  | 'unreadable';

/** A path the layer allows, as the tools work on it and print it. */
export interface AllowedPath {
  readonly ok: true;
  /** Worktree-relative with `/` and on-disk case, `engine/<repo>/...` under an engine link, `.` for the worktree itself. */
  readonly canonical: string;
  /** Where the tools read or write it: under the worktree's real path, or under the engine link's real target, never through a link. */
  readonly absolute: string;
  /** The engine repo it is in, or null for the worktree. */
  readonly engine: string | null;
  /** What is there now. */
  readonly kind: 'file' | 'folder' | 'missing';
  /** In one of the session's readable folders: that folder's canonical form (its real path with `/`); absent elsewhere. */
  readonly readable?: string;
  readonly permission?: EffectivePermission;
  /** Reauthorize a policy-bound path after waits and before filesystem I/O. */
  readonly recheck?: () => string | null;
  /** Absolute requested alias. A traversed link is an unconditional write ceiling. */
  readonly requested?: string;
  readonly throughLink?: boolean;
}

export interface RefusedPath {
  readonly ok: false;
  readonly rule: PathRule;
  readonly reason: string;
}

export type PathAnswer = AllowedPath | RefusedPath;

/** One tool call's view of the session's paths: its roots, worked out when the call began. */
export interface FileCall {
  readonly roots: PathRoots;
  readonly restricted?: boolean;
  /** The answer for `access` of `path`, as the brain sent it; `kind` words a write's refusals. */
  judge(path: unknown, access: FileAccess, kind?: WriteKind): PathAnswer;
}

/** Why a path neither root holds is refused. */
export const OUTSIDE = 'outside the task worktree and its engine links';

/** The longest path the layer reads; far past any real one, so a huge argument costs nothing. */
const MAX_PATH = 4096;
/** Characters Windows forbids in a name, besides `:`, which formProblem refuses first with its own reason. */
const FORBIDDEN = /[<>"|?*]/;
/**
 * C0 and C1 control characters, the bidi controls and marks, the zero-width characters, and the line
 * and paragraph separators: a name holding one can print as another name (`.git\u009b/x` shows as
 * `.git/x`) or break a one-path-per-line reply, so the layer refuses it and a refusal never shows
 * it. Written as escapes, so the source itself hides nothing.
 */
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060\u2066-\u2069\ufeff]/;

/**
 * Starts a tool call: works out the session's roots once, with LINK's engineRoots exactly as LINK
 * defines it (one git call per declared repo with a paired link), and judges every path of the call
 * against them.
 */
export function startCall(session: FileSession): FileCall {
  const roots: PathRoots = { worktree: session.worktree, engines: session.project === null ? [] : engineRoots(session.worktree, session.project) };
  const worktreeReal = realOrNull(session.worktree);
  const readable = readableRoots(session.readable?.list() ?? [], roots, worktreeReal);
  return { roots, restricted: session.permissions !== undefined, judge: (path, access, kind = 'write') => judgePath(path, access, session.role, roots, worktreeReal, readable, kind, session.externalRead === true, session.permissions) };
}

/** A readable folder of one call: as the adapter gave it, and its real path. */
interface ReadableRoot {
  readonly given: string;
  readonly real: string;
}

/**
 * The readable folders, as given and by their real paths, leaving out one that doesn't exist and one
 * that holds or is inside the worktree or an engine repo by either spelling: those roots keep their
 * own rules, and a folder above the worktree would make its siblings readable.
 */
function readableRoots(folders: readonly string[], roots: PathRoots, worktreeReal: string | null): ReadableRoot[] {
  const others = [roots.worktree, ...(worktreeReal === null ? [] : [worktreeReal]), ...roots.engines.map((engine) => engine.real)];
  const apart = (path: string): boolean => others.every((other) => below(path, other) === null && below(other, path) === null);
  return folders.flatMap((folder) => {
    const real = realOrNull(folder);
    return real !== null && apart(real) && apart(resolve(folder)) ? [{ given: resolve(folder), real }] : [];
  });
}

function judgePath(input: unknown, access: FileAccess, role: PathRole, roots: PathRoots, worktreeReal: string | null, readable: readonly ReadableRoot[], kind: WriteKind, externalRead: boolean, permissions?: DirectoryPermissions, hops = 0): PathAnswer {
  if (typeof input !== 'string' || formProblem(input) !== null || worktreeReal === null) return judgeDirectPath(input, access, role, roots, worktreeReal, readable, kind, externalRead, permissions);
  if (hops >= 40) return refuse('link', 'Too many symlink/junction traversals (cycle or excessive depth).');
  const absolute = resolve(roots.worktree, input.replaceAll('\\', '/'));
  const root = parse(absolute).root;
  const parts = below(root, absolute)!;
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let stats: BigIntStats;
    try { stats = lstatSync(current, { bigint: true }); }
    catch { break; } // The direct judge reports missing/unreadable paths.
    if (!stats.isSymbolicLink()) continue;
    if (access === 'write') return refuse('link', 'Symlinks/junctions and paths through them are unconditionally read-only; no rule can override this.');
    // Authorize the alias namespace as well as every target namespace. Never hide
    // a protected name or denied alias behind an otherwise readable target.
    const own = ownRefusal(absolute, { absolute, parts, engine: null, kind: 'file', hardLinks: 0n }, 'read', kind);
    if (own !== null) return own;
    if (permissions !== undefined) {
      try {
        if (permissions.isConfig(absolute) || permissions.isConfig(current) || permissions.effective(absolute, worktreeReal, role === 'implementer', externalRead).access === 'deny') return refuse('directory-permission', 'Read access denied for the requested link path.');
      } catch { return refuse('directory-permission', 'A permission root changed; owner must review and restart.'); }
    }
    const parent = judgePath(dirname(current), 'read', role, roots, worktreeReal, readable, kind, externalRead, permissions, hops + 1);
    if (!parent.ok) return parent;
    let target: string;
    try { target = readlinkSync(current); } catch { return refuse('link', 'Link changed or could not be resolved.'); }
    // Windows may return a local NT namespace prefix for an existing junction.
    if (target.startsWith(String.fromCharCode(92, 92, 63, 92)) && /^[A-Za-z]:/.test(target.slice(4))) target = target.slice(4);
    if (formProblem(target) !== null) return refuse('form', 'Link target uses an unsafe path form.');
    const destination = resolve(dirname(current), target, ...parts.slice(index + 1));
    const answer = judgePath(destination, 'read', role, roots, worktreeReal, readable, kind, externalRead, permissions, hops + 1);
    if (!answer.ok) return answer;
    if (answer.kind === 'missing') return refuse('link', 'Dangling symlink/junction target.');
    const canonical = absolute.replaceAll('\\', '/');
    return { ...answer, canonical, requested: absolute, throughLink: true,
      readable: answer.kind === 'folder' ? canonical : dirname(absolute).replaceAll('\\', '/'),
      permission: { ...(answer.permission ?? { rule: null, capped_by_global_read_only: role !== 'implementer' }), access: 'read-only', capped_by_link: true },
      recheck: () => {
        const fresh = judgePath(input, 'read', role, roots, worktreeReal, readable, kind, externalRead, permissions);
        return fresh.ok && fresh.absolute === answer.absolute ? null : 'Link target or its permissions changed; inspect the requested path again.';
      },
    };
  }
  return judgeDirectPath(input, access, role, roots, worktreeReal, readable, kind, externalRead, permissions);
}

function judgeDirectPath(input: unknown, access: FileAccess, role: PathRole, roots: PathRoots, worktreeReal: string | null, readable: readonly ReadableRoot[], kind: WriteKind, externalRead: boolean, permissions?: DirectoryPermissions): PathAnswer {
  if (typeof input !== 'string') return refuse('form', 'The path must be text.');
  const form = formProblem(input);
  if (form !== null) return refuse('form', `${shown(input)} is not a path the studio's tools accept: ${form}.`);
  if (worktreeReal === null) return refuse('unreadable', 'The task worktree could not be found.');
  const slashed = input.replaceAll('\\', '/');
  const absolute = resolve(roots.worktree, slashed === '' ? '.' : slashed);
  if (permissions !== undefined) return judgeDirectoryPath(input, absolute, access, role, roots, worktreeReal, kind, externalRead, permissions);
  // A readable folder is named only by an absolute path, as given or by its real path, so a .. from
  // the worktree never reaches one.
  if (isAbsolute(slashed)) {
    for (const folder of readable) {
      const parts = below(folder.real, absolute) ?? below(folder.given, absolute);
      if (parts !== null) return judgeReadable(input, folder.real, parts, roots, worktreeReal, access, kind);
    }
  }

  // Which root the path names, by its spelling: the worktree (as given or by its real path), or an
  // engine link's real target, the form a Claude brain sends since its roots include those.
  const homes: { root: string; engine: EngineRoot | null }[] = [
    ...roots.engines.map((engine) => ({ root: engine.real, engine })),
    { root: roots.worktree, engine: null },
    { root: worktreeReal, engine: null },
  ];
  const home = homes
    .map((candidate) => ({ ...candidate, parts: below(candidate.root, absolute) }))
    .filter((candidate) => candidate.parts !== null)
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (home === undefined) {
    if (externalRead) {
      const root = parse(absolute).root;
      const answer = judgeReadable(input, root, below(root, absolute)!, roots, worktreeReal, access, kind);
      if (!answer.ok) return answer;
      // Narrow enumeration to the requested folder, not the entire drive.
      return { ...answer, readable: (answer.kind === 'folder' ? answer.absolute : dirname(answer.absolute)).replaceAll('\\', '/') };
    }
    return refuse('outside', `${shown(input)} is ${OUTSIDE}.`);
  }

  // LINK's verdict first: it alone says which root a path is in and refuses an engine's dot folders.
  const linkVerdict = verdict(absolute, roots, role, access);
  if (linkVerdict.kind === 'outside') {
    if (access === 'write' && verdict(absolute, roots, role, 'read').kind === 'allow') return worktreeWriteRefusal(input, role, worktreeReal, absolute);
    return refuse('outside', `${shown(input)} is ${OUTSIDE}.`);
  }
  if (linkVerdict.kind === 'refused') return refuse('engine-dot-folder', `${shown(input)}: ${linkVerdict.reason}.`);

  const walked = walk(home.parts!, home.engine, roots, worktreeReal, access);
  if ('rule' in walked) return refuse(walked.rule, walked.reason);
  // The walk and LINK must agree on the root; anything else means the disk changed under us.
  const inEngine = walked.engine !== null;
  if (inEngine !== (linkVerdict.kind === 'read-only')) return refuse('outside', `${shown(input)} is ${OUTSIDE}.`);
  const canonical = walked.engine === null
    ? (walked.parts.length === 0 ? '.' : walked.parts.join('/'))
    : ['engine', walked.engine.repo, ...walked.parts].join('/');
  if (inEngine && access === 'write') return refuse('read-only', `${canonical}: ${ENGINE_READ_ONLY}.`);

  const own = ownRefusal(canonical, walked, access, kind);
  if (own !== null) return own;
  // A trailing / names a folder; on a file or a missing name it would let `notes.txt/` stand for the
  // file and a write to `src/new/` create a file named new.
  if (/[\\/]$/.test(input) && walked.kind !== 'folder') {
    const what = walked.kind === 'file' ? 'is a file' : 'is not there';
    return refuse('not-a-folder', `${shown(input)} ends in a slash, which names a folder, and ${canonical} ${what}.`);
  }
  return { ok: true, canonical, absolute: walked.absolute, engine: walked.engine?.repo ?? null, kind: walked.kind };
}

/**
 * Judges a path in the readable folder `folder` (its real path): never written, walked from the folder
 * down with no link followed, then FILES' own refusals on the names below it. It prints absolute, as
 * the folder's real path with `/` and the names on disk.
 */
function judgeReadable(input: string, folder: string, parts: readonly string[], roots: PathRoots, worktreeReal: string, access: FileAccess, kind: WriteKind, allowWrite = false): PathAnswer {
  const prefix = folder.replaceAll('\\', '/').replace(/\/$/, '');
  if (access === 'write' && !allowWrite) return refuse('read-only', `${shown(input)} is outside the writable repository; external paths are read-only.`);
  const walked = walk(parts, null, roots, worktreeReal, access, { real: folder, prefix });
  if ('rule' in walked) return refuse(walked.rule, walked.reason);
  const canonical = walked.parts.length === 0 ? folder.replaceAll('\\', '/') : `${prefix}/${walked.parts.join('/')}`;
  const own = ownRefusal(canonical, walked, access, kind);
  if (own !== null) return own;
  if (/[\\/]$/.test(input) && walked.kind !== 'folder') {
    const what = walked.kind === 'file' ? 'is a file' : 'is not there';
    return refuse('not-a-folder', `${shown(input)} ends in a slash, which names a folder, and ${canonical} ${what}.`);
  }
  return { ok: true, canonical, absolute: walked.absolute, engine: null, kind: walked.kind, readable: prefix };
}

function judgeDirectoryPath(input: string, absolute: string, access: FileAccess, role: PathRole, roots: PathRoots, worktreeReal: string, kind: WriteKind, externalRead: boolean, permissions: DirectoryPermissions): PathAnswer {
  const root = parse(absolute).root;
  const parts = below(root, absolute)!;
  const read = judgeReadable(input, root, parts, roots, worktreeReal, 'read', kind);
  if (!read.ok) return read;
  let permission: EffectivePermission;
  try {
    if (permissions.isConfig(read.absolute)) return refuse('directory-permission', 'The active permissions configuration is protected from file tools.');
    permission = permissions.effective(read.absolute, worktreeReal, role === 'implementer', externalRead);
  } catch { return refuse('directory-permission', 'A directory permission root is unavailable or changed; owner must review and restart the server.'); }
  if (permission.access === 'deny') return refuse('directory-permission', `Read access denied${permission.rule === null ? ' by the default repository scope' : ` by directory rule ${permission.rule.path} (deny)`}.`);
  if (access === 'write') {
    if (role !== 'implementer') return refuse('reads-only', 'Global read-only access is a hard write ceiling; directory overrides cannot enable writes.');
    if (permission.access !== 'full') return refuse('directory-permission', `Write access denied${permission.rule === null ? ' by the default external read-only scope' : ` by directory rule ${permission.rule.path} (${permission.rule.access})`}.`);
    if (below(worktreeReal, read.absolute)?.length === 0 || permissions.isRoot(read.absolute)) return refuse('directory-permission', 'Repository and configured permission roots cannot be moved, removed or replaced.');
  }
  const answer = access === 'read' ? read : judgeReadable(input, root, parts, roots, worktreeReal, access, kind, true);
  if (!answer.ok) return answer;
  const recheck = (): string | null => {
    const current = judgePath(answer.absolute, access, role, roots, worktreeReal, [], kind, externalRead, permissions);
    return current.ok ? null : current.reason;
  };
  const ownParts = below(worktreeReal, answer.absolute);
  if (ownParts !== null) return { ok: true, canonical: ownParts.length === 0 ? '.' : ownParts.join('/'), absolute: answer.absolute, engine: null, kind: answer.kind, permission, recheck };
  return { ...answer, permission, recheck, readable: (answer.kind === 'folder' ? answer.absolute : dirname(answer.absolute)).replaceAll('\\', '/') };
}

/** What is wrong with the path's form, before anything is resolved, or null. */
function formProblem(path: string): string | null {
  if (path.length > MAX_PATH) return `it is longer than ${MAX_PATH} characters`;
  if (path.startsWith('\\\\?\\') || path.startsWith('//?/')) return 'a \\\\?\\ prefix reaches past the path rules';
  if (path.startsWith('\\\\.\\') || path.startsWith('//./')) return 'a \\\\.\\ prefix names a device';
  if (/^[\\/]{2}/.test(path)) return 'a network (UNC) path is never a task file';
  let rest = path.replaceAll('\\', '/');
  const drive = /^[A-Za-z]:\//.exec(rest);
  if (drive !== null) rest = rest.slice(drive[0].length);
  else if (rest.startsWith('/')) {
    // On Windows a leading / means the current drive's root, which names no root of the task.
    if (process.platform === 'win32') return 'a path that starts with / needs a drive letter';
    rest = rest.slice(1);
  }
  // One trailing / names the same folder, as a listing prints it; judgePath refuses it on anything else.
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  if (rest === '') return null;
  for (const part of rest.split('/')) {
    if (part === '') return 'it has an empty segment';
    if (part === '.' || part === '..') continue;
    if (CONTROL.test(part)) return 'a segment holds a control character';
    if (part.includes(':')) return `"${shown(part)}" holds a colon, which names an alternate data stream`;
    if (FORBIDDEN.test(part)) return `"${shown(part)}" holds a character Windows forbids in names`;
    if (/[. ]$/.test(part)) return `"${shown(part)}" ends in a dot or space, which Windows drops, so it would name another file`;
    // The device rule Claude's hook and Pi's policy share, so the three never drift apart.
    if (isDeviceName(part)) return `"${shown(part)}" is a Windows device name`;
  }
  return null;
}

interface Walked {
  /** The segments below the root, with the real names found on disk, then the missing ones as written. */
  readonly parts: string[];
  readonly absolute: string;
  readonly engine: EngineRoot | null;
  readonly kind: 'file' | 'folder' | 'missing';
  /** The file's hard-link count (nlink); 0 for a folder or a missing name. */
  readonly hardLinks: bigint;
}

/** A readable folder the walk starts in: its real path, and the canonical prefix its refusals print. */
interface ReadableStart {
  readonly real: string;
  readonly prefix: string;
}

/**
 * Walks `parts` from the root down with lstat, refusing every link or junction on the way except
 * engine/<repo> directly under the worktree, which must be the very link LINK kept as a root (the
 * same file, so case and short names can't stand in for it); the walk then continues in that link's
 * real target, never through the link. In a readable folder (`readable`) no link at all is passed. A
 * write needs every existing segment but the last to be a folder.
 */
function walk(parts: readonly string[], engine: EngineRoot | null, roots: PathRoots, worktreeReal: string, access: FileAccess, readable: ReadableStart | null = null): Walked | { rule: PathRule; reason: string } {
  const shownParts = (inEngine: EngineRoot | null, named: readonly string[]): string => (readable === null ? shownPartsOf(inEngine, named) : shown([readable.prefix, ...named].join('/')));
  let root = readable !== null ? readable.real : engine === null ? worktreeReal : engine.real;
  let inEngine = engine;
  let current = root;
  let kind: Walked['kind'] = 'folder';
  let found: BigIntStats | null = null;
  const missing: string[] = [];
  const named: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (kind !== 'folder') {
      if (kind === 'file' && access === 'write') return { rule: 'not-a-folder', reason: `${shownParts(inEngine, named)} is a file, not a folder.` };
      kind = 'missing';
      missing.push(part);
      continue;
    }
    const next = join(current, part);
    let stats: BigIntStats;
    try {
      stats = lstatSync(next, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { rule: 'unreadable', reason: `${shownParts(inEngine, [...named, part])} could not be checked (${code ?? 'unknown error'}).` };
      kind = 'missing';
      missing.push(part);
      continue;
    }
    named.push(part);
    if (stats.isSymbolicLink()) {
      const kept = readable === null && inEngine === null && index === 1 && nameOn(worktreeReal, parts[0]!).toLowerCase() === 'engine'
        ? roots.engines.find((candidate) => sameFile(stats, candidate.link))
        : undefined;
      if (kept === undefined) {
        return { rule: 'link', reason: `${shownParts(inEngine, named)} is a link or junction; the studio's tools follow none except engine/<repo>.` };
      }
      inEngine = kept;
      root = kept.real;
      current = kept.real;
      named.length = 0;
      found = null;
      kind = 'folder';
      continue;
    }
    current = next;
    found = stats;
    kind = stats.isDirectory() ? 'folder' : 'file';
  }
  // The real names of what exists, from the folder's own entry, so case and short names become the names on disk.
  const real = current === root ? root : realOrNull(current);
  if (real === null) return { rule: 'unreadable', reason: `${shownParts(inEngine, named)} could not be checked.` };
  const existing = below(root, real);
  if (existing === null) return { rule: 'outside', reason: `${shownParts(inEngine, named)} is ${OUTSIDE}.` };
  // formProblem saw only the spelling; an 8.3 short name can stand for a real name holding a control
  // or bidi character, which every reply would then print as the canonical path.
  if (existing.some((part) => CONTROL.test(part))) {
    return { rule: 'form', reason: `${shownParts(inEngine, named)} names something whose name on disk holds a control character, which the studio's tools never print.` };
  }
  return {
    parts: [...existing, ...missing],
    absolute: join(real, ...missing),
    engine: inEngine,
    kind: missing.length > 0 ? 'missing' : kind,
    hardLinks: found === null || missing.length > 0 ? 0n : found.nlink,
  };
}

/** FILES' own refusals on top of LINK's verdict and the walk, judged on the real names, or null. */
function ownRefusal(canonical: string, walked: Walked, access: FileAccess, kind: WriteKind): RefusedPath | null {
  const parts = walked.parts;
  if (parts.some((part) => part.toLowerCase() === '.git')) return refuse('git', `${canonical} is in .git, which the studio's tools never read or write.`);
  if (walked.engine !== null) {
    const dotFolder = parts.find((part, index) => part.startsWith('.') && (index < parts.length - 1 || walked.kind === 'folder'));
    if (dotFolder !== undefined) return refuse('engine-dot-folder', `${canonical}: ${dotFolder} is a dot folder inside engine/${walked.engine.repo}, which tasks neither read nor write.`);
  }
  const secretFolder = parts.find((part) => ['.secrets', '.ssh'].includes(part.toLowerCase()));
  if (secretFolder !== undefined) return refuse('credential', `${canonical} is in a ${secretFolder} folder; the studio's tools don't touch credential files.`);
  // The last name is the one on disk when it exists and the one written, already through formProblem,
  // when it doesn't, so the written spelling needs no check of its own.
  const last = parts.at(-1) ?? '';
  if (isCredentialFileName(last)) {
    return refuse('credential', `${canonical} is a credential file; the studio's tools don't touch credential files, and the hand-in refuses to commit them.`);
  }
  if (access === 'write') {
    if (/\.ff-tmp$/i.test(last)) return refuse('temp-file', `${canonical} ends in .ff-tmp, the name the studio's tools give their temporary files.`);
    if (walked.kind === 'file' && walked.hardLinks > 1n) return refuse('hard-link', hardLinked(canonical, walked.hardLinks, kind));
  }
  return null;
}

/** Why a hard-linked file is not written or deleted: either would act on one of its names and not the others. */
function hardLinked(canonical: string, links: bigint, kind: WriteKind): string {
  return kind === 'delete'
    ? `${canonical} is hard-linked (${links} links); deleting it would remove one name and leave the file under the others.`
    : `${canonical} is hard-linked (${links} links); writing it would split the link.`;
}

/** Why a write the worktree holds but LINK doesn't allow is refused. */
function worktreeWriteRefusal(input: string, role: PathRole, worktreeReal: string, absolute: string): RefusedPath {
  const parts = below(worktreeReal, realOrNull(absolute) ?? absolute) ?? [];
  if (parts.some((part) => part.toLowerCase() === '.git')) return refuse('git', `${shown(input)} is in .git, which the studio's tools never read or write.`);
  if (role !== 'implementer') return refuse('reads-only', `${shown(input)}: this session reads files and writes none.`);
  if (parts.length === 0) return refuse('worktree-root', `${shown(input)} is the task worktree itself, not a file in it.`);
  // A missing target keeps its parts as written, so a short name such as GIT~1/newfile hides the
  // .git that LINK found; with the worktree itself ruled out, that is the only write LINK refuses here.
  return refuse('git', `${shown(input)} is in .git, which the studio's tools never read or write.`);
}

// shortcut: below and realOrNull copy path-rules.ts's private helpers instead of widening LINK's
// exports; revisit when path-rules.ts may change.
/** The segments of `path` below the folder `root` (none for the folder itself), or null when `path` isn't in it. */
function below(root: string, path: string): string[] | null {
  // On Windows relative() matches folders whatever their case, as Windows does, and keeps the path's own spelling.
  const between = relative(root, path);
  if (between === '') return [];
  if (between === '..' || between.startsWith(`..${sep}`) || isAbsolute(between)) return null;
  return between.split(sep);
}

/** The on-disk name of `part` in `folder`, or `part` as written when it can't be read. */
function nameOn(folder: string, part: string): string {
  const real = realOrNull(join(folder, part));
  const parts = real === null ? null : below(folder, real);
  return parts !== null && parts.length === 1 ? parts[0]! : part;
}

function sameFile(stats: BigIntStats, path: string): boolean {
  try {
    const other = lstatSync(path, { bigint: true });
    return other.isSymbolicLink() && other.ino === stats.ino && other.dev === stats.dev;
  } catch {
    return false;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function refuse(rule: PathRule, reason: string): RefusedPath {
  return { ok: false, rule, reason };
}

/** A path as a refusal shows it: CONTROL's characters hidden and its length capped. */
function shown(path: string): string {
  const safe = path.replace(new RegExp(CONTROL.source, 'g'), '?');
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
}

function shownPartsOf(engine: EngineRoot | null, parts: readonly string[]): string {
  const all = engine === null ? parts : ['engine', engine.repo, ...parts];
  return all.length === 0 ? '.' : shown(all.join('/'));
}

/** The largest file the studio's tools read or write: 16 MB. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** A file's line endings: all LF, all CRLF, both, or no terminator at all. A lone CR is no ending. */
export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none';

/** One line of a text file. */
export interface TextLine {
  /** Its text: without its terminator, and on line 1 without the BOM. A lone CR stays in it. */
  readonly text: string;
  /** Its terminator; '' only on a last line that has none. */
  readonly ending: '' | '\n' | '\r\n';
}

/** A file's text as the studio's tools see it. */
export interface TextFile {
  /** The raw bytes, BOM included. */
  readonly bytes: Buffer;
  /** fileHash of the raw bytes. */
  readonly hash: string;
  readonly bom: boolean;
  readonly eol: LineEnding;
  /** Whether the last line has a terminator; false for an empty file, which has no lines. */
  readonly finalNewline: boolean;
  readonly lines: readonly TextLine[];
}

/** Why bytes are not text: a NUL byte (binary) or bytes that aren't UTF-8. */
export type TextProblem = 'binary' | 'not-utf8';

export type TextRead = { readonly ok: true; readonly file: TextFile } | { readonly ok: false; readonly reason: string };

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** A line's hash: the first 6 hex characters of SHA-256 over its text's UTF-8 bytes. */
export function lineHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 6);
}

/** A file's hash: the first 16 hex characters of SHA-256 over its raw bytes, BOM included. */
export function fileHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** Line `number`'s anchor, `N:hhhhhh`, as the tools print it and edits name it. */
export function anchorOf(number: number, text: string): string {
  return `${number}:${lineHash(text)}`;
}

/**
 * The text in `bytes`, split into lines per FILES-anchor: lines end at LF, a CR just before the LF
 * belongs to the terminator, a lone CR stays in its line, a final terminator makes no extra line,
 * and a UTF-8 BOM is not part of line 1. Any NUL byte means binary; anything else must decode as
 * UTF-8 with no replacement.
 */
export function parseText(bytes: Buffer): TextFile | TextProblem {
  if (bytes.includes(0)) return 'binary';
  const bom = bytes.subarray(0, 3).equals(BOM);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return 'not-utf8';
  }
  const lines: TextLine[] = [];
  let lf = 0;
  let crlf = 0;
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    if (end < 0) {
      lines.push({ text: text.slice(start), ending: '' });
      break;
    }
    if (end > start && text.charCodeAt(end - 1) === 13) {
      lines.push({ text: text.slice(start, end - 1), ending: '\r\n' });
      crlf += 1;
    } else {
      lines.push({ text: text.slice(start, end), ending: '\n' });
      lf += 1;
    }
    start = end + 1;
  }
  const eol: LineEnding = lf > 0 && crlf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : lf > 0 ? 'lf' : 'none';
  return { bytes, hash: fileHash(bytes), bom, eol, finalNewline: lines.length > 0 && lines.at(-1)!.ending !== '', lines };
}

/**
 * Reads the text of a path the layer allowed for reading. It refuses a missing file, a folder, a file
 * over 16 MB (before reading it), binary and non-UTF-8 content, and a file that is not the one the
 * path names when it is opened: after opening, the open file must be the same file (device and file
 * id) that lstat finds at the path, so a file swapped for a link after the walk is refused.
 * shortcut: a folder above the file swapped for a junction between that check and the open is not
 * caught; revisit when a brain with a gateway can make links without also having a shell that reads
 * everything anyway (only Codex has both today).
 */
export function readText(path: AllowedPath): TextRead {
  const denied = path.recheck?.();
  if (denied) return { ok: false, reason: denied };
  if (path.kind === 'missing') return { ok: false, reason: `${path.canonical} not found.` };
  if (path.kind === 'folder') return { ok: false, reason: `${path.canonical} is a folder, not a file.` };
  let fd: number;
  try {
    fd = openSync(path.absolute, 'r');
  } catch (error) {
    return { ok: false, reason: osReason(path.canonical, error) };
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return { ok: false, reason: `${path.canonical} is not a regular file.` };
    const there = lstatSync(path.absolute, { bigint: true });
    if (there.isSymbolicLink() || there.ino !== opened.ino || there.dev !== opened.dev) {
      return { ok: false, reason: `${path.canonical} changed while it was being opened; try again.` };
    }
    if (opened.size > BigInt(MAX_FILE_BYTES)) return { ok: false, reason: tooLarge(path.canonical, opened.size) };
    const bytes = Buffer.alloc(Number(opened.size));
    let filled = 0;
    while (filled < bytes.length) {
      const read = readSync(fd, bytes, filled, bytes.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    // A file that shrank or grew while it was read is not the file whose size was checked.
    if (filled < bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, filled) !== 0) {
      return { ok: false, reason: `${path.canonical} changed while it was being read; try again.` };
    }
    const text = parseText(bytes);
    if (text === 'binary') return { ok: false, reason: `${path.canonical} is a binary file (it holds a NUL byte); the studio's tools read UTF-8 text only.` };
    if (text === 'not-utf8') return { ok: false, reason: `${path.canonical} is not UTF-8 text; the studio's tools read UTF-8 text only.` };
    return { ok: true, file: text };
  } catch (error) {
    return { ok: false, reason: osReason(path.canonical, error) };
  } finally {
    closeSync(fd);
  }
}

function tooLarge(canonical: string, size: bigint): string {
  return `${canonical} is too large: ${(Number(size) / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_FILE_BYTES / (1024 * 1024)} MB the studio's tools read.`;
}

/** Why the OS refused a read, by its error code alone, so no message carries more of the disk than the path. */
function osReason(canonical: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
  if (code === 'ENOENT') return `${canonical} not found.`;
  if (code === 'EISDIR') return `${canonical} is a folder, not a file.`;
  return `${canonical} could not be read (${code}).`;
}

/** A refusal from the writer: the target changed since it was read, it is no longer a path the tools write, or the OS refused. */
export interface WriteRefusal {
  readonly ok: false;
  readonly code: 'STALE' | 'PATH' | 'WRITE_FAILED';
  readonly reason: string;
}

export type WriteResult = { readonly ok: true; readonly file: TextFile } | WriteRefusal;

/**
 * The writer's faults a test injects: its rename; a hook run once the temporary file is written, just
 * before the first check of the target; and one run after each parent folder it makes.
 */
export interface WriterFaults {
  readonly rename?: (from: string, to: string) => void;
  readonly beforeRehash?: () => void | Promise<void>;
  readonly afterMkdir?: (path: string) => void;
}

/** How many times a rename the OS refuses for a moment is tried again, and how far apart: about 100 ms in all. */
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 20;
/** The codes a rename gets while another program (an editor, an indexer, antivirus) holds the target for a moment. */
const RENAME_TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * One promise chain per file, keyed by its real path upper-cased, shared by every session's gateway:
 * the bridge answers a batch of calls at once and the gateway does not serialize built-ins, so a lock
 * per tool instance would let two sessions' writes to one file interleave. An idle file's entry goes.
 */
const locks = new Map<string, Promise<void>>();

/**
 * Runs `work` holding the lock on the file at `absolute` (an allowed path's absolute form): writes to
 * one file, from any session, run one after another in the order they asked. The place in the queue
 * is taken before the first await, so calls made one after another queue in that order.
 */
export async function withFileLock<T>(absolute: string, work: () => Promise<T>): Promise<T> {
  // Upper case, as NTFS compares names: aς.txt and aσ.txt name one file, and lowercasing would queue them apart.
  const key = absolute.toUpperCase();
  const before = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  locks.set(key, tail);
  await before;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Writes `bytes` to the allowed write target `path` atomically; the caller holds its lock
 * (withFileLock). `expected` is the hash the target must still have, or null when it must not exist.
 *
 * Missing parent folders are made one level at a time, each checked to be a real folder, never with a
 * recursive mkdir that could pass through a link made after the path layer's walk, and the target's
 * folder must then resolve to itself, so no folder above it became a link. The bytes go to a temporary
 * file `.<name>.<uuid>.ff-tmp` beside the target, opened with `wx` so it can be neither an existing
 * file nor a link. Just before each try at the rename the target is checked again: not a link, not
 * hard-linked (a rename would quietly split the link), and still `expected` by hash, else STALE. A
 * rename the OS refuses for a moment is tried again; the temporary file is removed whatever happens.
 * shortcut: three moments are not covered: a change to the target between its last check and the
 * rename; a folder above it swapped for a junction between the folder check and the rename, which
 * would put the file where the junction points; and the same swap between makeFolders and opening the
 * temporary file, which would leave the temporary file there until the check refuses and removes it.
 * The first needs a writer outside the studio's tools (a harness edit, a formatter); the swaps need a
 * brain that can make links, and only Codex can, with a shell that already writes anywhere its
 * sandbox allows. Revisit when writes from outside the studio's tools are gone or can take the lock,
 * or when a brain with a gateway can make links without such a shell.
 */
export async function writeAtomic(path: AllowedPath, bytes: Buffer, expected: string | null, faults: WriterFaults = {}): Promise<WriteResult> {
  const target = path.absolute;
  const folder = dirname(target);
  const denied = path.recheck?.();
  if (denied) return { ok: false, code: 'PATH', reason: denied };
  const made = makeFolders(path.canonical, folder, faults.afterMkdir);
  if (made !== null) return made;
  const temp = join(folder, `.${basename(target)}.${randomUUID()}.ff-tmp`);
  try {
    let fd: number;
    try {
      fd = openSync(temp, 'wx', 0o600);
    } catch (error) {
      return writeFailed(path.canonical, error);
    }
    try {
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      // Preserve ordinary permission/executable bits, never propagate set-id bits.
      if (expected !== null && process.platform !== 'win32') fchmodSync(fd, Number(lstatSync(target, { bigint: true }).mode & 0o777n));
      fsyncSync(fd);
    } catch (error) {
      return writeFailed(path.canonical, error);
    } finally {
      closeSync(fd);
    }
    await faults.beforeRehash?.();
    const rename = faults.rename ?? renameSync;
    for (let attempt = 0; ; attempt += 1) {
      // Checked before every try: a rename refused for a moment usually means another program has the
      // target open, and what it writes meanwhile must not be overwritten unseen.
      const denied = path.recheck?.();
      if (denied) return { ok: false, code: 'PATH', reason: denied };
      const changed = changedSince(path.canonical, target, folder, expected, 'write');
      if (changed !== null) return changed;
      try {
        rename(temp, target);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (attempt >= RENAME_RETRIES || !RENAME_TRANSIENT.has(code)) return writeFailed(path.canonical, error);
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
      }
    }
    return { ok: true, file: parseText(bytes) as TextFile };
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Renamed into place, or never made.
    }
  }
}

/** The remover's faults a test injects: its unlink, and a hook run just before the first check of the target. */
export interface RemoverFaults {
  readonly unlink?: (path: string) => void;
  readonly beforeRecheck?: () => void | Promise<void>;
}

/**
 * Deletes the allowed write target `path`, a file whose hash must still be `expected`; the caller holds
 * its lock (withFileLock). Just before each try at the unlink the target is checked again, as the
 * writer checks it before a rename: its folder still resolves to itself (no folder above it has
 * become a link or junction since the path layer's walk), the target is a file and not a link or
 * hard-linked, and it still has `expected` by hash, else STALE. An unlink the OS refuses for a moment
 * is tried again, as a rename is.
 * shortcut: two moments are not covered: a change to the target between its last check and the
 * unlink; and a folder above it swapped for a junction between the folder check and the unlink, which
 * would remove a file of the same name wherever the junction points, outside the worktree included.
 * The first needs a writer outside the studio's tools (a harness edit, a formatter); the swap needs a
 * brain that can make links, and only Codex can, with a shell that already deletes anywhere its
 * sandbox allows. Revisit when writes from outside the studio's tools are gone or can take the lock,
 * or when a brain with a gateway can make links without such a shell.
 */
export async function removeFile(path: AllowedPath, expected: string, faults: RemoverFaults = {}): Promise<{ readonly ok: true } | WriteRefusal> {
  const target = path.absolute;
  const folder = dirname(target);
  await faults.beforeRecheck?.();
  const unlink = faults.unlink ?? unlinkSync;
  for (let attempt = 0; ; attempt += 1) {
    const denied = path.recheck?.();
    if (denied) return { ok: false, code: 'PATH', reason: denied };
    const changed = changedSince(path.canonical, target, folder, expected, 'delete');
    if (changed !== null) return changed;
    try {
      unlink(target);
      return { ok: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      // Gone since the check: the next check says so, as STALE.
      if (code === 'ENOENT' && attempt < RENAME_RETRIES) continue;
      if (attempt >= RENAME_RETRIES || !RENAME_TRANSIENT.has(code)) {
        return { ok: false, code: 'WRITE_FAILED', reason: `${path.canonical} could not be deleted (${code || 'unknown error'}).` };
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

/**
 * Makes the missing folders above a new target, one level at a time down from the deepest that
 * exists, refusing anything on the way that is a link, a junction or not a folder; then checks the
 * target's folder resolves to itself. Null when all is well.
 */
function makeFolders(canonical: string, folder: string, afterMkdir?: (path: string) => void): WriteRefusal | null {
  const missing: string[] = [];
  let at = folder;
  for (;;) {
    const there = folderAt(at);
    if (there === 'folder') break;
    if (there === 'other') return linkRefusal(canonical);
    missing.unshift(at);
    const up = dirname(at);
    if (up === at) return linkRefusal(canonical);
    at = up;
  }
  for (const next of missing) {
    try {
      mkdirSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return writeFailed(canonical, error);
    }
    afterMkdir?.(next);
    // Made by us or by someone else just now: either way it must be a real folder.
    if (folderAt(next) !== 'folder') return linkRefusal(canonical);
  }
  return sameFolder(folder) ? null : linkRefusal(canonical);
}

/** What lstat finds at `path`: a real folder, nothing, or something else (a link, a junction, a file, an error). */
function folderAt(path: string): 'folder' | 'missing' | 'other' {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? 'folder' : 'other';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

/** Whether `folder` is its own real path, so no folder above it is a link or junction. */
function sameFolder(folder: string): boolean {
  const real = realOrNull(folder);
  return real !== null && real.toLowerCase() === folder.toLowerCase();
}

/** Why the target may not be renamed over now: no longer `expected` (STALE), or no longer a path the tools write; null when it may. */
function changedSince(canonical: string, target: string, folder: string, expected: string | null, kind: WriteKind): WriteRefusal | null {
  const now = targetNow(canonical, target, folder, kind);
  if ('code' in now) return now;
  if (expected === null && now.hash !== null) return stale(`${canonical} was made by something else while it was being written; it is now ${now.hash}.`);
  if (expected !== null && now.hash === null) return stale(`${canonical} no longer exists; it was ${expected}.`);
  if (expected !== null && now.hash !== expected) return stale(`${canonical} is ${now.hash}, not ${expected}.`);
  return null;
}

/** The target just before the rename: its hash, or null when it doesn't exist; or why it may no longer be written. */
function targetNow(canonical: string, target: string, folder: string, kind: WriteKind): { hash: string | null } | WriteRefusal {
  if (!sameFolder(folder)) return linkRefusal(canonical);
  let stats: BigIntStats;
  try {
    stats = lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { hash: null };
    return writeFailed(canonical, error);
  }
  if (stats.isSymbolicLink()) return { ok: false, code: 'PATH', reason: `${canonical} is now a link or junction; the studio's tools follow none except engine/<repo>.` };
  if (!stats.isFile()) return { ok: false, code: 'PATH', reason: `${canonical} is now a folder or something else, not a file.` };
  if (stats.nlink > 1n) return { ok: false, code: 'PATH', reason: hardLinked(canonical, stats.nlink, kind) };
  // A file past the cap is not the file whose hash the caller expects, whatever it holds.
  if (stats.size > BigInt(MAX_FILE_BYTES)) return { hash: `a file over ${MAX_FILE_BYTES / (1024 * 1024)} MB` };
  try {
    return { hash: fileHash(readFileSync(target)) };
  } catch (error) {
    return writeFailed(canonical, error);
  }
}

function linkRefusal(canonical: string): WriteRefusal {
  return { ok: false, code: 'PATH', reason: `${canonical}: a folder on its path is now a link, a junction or a file; the studio's tools write through none.` };
}

function stale(reason: string): WriteRefusal {
  return { ok: false, code: 'STALE', reason };
}

/** Why the OS refused a write, by its error code alone, as osReason says for reads. */
function writeFailed(canonical: string, error: unknown): WriteRefusal {
  return { ok: false, code: 'WRITE_FAILED', reason: `${canonical} could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).` };
}

/**
 * The writer's temporary name, `.<name>.<uuid>.ff-tmp`, with the uuid as randomUUID writes it (version
 * 4, lower case), so the sweep removes only names the writer could have made.
 */
const TEMP_NAME = /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.ff-tmp$/;
/** How long the sweep's git listing may run, as the file tools' listings may. */
export const SWEEP_TIMEOUT_MS = 30_000;

/**
 * What a sweep did: the temporary files it removed, and the ones it listed but left (not a plain file,
 * or behind a link), each with a sentence naming it and why, for the studio's report.
 */
export interface Swept {
  readonly removed: readonly string[];
  readonly kept: readonly { readonly name: string; readonly reason: string }[];
}

type SweptOne = { readonly outcome: 'removed' | 'gone' } | { readonly outcome: 'kept'; readonly reason: string };

/**
 * Removes the temporary files writes that died left in the worktree, so none reaches a task's commit or
 * makes the worktree dirty (FILES Implementation Decision 5). Candidates are the untracked, non-ignored
 * files git lists on `place` with git.ts's hardened invocation whose names fit TEMP_NAME: an ignored
 * leftover is neither committed nor counted as dirty, and listing ignored files would walk all of
 * node_modules. git ignores engine/ and never lists inside a link, and each candidate must still pass
 * the path layer for reading in the worktree, with no engine links at all, so the sweep never reaches
 * an engine repo or follows a link. A temporary file exists rightly only while its target's lock is
 * held, so each is unlinked under that lock, if it is still there and still a plain file with one name.
 * Rejects when git can't list the worktree.
 */
export async function sweepTempFiles(place: GitPlace, timeoutMs = SWEEP_TIMEOUT_MS): Promise<Swept> {
  const ran = await runGit(gitArguments(place, ['ls-files', '-z', '--others', '--exclude-standard', '--', ':(glob)**/.*.ff-tmp']), place.worktree, timeoutMs);
  if (ran.code !== 0 || ran.timedOut || ran.overflowed) {
    const why = ran.timedOut ? `it took longer than ${timeoutMs / 1000} s` : ran.overflowed ? 'it listed too much' : `exit code ${ran.code ?? 'none'}: ${(ran.stderr.trim().split('\n')[0] ?? '').slice(0, 300) || 'it gave no reason'}`;
    throw new Error(`Could not look for the studio's leftover temporary files in ${place.worktree}: git ls-files failed (${why}).`);
  }
  // No engine links: a path through engine/<repo> is then a link like any other, and refused.
  const session: FileSession = { worktree: place.worktree, project: null, role: 'implementer' };
  const candidates = ran.stdout.split('\0').filter((name) => TEMP_NAME.test(name.slice(name.lastIndexOf('/') + 1)));
  const outcomes = await Promise.all(candidates.map(async (name) => ({ name, swept: await sweepOne(session, name) })));
  const removed: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const { name, swept } of outcomes) {
    if (swept.outcome === 'removed') removed.push(name);
    if (swept.outcome === 'kept') kept.push({ name, reason: swept.reason });
  }
  return { removed, kept };
}

/** Removes one listed temporary file under its target's lock: removed, already gone, or kept, with why, because it isn't one the sweep may remove. */
async function sweepOne(session: FileSession, name: string): Promise<SweptOne> {
  const target = TEMP_NAME.exec(name.slice(name.lastIndexOf('/') + 1))![1]!;
  const keep = (why: string): SweptOne => ({ outcome: 'kept', reason: `${shown(name)} ${why}` });
  // For reading: a write judgment refuses the temporary name itself. The read rules still refuse
  // links and junctions on the way, .git, engine repos and anything outside the worktree.
  const temp = startCall(session).judge(name, 'read');
  if (!temp.ok) return { outcome: 'kept', reason: temp.reason };
  if (temp.kind === 'missing') return { outcome: 'gone' };
  if (temp.kind !== 'file' || temp.engine !== null) return keep('is not a file in the task worktree.');
  const folder = dirname(temp.absolute);
  // The writer's lock key: its target's absolute form is this folder's real path and the target's name.
  return withFileLock(join(folder, target), async (): Promise<SweptOne> => {
    // Checked again under the lock, as the remover checks before its unlink: the writer may have
    // finished, or the folder or file changed, while the sweep waited.
    for (let attempt = 0; ; attempt += 1) {
      const again = startCall(session).judge(name, 'read');
      if (!again.ok) return { outcome: 'kept', reason: again.reason };
      if (again.kind === 'missing') return { outcome: 'gone' };
      if (again.kind !== 'file' || again.engine !== null || again.absolute !== temp.absolute || !sameFolder(folder)) return keep('changed while the sweep waited for its lock.');
      let stats: BigIntStats;
      try {
        stats = lstatSync(temp.absolute, { bigint: true });
      } catch {
        return { outcome: 'gone' };
      }
      if (stats.isSymbolicLink()) return keep('is a link or junction; the sweep removes plain files only.');
      if (!stats.isFile()) return keep('is not a plain file; the sweep removes plain files only.');
      if (stats.nlink > 1n) return keep(`is hard-linked (${stats.nlink} links); the sweep removes files with one name only.`);
      try {
        unlinkSync(temp.absolute);
        return { outcome: 'removed' };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'ENOENT') return { outcome: 'gone' };
        if (attempt >= RENAME_RETRIES || !RENAME_TRANSIENT.has(code)) return keep(`could not be removed (${code || 'unknown error'}).`);
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS));
      }
    }
  });
}
