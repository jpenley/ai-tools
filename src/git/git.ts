// Shared Git tool for standalone MCP servers and embedded studio sessions.
// Startup captures the root and read-only/full mode. Git runs without a shell,
// hooks, signing, interactive editors or caller-selected helper programs.
// Read-only mode also prevents missing objects from being fetched implicitly.
import { execFile } from 'node:child_process';
import { linkedRootProblem, worktreeWriteProblem } from './worktree-safety.ts';
import type { GatewayTool, ToolReply } from '../contract.ts';
import type { BuiltInTool } from '../contract.ts';
import { listArgument } from '../shared/arguments.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';
import { GitOutputPages, GIT_MAX_BYTES, GIT_MAX_LINES } from './output-pages.ts';
import { toolAccess, type ToolAccess } from '../shared/access.ts';

export type GitVerdict = { readonly kind: 'allow' } | { readonly kind: 'block'; readonly reason: string };

/** Why the git tool refuses git that commits, stages or undoes work. */
const COMMITS = 'The studio commits your work when you end your turn: committing, staging and undoing commits are not available.';
/** Why the git tool refuses git that switches or makes branches. */
const BRANCHES = "The studio keeps you on the task's branch: switching, making and deleting branches are not available.";
/** Why the git tool refuses git that brings in other work. */
const UPDATES = 'The studio brings your branch up to date with its base itself: merging, rebasing, cherry-picking and fetching are not available.';
/** Why the git tool refuses git that reaches a remote. */
const REMOTES = 'There is no remote to reach: pushing, pulling and cloning are not available.';
/** Why the git tool refuses any other git that isn't read-only. */
const READ_ONLY = 'Only read-only git is available.';
/** Why each git subcommand that changes something is refused. */
const REFUSED_BECAUSE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['add', 'commit', 'commit-tree', 'mv', 'reset', 'restore', 'revert', 'rm', 'stash', 'clean', 'update-index', 'update-ref', 'write-tree', 'read-tree', 'notes', 'replace', 'filter-branch', 'tag'].map((name) => [name, COMMITS])),
  ...Object.fromEntries(['branch', 'checkout', 'switch', 'symbolic-ref', 'worktree'].map((name) => [name, BRANCHES])),
  ...Object.fromEntries(['merge', 'rebase', 'cherry-pick', 'am', 'apply', 'bisect', 'fetch'].map((name) => [name, UPDATES])),
  ...Object.fromEntries(['push', 'pull', 'clone', 'remote', 'submodule', 'init'].map((name) => [name, REMOTES])),
};

/** The git subcommands the git tool runs: they only read. `branch` is here in its listing forms only. */
const READ_GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'branch']);
/** Full access still pins the repository and keeps execution/configuration out of the tool. */
const WRITE_GIT = new Set(['add', 'commit', 'mv', 'reset', 'restore', 'revert', 'rm', 'stash', 'clean', 'tag', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'fetch', 'push', 'pull']);

/** `git branch` arguments that only list. */
const BRANCH_LISTING = new Set(['--list', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose']);
/**
 * Long options the git tool refuses wherever they appear: they write files (--output), run
 * programs (--ext-diff, --textconv, --open-files-in-pager, --exec, --upload-pack…, --filters),
 * read files outside git (--no-index, --contents), or point git elsewhere (--git-dir…). A prefix
 * of one is refused too: git takes an unambiguous abbreviation of a long option.
 */
const REFUSED_LONG = ['--output', '--open-files-in-pager', '--ext-diff', '--textconv', '--no-index', '--exec', '--exec-path', '--config-env', '--git-dir', '--work-tree', '--namespace', '--upload-pack', '--receive-pack', '--contents', '--filters'];
/** Long options that are a prefix of a refused one but are options of their own, which git matches exactly. */
const EXACT_LONG = new Set(['--text']);
// File-input options are not pathspecs and bypass repository/credential authorization.
// Require inline messages/patterns instead. Includes Git's unambiguous abbreviations.
const FILE_INPUT_LONG = ['--file', '--template', '--pathspec-from-file', '--exclude-from', '--exclude-per-directory', '--revs-file', '--ignore-revs-file', '--resolve-git-dir'];
const FILE_INPUT_SHORT: Readonly<Record<string, string>> = { grep: 'f', commit: 'Ft', tag: 'F', merge: 'F', 'ls-files': 'X', blame: 'S' };
const SHORT_VALUE_FLAGS: Readonly<Record<string, string>> = { grep: 'efABCmO', commit: 'mFCctu', tag: 'mFu', merge: 'mFsX', 'ls-files': 'xX', blame: 'LSCM' };
function fileInputArgument(subcommand: string, arg: string): boolean {
  if (arg.startsWith('--')) {
    const name = arg.split('=')[0]!;
    if ((subcommand === 'ls-files' && name === '--exclude') || (subcommand === 'blame' && name === '--ignore-rev')) return false;
    return name.length >= 3 && FILE_INPUT_LONG.some(option => option.startsWith(name));
  }
  if (!/^-[^-]/.test(arg)) return false;
  for (const letter of arg.slice(1)) {
    if ((FILE_INPUT_SHORT[subcommand] ?? '').includes(letter)) return true;
    // The rest is an attached option value, not a bundle of short switches.
    if ((SHORT_VALUE_FLAGS[subcommand] ?? '').includes(letter)) return false;
  }
  return false;
}

/** How long one git call may run. */
const GIT_TIMEOUT_MS = 60_000;
/** The most git may print before the rest is dropped unread. */
const GIT_BUFFER = 16 * 1024 * 1024;
/** Subcommands that show diffs: never through an external diff program or a textconv filter. */
const SHOWS_DIFFS = new Set(['diff', 'log', 'show']);

/** The git tool as the gateway offers it, by the same name to every harness. */
export const GIT_TOOL: GatewayTool = {
  name: 'git',
  annotations: { readOnlyHint: true, openWorldHint: false },
  description:
    'Run read-only git in your working folder. Give args: the git subcommand first, then its arguments, e.g. ["log", "--oneline", "-5"] or ["diff", "--stat"]. ' +
    'Allowed: status, diff, log, show, blame, grep, ls-files, ls-tree, rev-parse, describe, shortlog, cat-file, worktree list, and branch to list branches (no arguments, --list, --show-current, -a, -r, -v, -vv, --contains <rev>). The args go straight to git, with no shell: no pipes, redirects or quoting. ' +
    'No global options (-C, -c, --git-dir…), and no --output, --ext-diff, --textconv, --no-index or -O. ' +
    `Output is paginated at ${GIT_MAX_LINES} lines or ${GIT_MAX_BYTES / 1024} KiB. Continue with the returned cursor and no args; this never reruns Git. full:true returns all remaining output uncut, retaining the 16 MiB process buffer and 60 s timeout. Cursors expire after 5 minutes or eviction (4 results / 32 MiB per connection). This server was loaded read-only. Staging, commits and branch changes require a new server loaded with full access.`,
  inputSchema: {
    type: 'object',
    properties: {
      args: { type: 'array', items: { type: 'string' }, description: 'The git subcommand, then its arguments; no global options. Required for a new command; omit when continuing with cursor.' },
      cursor: { type: 'string', description: 'Opaque output continuation from this connection. Supply without args to read the completed command snapshot, never to rerun it. Omit for a new command.' },
      full: fullOutputProperty,
    },
    oneOf: [{ required: ['args'], not: { required: ['cursor'] } }, { required: ['cursor'], not: { required: ['args'] } }],
  },
};

/** The git tool's verdict on one call's args: read-only subcommands, with no argument that writes, runs programs or points git elsewhere. */
export function gitVerdict(raw: unknown, access: ToolAccess = 'read-only'): GitVerdict {
  if (access === 'deny') return { kind: 'block', reason: 'Git access is denied by server startup policy.' };
  if (access === 'super') access = 'full';
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((arg): arg is string => typeof arg === 'string')) {
    return { kind: 'block', reason: 'Give the git tool args: a list of strings, the git subcommand first, such as ["log", "--oneline", "-5"]. They go straight to git, with no shell: no pipes or quoting.' };
  }
  const [subcommand, ...args] = raw as [string, ...string[]];
  if (subcommand.startsWith('-')) return { kind: 'block', reason: `The git tool takes no global options (${subcommand}): give the subcommand first.` };
  // Listing worktrees only reads.
  const listsWorktrees = subcommand === 'worktree' && args.length >= 1 && args[0] === 'list' && args.slice(1).every((arg) => arg === '--porcelain' || arg === '-v' || arg === '--verbose');
  const writing = access === 'full' && WRITE_GIT.has(subcommand);
  if (!READ_GIT.has(subcommand) && !listsWorktrees && !writing) return { kind: 'block', reason: REFUSED_BECAUSE[subcommand] ?? READ_ONLY };
  // After the subcommand, switch/branch use -c/-C to create or copy a branch,
  // and commit uses them to reuse a message. They are not Git's global config/root options.
  if (args.some(arg => fileInputArgument(subcommand, arg))) return { kind: 'block', reason: 'File-input options are disabled: use inline messages/patterns and explicit repository pathspecs, not file/template/pattern/pathspec input files.' };
  const refused = args.find(arg => !(access === 'full' && ['switch', 'branch', 'commit'].includes(subcommand) && (arg === '-c' || arg === '-C')) && refusedGitArgument(arg));
  if (refused !== undefined) return { kind: 'block', reason: `The git tool refuses ${refused}: it writes files, runs programs or points git elsewhere.` };
  if (args.some((arg) => /[|<>]/.test(arg) && arg.trim().length <= 2)) return { kind: 'block', reason: `The git tool runs git with no shell, so ${args.find((arg) => /[|<>]/.test(arg))} is not a pipe or redirect: give only git's own arguments.` };
  if (access === 'full' && subcommand === 'rebase' && args.some(arg => /^-[^-]*x/.test(arg))) return { kind: 'block', reason: 'Git commands cannot execute a supplied program (-x).'};
  if (access === 'full' && args.some(arg => {
    const name = arg.split('=')[0]!;
    return (name.startsWith('--') && name.length > 2 && ['--gpg-sign', '--sign', '--signed', '--local-user'].some(option => option.startsWith(name))) || /^-[^-]*S/.test(arg) || (subcommand === 'tag' && /^-[^-]*[su]/.test(arg));
  })) return { kind: 'block', reason: 'Signing is disabled for this Git server.' };
  if (access === 'full' && ['merge', 'rebase', 'pull'].includes(subcommand) && args.some(arg => {
    const name = arg.split('=')[0]!;
    return /^-[^-]*s/.test(arg) || (name.startsWith('--') && name.length >= 4 && '--strategy'.startsWith(name));
  })) return { kind: 'block', reason: 'Caller-selected merge strategies are disabled: Git can load an external strategy program.' };
  if (access === 'full' && ['fetch', 'push', 'pull'].includes(subcommand) && args.some(arg => {
    const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    const scheme = /^([a-z0-9][a-z0-9+.-]*):\/\//i.exec(value)?.[1];
    return /^[a-z0-9][a-z0-9+.-]*::/i.test(value) || (scheme !== undefined && !['https', 'http', 'ssh', 'git', 'file'].includes(scheme));
  })) return { kind: 'block', reason: 'Explicit remote helper programs are not allowed; use a configured remote, local path or a standard Git URL.' };
  if (access === 'full' && args.some(arg => arg === '--config' || arg.startsWith('--config=') || arg === '--config-env' || arg.startsWith('--config-env='))) return { kind: 'block', reason: 'Git configuration cannot be changed through command arguments.' };
  if (subcommand === 'branch' && access !== 'full' && !branchListing(args)) return { kind: 'block', reason: BRANCHES };
  return { kind: 'allow' };
}

/** Whether a git argument writes files, runs programs or points git elsewhere, wherever it appears. */
function refusedGitArgument(arg: string): boolean {
  if (arg === '-c' || arg === '-C') return true;
  // -O[<pager>] (grep's open-files-in-pager), alone or among other short options.
  if (/^-[^-]*O/.test(arg)) return true;
  if (!arg.startsWith('--')) return false;
  const name = arg.split('=')[0]!;
  if (EXACT_LONG.has(name)) return false;
  return REFUSED_LONG.some((refused) => refused === name || (name.length >= 4 && refused.startsWith(name)));
}

/** Whether `git branch` with these arguments only lists. */
function branchListing(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (BRANCH_LISTING.has(arg)) continue;
    if (/^--contains=[^-]/.test(arg)) continue;
    if (arg === '--contains' && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/** Where the git tool runs git: the studio's git folder for the worktree, the worktree, and an empty hooks folder. */
export interface GitPlace {
  readonly gitDir: string;
  readonly worktree: string;
  readonly hooksPath: string;
}

/** git's whole command line for one call of the git tool: `args` is the subcommand and its arguments. */
export function gitArguments(place: GitPlace, args: readonly [string, ...string[]]): string[] {
  const [subcommand, ...rest] = args;
  return [
    '--no-pager',
    `--git-dir=${place.gitDir}`,
    `--work-tree=${place.worktree}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.symlinks=false',
    '-c', `core.hooksPath=${place.hooksPath}`,
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=never',
    '-c', 'core.quotePath=false',
    subcommand,
    ...(SHOWS_DIFFS.has(subcommand) ? ['--no-ext-diff', '--no-textconv'] : []),
    ...rest,
  ];
}

/**
 * The git tool for a session in `worktree`, on the git folder git finds for it now; `hooksPath` is
 * an empty folder. Only tests use it: session start builds one GitPlace and calls gitTool(place), so
 * the file tools share the same folder.
 */
export async function gitToolFor(worktree: string, hooksPath: string): Promise<BuiltInTool> {
  return gitTool({ gitDir: await gitDirOf(worktree), worktree, hooksPath });
}

/** The git tool on `place`. */
export function gitTool(place: GitPlace, access: ToolAccess = 'read-only'): BuiltInTool {
  const selected = toolAccess(access);
  if (selected === 'deny') return { tool: { ...GIT_TOOL, description: 'Git is disabled by deny startup policy.' }, async call() { return answer(false, 'Git access is denied by server startup policy.'); } };
  const mode = selected === 'super' ? 'full' : selected;
  const fixedPlace = Object.freeze({ ...place });
  const output = new GitOutputPages();
  return {
    tool: mode === 'read-only' ? GIT_TOOL : { ...GIT_TOOL, description: `Run Git in the fixed repository with full access. Reads and writes are allowed: ${[...READ_GIT, ...WRITE_GIT].join(', ')}. Give args: subcommand, then its arguments. No shell, global options, alternate git directories, supplied programs, file-input options, configuration changes or external diff. Owner-configured helpers/filters/transports remain trusted. Git checks out symlinks as ordinary files; link creation is disabled. Working-tree-changing commands conservatively refuse trees containing existing links (including ignored links). Hooks, signing and interactive editors are disabled. Access is fixed when this server starts. Output is paginated at ${GIT_MAX_LINES} lines or ${GIT_MAX_BYTES / 1024} KiB. Continue with cursor and no args to read a snapshot without rerunning the command. full:true returns all remaining output uncut; the 16 MiB process buffer and 60 s timeout still apply. Cursors expire after 5 minutes or eviction (4 results / 32 MiB per connection).`, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
    async call(input): Promise<ToolReply> {
      const full = fullOutputArgument(input['full']);
      if (full === null) return answer(false, 'full must be true or false.');
      if (input['cursor'] !== undefined) {
        if (typeof input['cursor'] !== 'string' || input['cursor'] === '' || input['args'] !== undefined) return answer(false, 'Supply cursor alone (optionally full), without args; continuation never executes a command.');
        return output.continue(input['cursor'], full);
      }
      const given = listArgument(input['args']);
      const verdict = gitVerdict(given, mode);
      if (verdict.kind === 'block') return answer(false, verdict.reason);
      const args = given as [string, ...string[]];
      const subcommand = args[0];
      const rootProblem = mode === 'full' && (WRITE_GIT.has(subcommand) || subcommand === 'branch') ? linkedRootProblem(fixedPlace.worktree) : null;
      if (rootProblem !== null) return answer(false, rootProblem);
      const linkProblem = mode === 'full' ? worktreeWriteProblem(fixedPlace.worktree, subcommand) : null;
      if (linkProblem !== null) return answer(false, linkProblem);
      const argv = gitArguments(fixedPlace, args);
      if (mode === 'full') argv.splice(1, 0, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'tag.forceSignAnnotated=false', '-c', 'push.gpgsign=false');
      const ran = await runGit(argv, fixedPlace.worktree, GIT_TIMEOUT_MS, mode === 'full' ? { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_NO_LAZY_FETCH: '0' } : {});
      if (ran.timedOut) return answer(false, `git ${subcommand} took longer than ${GIT_TIMEOUT_MS / 1000} s and was stopped.`);
      if (ran.overflowed) return answer(false, 'Git output exceeded the 16 MiB process buffer; no complete output snapshot is available. The command may have changed repository or remote state; inspect state before retrying. Narrow read-only commands.');
      // Exit code 1 with nothing on stderr is an answer, not a failure: grep found nothing, diff --exit-code found changes.
      if (ran.code === 0 || (gitVerdict(given).kind === 'allow' && ran.code === 1 && ran.stderr.trim() === '')) {
        const text = ran.stdout !== '' ? ran.stdout : ran.code === 1 ? `git ${subcommand} found nothing (exit code 1).` : (ran.stderr.trim() || `git ${subcommand} printed nothing.`);
        return output.present(true, text, full);
      }
      return output.present(false, `git ${subcommand} failed (exit code ${ran.code ?? 'none'}): ${(ran.stderr.trim() || ran.stdout.trim() || 'it gave no reason.')}`, full);
    },
  };
}

/** The worktree's git folder, absolute, as git finds it from the worktree now. */
export async function gitDirOf(worktree: string): Promise<string> {
  const ran = await runGit(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-dir'], worktree);
  const gitDir = ran.stdout.trim();
  if (ran.code === 0 && gitDir !== '') return gitDir;
  throw new Error(`Could not find the git folder of the worktree ${worktree}: ${ran.stderr.trim() || 'git printed nothing.'}`);
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}

export interface GitRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** git printed more than the buffer holds: the rest was dropped. */
  readonly overflowed: boolean;
}

/**
 * Runs git, with no shell, no prompt for credentials and no optional locks, and none of the
 * environment's GIT_* settings; `extraEnv` adds the caller's own on top. The git tool allows 60 s;
 * the file tools' listings allow 30 s (FILES Implementation Decision 10).
 */
export function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS, extraEnv: Readonly<Record<string, string>> = {}): Promise<GitRun> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.toUpperCase().startsWith('GIT_')) env[name] = value;
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_NO_LAZY_FETCH'] = '1';
  Object.assign(env, extraEnv);
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: GIT_BUFFER, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
      const overflowed = failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolve({
        code: failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null,
        stdout: String(stdout),
        stderr: String(stderr),
        timedOut: failure !== null && failure.killed === true && !overflowed,
        overflowed,
      });
    });
  });
}
