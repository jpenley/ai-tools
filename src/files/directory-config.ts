import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseText, startCall } from './files.ts';
import { readBytes } from './core/filesystem.ts';
import { containsDirectory, PERMISSIONS_FILE, type DirectoryConfig, type DirectoryConfigLayer } from './directory-permissions.ts';
export { PERMISSIONS_FILE } from './directory-permissions.ts';

/** Startup-only, bounded configuration read; never a callable MCP tool. */
export function readDirectoryConfig(worktree: string, path: string): { config: unknown; path: string } {
  if (!isAbsolute(path)) throw new Error('Permissions options must name absolute JSON files.');
  const allowed = startCall({ worktree, project: null, role: 'reader', externalRead: true }).judge(path, 'read');
  if (!allowed.ok) throw new Error(`Invalid permissions file: ${allowed.reason}`);
  if (allowed.throughLink) throw new Error('Permissions configuration paths must not traverse symlinks/junctions.');
  const bytes = readBytes(allowed, 64 * 1024).bytes;
  if (typeof parseText(bytes) === 'string') throw new Error('Permissions file must be UTF-8 JSON.');
  let config: unknown;
  try { config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Invalid directory permissions JSON.'); }
  return { config, path: allowed.absolute };
}

export interface DiscoveryOptions {
  /** Explicit --permissions replaces the project location, not the global layer. */
  readonly projectPath?: string;
  readonly globalPath?: string;
  /** Test/embedding seam; standalone startup uses the owner's home directory. */
  readonly home?: string;
}

/** Inspect project first, then global. Invalid existing sources fail closed.
 * Missing automatic files are optional; missing explicit files are errors.
 * Reserve even absent discovery locations so agents cannot install future grants.
 */
export function readDirectoryConfigs(worktree: string, options: DiscoveryOptions = {}): DirectoryConfig {
  const projectDefault = join(worktree, '.mcp-config', PERMISSIONS_FILE);
  const globalDefault = join(options.home ?? homedir(), '.mcp-config', PERMISSIONS_FILE);
  if (options.projectPath !== undefined && !containsDirectory(resolve(worktree), resolve(options.projectPath))) throw new Error('--permissions is project-scoped and must be inside this server root; do not reuse another project\'s permissions file.');
  const projectPath = options.projectPath ?? projectDefault;
  const globalPath = options.globalPath ?? globalDefault;
  for (const path of [projectPath, globalPath]) if (!isAbsolute(path)) throw new Error('Permissions options must name absolute JSON files.');
  const read = (path: string, required: boolean): DirectoryConfigLayer | undefined => {
    try { lstatSync(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!required && (code === 'ENOENT' || code === 'ENOTDIR')) return undefined;
      throw new Error(`Could not inspect permissions configuration (${code ?? 'unknown error'}): ${path}`);
    }
    return readDirectoryConfig(worktree, path);
  };
  const project = read(projectPath, options.projectPath !== undefined);
  const global = read(globalPath, options.globalPath !== undefined);
  return {
    ...(project ?? { config: { directories: [] } }),
    ...(global === undefined ? {} : { fallbacks: [global] }),
    protectedPaths: [...new Set([projectDefault, globalDefault, projectPath, globalPath].map(path => resolve(path)))],
  };
}
