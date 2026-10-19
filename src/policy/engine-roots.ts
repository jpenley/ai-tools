// Read-only engine-link recognition, extracted from Factory Floor. No link mutation lives here.

import { spawnSync } from 'node:child_process';

import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';

import { dirname, isAbsolute, join, resolve } from 'node:path';

type GitCommandSeen = (args: readonly string[], cwd: string, outcome: number | string) => void;

export const LINK_GIT_TIMEOUT_MS = 5_000;

/** What a git command linking ran gave back, as spawnSync gives it. */
export type GitRun = { readonly status: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string; readonly error?: Error };

/** Runs git with `args` in `cwd`, ending it after `timeoutMs`; spawnSync unless a test stands in. */
export type RunGit = (args: readonly string[], cwd: string, timeoutMs: number) => GitRun;

const runGit: RunGit = (args, cwd, timeoutMs) => spawnSync('git', args, {
  cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: ownRepoEnvironment(),
});

const TIMED_OUT = `took over ${LINK_GIT_TIMEOUT_MS / 1000} seconds and was ended`;

/**
 * A git command linking ran that gave no usable answer, named with how it ended ("exited 128:
 * fatal: ..."), so a caller can refuse rather than read its silence as a pass.
 */
export class LinkGitFailed extends Error {
  /** The folder git ran in, which a refusal names as the one to fix when git failed there. */
  readonly cwd: string;

  constructor(args: readonly string[], cwd: string, ended: string) {
    // Named without the safe.directory settings, which only say which folder git may trust.
    const shown = args.filter((arg, i) => arg !== '-c' && args[i - 1] !== '-c').join(' ');
    super(`git ${shown} in ${cwd} ${ended}`);
    this.cwd = cwd;
  }
}

/** A git command linking ran that took over LINK_GIT_TIMEOUT_MS: its answer is unknown, so it never counts as a pass. */
export class GitTimedOut extends LinkGitFailed {
  constructor(args: readonly string[], cwd: string) {
    super(args, cwd, TIMED_OUT);
  }
}

/** How a git command that didn't succeed ended: its exit code and first line of stderr, or what kept it from running. */
function endedText(run: GitRun): string {
  if (run.status !== null) {
    const said = run.stderr.trim().split(/\r?\n/)[0] ?? '';
    return `exited ${run.status}${said === '' ? '' : `: ${said}`}`;
  }
  return run.error === undefined ? `was ended by ${run.signal}` : `could not run: ${run.error.message}`;
}

/** Runs one git command for linking under the time limit, telling `seen` how it ended; throws GitTimedOut past the limit. */
function linkGit(args: readonly string[], cwd: string, git: RunGit, seen?: GitCommandSeen): GitRun {
  const run = git(args, cwd, LINK_GIT_TIMEOUT_MS);
  const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  // An exit code as a number, anything else as words, so a printer never says "exit" for a hang.
  seen?.(args, cwd, timedOut ? TIMED_OUT : run.status ?? endedText(run));
  if (timedOut) throw new GitTimedOut(args, cwd);
  return run;
}

/**
 * The trimmed output of a git command run under the time limit, as engine:link asks for its
 * checkout; throws GitTimedOut past the limit and LinkGitFailed when it doesn't succeed.
 */
export function gitOutput(args: readonly string[], cwd: string, git: RunGit = runGit): string {
  const run = linkGit(args, cwd, git);
  if (run.status !== 0) throw new LinkGitFailed(args, cwd, endedText(run));
  return run.stdout.trim();
}



export const REPO_ID = /^[a-z][a-z0-9-]*$/;

export function engineDeclaration(checkout: string): { repos: string[]; refusals: string[] } {
  let text: string;
  try {
    text = readFileSync(join(checkout, 'package.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { repos: [], refusals: [] };
    throw error;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error(`${join(checkout, 'package.json')} is not valid JSON.`);
  }
  const fields = (manifest ?? {}) as { engine?: { repos?: unknown }; engines?: { repos?: unknown } };
  const repos: string[] = [], refusals: string[] = [];
  if (fields.engines?.repos !== undefined) {
    refusals.push('package.json has engines.repos, in npm\'s engines field; engine repos are declared as engine.repos, so this is likely a typo');
  }
  const declared = fields.engine?.repos;
  if (declared === undefined) return { repos, refusals };
  if (!Array.isArray(declared)) {
    refusals.push(`engine.repos in package.json is ${JSON.stringify(declared)}, not a list of repo names`);
    return { repos, refusals };
  }
  for (const entry of declared) {
    if (typeof entry === 'string') repos.push(entry);
    else refusals.push(`engine.repos entry ${JSON.stringify(entry)} is not a repo name`);
  }
  return { repos, refusals };
}

export function declaredEngineRepos(checkout: string): string[] {
  return engineDeclaration(checkout).repos;
}

export function keptTarget(link: string, repoFolder: string, seen?: GitCommandSeen, git: RunGit = runGit): string | null {
  try {
    return checkedTarget(link, repoFolder, git, seen);
  } catch {
    return null;
  }
}

function checkedTarget(link: string, repoFolder: string, git: RunGit, seen?: GitCommandSeen): string | null {
  let real: string;
  try {
    const reached = reachedFrom(link);
    if (reached === null) return null;
    real = realpathSync.native(reached);
  } catch {
    return null;
  }
  return isEngineCheckout(real, repoFolder, git, seen) ? real : null;
}

function isEngineCheckout(real: string, repoFolder: string, git: RunGit, seen?: GitCommandSeen): boolean {
  // Windows folders are the same folder whatever their case.
  const same = (folder: string): boolean => {
    try { return realpathSync.native(folder).toLowerCase() === real.toLowerCase(); } catch { return false; }
  };
  if (same(repoFolder)) return true;
  if (!existsSync(join(repoFolder, '.git'))) return false;
  const args = ['-c', `safe.directory=${repoFolder.replaceAll('\\', '/')}`, 'worktree', 'list', '--porcelain', '-z'];
  const listed = linkGit(args, repoFolder, git, seen);
  if (listed.status !== 0) throw new LinkGitFailed(args, repoFolder, endedText(listed));
  // -z ends each field with NUL, so a folder name holding a newline can't split an entry. A gone folder fails same().
  return listed.stdout.split('\0').some((field) => field.startsWith('worktree ') && same(field.slice('worktree '.length)));
}

export function ownRepoEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pointers = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']);
  // Windows names variables whatever their case, so a gIt_DiR points git too.
  return Object.fromEntries(Object.entries(env).filter(([name]) => !pointers.has(name.toUpperCase())));
}

function reachedFrom(path: string): string | null {
  const stored = readlinkSync(path);
  if (isAbsolute(stored)) return null;
  const reached = resolve(dirname(path), stored);
  return statSync(reached).isDirectory() ? reached : null;
}
