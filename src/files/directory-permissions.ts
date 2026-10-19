import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SessionDirectoryGrants } from './session-grants.ts';

export const PERMISSIONS_FILE = 'ai-tools-files-permissions.json';
export type DirectoryAccess = 'deny' | 'read-only' | 'full';
export interface DirectoryRule { readonly path: string; readonly access: DirectoryAccess; readonly source?: string }
export interface DirectoryConfigLayer { readonly config: unknown; readonly path?: string }
export interface DirectoryConfig extends DirectoryConfigLayer {
  /** Lower-priority sources; specificity still beats source priority. */
  readonly fallbacks?: readonly DirectoryConfigLayer[];
  /** Reserved discovery locations, including missing files, cannot be agent-created. */
  readonly protectedPaths?: readonly string[];
}
export interface EffectivePermission {
  readonly access: DirectoryAccess;
  readonly rule: DirectoryRule | null;
  readonly capped_by_global_read_only: boolean;
  readonly capped_by_link?: true;
}
interface PinnedRule extends DirectoryRule { readonly identity: string }
const key = (path: string): string => process.platform === 'win32' ? path.toUpperCase() : path;
export function containsDirectory(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Owner-selected, validated once, deeply frozen. No MCP tool can add a rule. */
export class DirectoryPermissions {
  readonly rules: readonly PinnedRule[];
  readonly configPath: string | undefined;
  readonly configPaths: readonly string[];
  readonly sessionGrants: SessionDirectoryGrants | undefined;
  constructor(config: unknown, validateRoot: (path: string) => string, configPath?: string, fallbacks: readonly DirectoryConfigLayer[] = [], protectedPaths: readonly string[] = [], sessionGrants?: SessionDirectoryGrants) {
    this.sessionGrants = sessionGrants;
    if (fallbacks.length > 1) throw new Error('At most a project/explicit and a global permissions source are supported.');
    const sources = [{ config, ...(configPath === undefined ? {} : { path: configPath }) }, ...fallbacks];
    const merged = new Map<string, PinnedRule>();
    for (const layer of sources) {
      const value = layer.config;
      if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => name !== 'directories')) throw new Error('Permissions config must be an object containing only directories.');
      const directories = (value as { directories?: unknown }).directories;
      if (!Array.isArray(directories) || directories.length > 128) throw new Error('directories must be an array of at most 128 directory rules per source.');
      const seen = new Set<string>();
      for (const item of directories as unknown[]) {
        if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(name => !['path', 'access'].includes(name))) throw new Error('Each directory rule must contain only path and access.');
        const { path, access } = item as { path?: unknown; access?: unknown };
        if (typeof path !== 'string' || !isAbsolute(path) || typeof access !== 'string' || !['deny', 'read-only', 'full'].includes(access)) throw new Error('Directory rules require an absolute path and deny, read-only or full access.');
        const canonical = validateRoot(path);
        const id = key(canonical);
        if (seen.has(id)) throw new Error('Duplicate directory rule after canonicalization within one source.');
        seen.add(id);
        const stats = lstatSync(canonical, { bigint: true });
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Directory rules must name existing non-link directories.');
        // Project/explicit is visited first and wins an equal canonical path.
        // A narrower global path is retained and wins later by specificity.
        if (!merged.has(id)) merged.set(id, Object.freeze({ path: canonical, access: access as DirectoryAccess, identity: `${stats.dev}:${stats.ino}`, ...(layer.path === undefined ? {} : { source: layer.path }) }));
      }
    }
    this.rules = Object.freeze([...merged.values()].sort((a, b) => b.path.length - a.path.length));
    this.configPath = configPath;
    const paths = [...sources.flatMap(source => source.path === undefined ? [] : [source.path]), ...protectedPaths];
    if (paths.some(path => !isAbsolute(path))) throw new Error('Protected configuration paths must be absolute.');
    this.configPaths = Object.freeze([...new Map(paths.map(path => [key(resolve(path)), resolve(path)])).values()]);
    Object.freeze(this);
  }
  isConfig(path: string): boolean {
    // Reserve conventional settings in every project, including future/missing
    // files inside externally granted trees. One project must not plant another's grants.
    return (key(basename(dirname(path))) === key('.mcp-config') && key(basename(path)) === key(PERMISSIONS_FILE))
      || this.configPaths.some(config => key(resolve(path)) === key(config));
  }
  isRoot(path: string): boolean { return this.rules.some(rule => key(path) === key(rule.path)) || this.sessionGrants?.isRoot(path) === true; }
  effective(path: string, worktree: string, full: boolean, externalRead: boolean): EffectivePermission {
    const configured = this.rules.find(rule => containsDirectory(rule.path, path));
    // Settings always take precedence over ephemeral grants, even narrower grants.
    const selected = configured ?? this.sessionGrants?.effective(path);
    if (configured !== undefined) {
      const stats = lstatSync(configured.path, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink() || `${stats.dev}:${stats.ino}` !== configured.identity) throw new Error('Directory permission root changed; owner must review and restart the server.');
    }
    const requested = selected?.access ?? (containsDirectory(worktree, path) ? (full ? 'full' : 'read-only') : externalRead ? 'read-only' : 'deny');
    return Object.freeze({ access: requested === 'full' && !full ? 'read-only' : requested, rule: selected === undefined ? null : Object.freeze({ path: selected.path.replaceAll('\\', '/'), access: selected.access, ...(selected.source === undefined ? {} : { source: selected.source.replaceAll('\\', '/') }) }), capped_by_global_read_only: requested === 'full' && !full });
  }
}
