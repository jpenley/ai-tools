import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { mainCheckoutOf } from '../policy/path-rules.ts';
import { serveMcp } from './stdio.ts';
import { toolAccess, writableAccess } from '../shared/access.ts';
import { fileServerTools } from '../files/file-server.ts';
import { readDirectoryConfigs } from '../files/directory-config.ts';
import { gitDirOf, gitTool, runGit } from '../git/git.ts';
import { linkedRootProblem } from '../git/worktree-safety.ts';
import { locateRipgrep } from '../files/search-files.ts';
import { createToolRegistry } from '../registry.ts';

/** Independent stdio servers. Only startup arguments select the root and access. */
export async function startToolServer(kind: 'files' | 'git', args = process.argv.slice(2)): Promise<void> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!['--root', '--access', '--git', '--ripgrep', ...(kind === 'files' ? ['--permissions', '--global-permissions'] : [])].includes(name) || value === undefined || options.has(name)) throw new Error('Expected unique --root, --access and optional --git/--ripgrep arguments; Files also supports project-scoped --permissions and --global-permissions.');
    options.set(name, value);
  }
  const root = options.get('--root');
  if (root === undefined || !isAbsolute(root)) throw new Error(`Usage: node src/${kind}/server.ts --root <absolute-repo> --access <deny|read-only|full|super> [--git <absolute-executable>] [--ripgrep <absolute-executable>]${kind === 'files' ? ' [--permissions <project-json-file>] [--global-permissions <global-json-file>]' : ''}`);
  const access = toolAccess(options.get('--access'));
  const executable = (value: string): string => {
    if (!isAbsolute(value) || !statSync(value).isFile()) throw new Error('Executable paths must name absolute files.');
    return realpathSync(value);
  };
  // Some MCP hosts deliberately give servers no PATH. The owner can name Git at load time;
  // putting its folder first also serves the existing engine-root and file-listing code.
  const git = options.get('--git');
  if (git !== undefined) {
    const selected = executable(git);
    const name = process.platform === 'win32' ? basename(selected).toLowerCase() : basename(selected);
    if (name !== (process.platform === 'win32' ? 'git.exe' : 'git')) throw new Error('--git must name git.exe on Windows, or git on other systems.');
    process.env['PATH'] = `${dirname(selected)}${delimiter}${process.env['PATH'] ?? ''}`;
  }
  const rg = options.get('--ripgrep');
  const ripgrep = rg === undefined ? null : executable(rg);
  if (writableAccess(access)) {
    const problem = linkedRootProblem(root);
    if (problem !== null) throw new Error(problem);
  }
  const worktree = realpathSync(root);
  const gitDir = await gitDirOf(worktree);
  const top = await runGit(['-C', worktree, 'rev-parse', '--show-toplevel'], worktree);
  const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
  if (top.code !== 0 || key(realpathSync(top.stdout.trim())) !== key(worktree)) throw new Error('--root must name the repository or worktree root, not a subfolder.');
  const permissionsPath = options.get('--permissions');
  const globalPermissionsPath = options.get('--global-permissions');
  const directoryConfig = kind === 'files' ? readDirectoryConfigs(worktree, { ...(permissionsPath === undefined ? {} : { projectPath: permissionsPath }), ...(globalPermissionsPath === undefined ? {} : { globalPath: globalPermissionsPath }) }) : undefined;
  const scratch = mkdtempSync(join(tmpdir(), `ai-tools-${kind}-mcp-`));
  const hooksPath = join(scratch, 'no-hooks');
  mkdirSync(hooksPath);
  const place = Object.freeze({ worktree, gitDir, hooksPath });
  const cleanup = (): void => { rmSync(scratch, { recursive: true, force: true }); };
  process.once('exit', cleanup);
  const gateway = createToolRegistry(kind === 'git' ? (access === 'deny' ? [] : [gitTool(place, access)]) : fileServerTools({ worktree, project: mainCheckoutOf(worktree), ...(directoryConfig === undefined ? {} : { directoryConfig }) }, place, access, ripgrep ?? locateRipgrep(message => { process.stderr.write(`${message}\n`); })));
  serveMcp({
    name: `ai-tools-${kind}`,
    instructions: `Access: ${access}. Fixed at load for ${worktree}; changing access requires an owner restart.${directoryConfig === undefined ? '' : ' Project settings at server-root/.mcp-config/ai-tools-files-permissions.json precede global ~/.mcp-config/ai-tools-files-permissions.json. Most-specific directory wins; project wins equal-path ties. Settings are fixed until restart. deny exposes no tools; read-only forbids writes; full is project-scoped; super adds external reads except settings denials and protected paths. stat_path reports effective rules/sources. Session grants require explicit user approval via the client and cannot override settings or hard ceilings.'}`,
    tools: async () => gateway.tools,
    call: (tool, arguments_, context) => gateway.call({ tool, arguments: arguments_ }, context),
    disconnect: () => { void gateway.close(); },
    close: () => { void gateway.close().finally(cleanup); },
  });
}
