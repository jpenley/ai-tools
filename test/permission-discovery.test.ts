import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolReply } from '../src/contract.ts';
import { readDirectoryConfigs, PERMISSIONS_FILE } from '../src/files/directory-config.ts';
import { DirectoryPermissions } from '../src/files/directory-permissions.ts';
import { fileServerTools } from '../src/files/file-server.ts';
import { gitVerdict } from '../src/git/git.ts';
import { tempFolder, tempRepo, removeTempRepos } from './git.fixture.ts';

const text = (reply: ToolReply) => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
const configPath = (root: string) => join(root, '.mcp-config', PERMISSIONS_FILE);
function put(root: string, config: unknown): string {
  const path = configPath(root); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(config)); return path;
}
afterEach(removeTempRepos);

describe('project/global permission discovery and isolation', () => {
  it('automatically loads each project separately and protects present and missing configuration sources', async () => {
    const first = tempRepo(), second = tempRepo(), home = tempFolder('permissions-home-'), outside = tempFolder('permissions-private-');
    const original = { directories: [{ path: outside, access: 'full' }] };
    const project = put(first, original);
    const build = (repo: string) => fileServerTools({ worktree: repo, project: null, directoryConfig: readDirectoryConfigs(repo, { home }) }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') }, 'full', null);
    const a = build(first), b = build(second);
    const call = (tools: typeof a, name: string, args: Record<string, unknown>) => tools.find(tool => tool.tool.name === name)!.call(args);
    const path = join(outside, 'first-only.txt');
    expect((await call(a, 'write_file', { path, content: 'first project' })).success).toBe(true);
    expect((await call(b, 'view_file', { path })).success).toBe(false);
    expect((await call(b, 'write_file', { path, content: 'must not escape' })).success).toBe(false);
    expect((await call(a, 'view_file', { path: project })).success).toBe(false);
    for (const path of [configPath(second), configPath(home)]) expect((await call(b, 'write_file', { path, content: JSON.stringify(original) })).success).toBe(false);
    expect(JSON.parse(readFileSync(project, 'utf8'))).toEqual(original);
    expect(() => readDirectoryConfigs(second, { home, projectPath: project })).toThrow(/project-scoped/);
  });

  it('cannot plant or alter another project\'s conventional settings through an external full grant', async () => {
    const repo = tempRepo(), outside = tempFolder('permissions-foreign-');
    const future = configPath(outside); mkdirSync(dirname(future), { recursive: true });
    const tools = fileServerTools({ worktree: repo, project: null, directoryConfig: { config: { directories: [{ path: outside, access: 'full' }] } } }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') }, 'full', null);
    const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.tool.name === name)!.call(args);
    expect((await call('write_file', { path: future, content: '{"directories":[]}' })).success).toBe(false);
    for (const name of ['copy_path', 'move_path']) expect((await call(name, { source: 'math.js', destination: future, preview: true })).success).toBe(false);
    writeFileSync(future, '{"directories":[]}');
    expect((await call('view_file', { path: future })).success).toBe(false);
    expect((await call('delete_file', { path: future, base: 'not-authority' })).success).toBe(false);
  });

  it('chooses longest paths across both layers, project on ties, and reports the selected source', () => {
    const repo = tempRepo(), home = tempFolder('permissions-home-'), outside = tempFolder('permissions-layers-');
    mkdirSync(join(outside, 'private')); mkdirSync(join(outside, 'private/allowed'));
    const project = put(repo, { directories: [{ path: outside, access: 'full' }, { path: join(outside, 'private/allowed'), access: 'read-only' }] });
    const global = put(home, { directories: [{ path: outside, access: 'read-only' }, { path: join(outside, 'private'), access: 'deny' }] });
    const config = readDirectoryConfigs(repo, { home });
    const permissions = new DirectoryPermissions(config.config, realpathSync, config.path, config.fallbacks, config.protectedPaths);
    const effective = (path: string) => permissions.effective(path, repo, true, true);
    expect(effective(outside)).toMatchObject({ access: 'full', rule: { source: project.replaceAll('\\', '/') } });
    expect(effective(join(outside, 'private'))).toMatchObject({ access: 'deny', rule: { source: global.replaceAll('\\', '/') } });
    expect(effective(join(outside, 'private/allowed'))).toMatchObject({ access: 'read-only', rule: { source: project.replaceAll('\\', '/') } });
    for (const path of [project, global]) expect(permissions.isConfig(path)).toBe(true);
  });

  it('honors an explicit project replacement but still loads global defaults and reserves automatic locations', () => {
    const repo = tempRepo(), home = tempFolder('permissions-home-'), outside = tempFolder('permissions-target-');
    const automatic = put(repo, { directories: [{ path: outside, access: 'deny' }] });
    const global = put(home, { directories: [{ path: outside, access: 'read-only' }] });
    const explicit = join(repo, 'owner-permissions.json'); writeFileSync(explicit, '{"directories":[]}');
    const config = readDirectoryConfigs(repo, { home, projectPath: explicit });
    const permissions = new DirectoryPermissions(config.config, realpathSync, config.path, config.fallbacks, config.protectedPaths);
    expect(permissions.effective(outside, repo, true, false)).toMatchObject({ access: 'read-only', rule: { source: global.replaceAll('\\', '/') } });
    for (const path of [automatic, explicit, global]) expect(permissions.isConfig(path)).toBe(true);
  });

  it('fails closed for malformed existing/explicit missing files and global rules instead of silently falling back', () => {
    const repo = tempRepo(), home = tempFolder('permissions-home-');
    expect(readDirectoryConfigs(repo, { home }).config).toEqual({ directories: [] });
    expect(() => readDirectoryConfigs(repo, { home, projectPath: join(repo, 'missing.json') })).toThrow();
    expect(() => readDirectoryConfigs(repo, { home, globalPath: join(home, 'missing.json') })).toThrow();
    const project = put(repo, { directories: [] });
    writeFileSync(project, '{ malformed');
    expect(() => readDirectoryConfigs(repo, { home })).toThrow();
    writeFileSync(project, '{"directories":[]}');
    const global = put(home, { directories: [] }); writeFileSync(global, '{ malformed');
    expect(() => readDirectoryConfigs(repo, { home })).toThrow();
    put(home, { directories: [{ path: home, access: 'super' }] });
    const config = readDirectoryConfigs(repo, { home });
    expect(() => new DirectoryPermissions(config.config, realpathSync, config.path, config.fallbacks, config.protectedPaths)).toThrow();
  });

  it('rejects link-based automatic settings discovery', () => {
    const repo = tempRepo(), home = tempFolder('permissions-home-'), outside = tempFolder('permissions-linked-');
    writeFileSync(join(outside, PERMISSIONS_FILE), '{"directories":[]}');
    symlinkSync(outside, join(repo, '.mcp-config'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readDirectoryConfigs(repo, { home })).toThrow(/link|junction/);
  });

  it('keeps deny closed and maps Git super to full without changing file-input restrictions', () => {
    const repo = tempRepo(), place = { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') };
    expect(fileServerTools({ worktree: repo, project: null }, place, 'deny', null)).toEqual([]);
    expect(gitVerdict(['status'], 'deny').kind).toBe('block');
    expect(gitVerdict(['add', 'math.js'], 'super').kind).toBe('allow');
    expect(gitVerdict(['add', '--pathspec-from-file=C:/outside.txt'], 'super').kind).toBe('block');
  });
});
