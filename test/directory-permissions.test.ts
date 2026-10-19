import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolReply } from '../src/contract.ts';
import { fileServerTools } from '../src/files/file-server.ts';
import { readDirectoryConfig } from '../src/files/directory-config.ts';
import { DirectoryPermissions, type DirectoryRule } from '../src/files/directory-permissions.ts';
import { searchFilesTool, type RipgrepProcess } from '../src/files/search-files.ts';
import { writeFileTool } from '../src/files/write-file.ts';
import { startCall, writeAtomic } from '../src/files/files.ts';
import { tempFolder, tempRepo, removeTempRepos } from './git.fixture.ts';

const text = (reply: ToolReply): string => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
afterEach(removeTempRepos);
function setup(repo: string, access: 'full' | 'read-only', config: unknown, path?: string) {
  const place = { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') };
  const tools = fileServerTools({ worktree: repo, project: null, directoryConfig: { config, ...(path === undefined ? {} : { path }) } }, place, access, null);
  const call = async (name: string, args: Record<string, unknown>) => tools.find(item => item.tool.name === name)!.call(args);
  const ok = async (name: string, args: Record<string, unknown>) => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(true); return text(reply); };
  const bad = async (name: string, args: Record<string, unknown>) => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(false); return text(reply); };
  const stat = async (path: string, recursive = false) => JSON.parse(await ok('stat_path', { path, recursive }));
  return { place, tools, call, ok, bad, stat };
}

describe('owner-selected directory permission overrides', () => {
  it('grants external reads in read-only mode but never overrides the global write ceiling', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-reader-');
    writeFileSync(join(external, 'note.txt'), 'outside');
    const config = { directories: [{ path: external, access: 'full' }] };
    const s = setup(repo, 'read-only', config);
    expect(await s.ok('view_file', { path: join(external, 'note.txt') })).toContain('outside');
    const stat = await s.stat(join(external, 'note.txt'));
    expect(stat.permission.access).toBe('read-only'); expect(stat.permission.rule.access).toBe('full');
    expect(stat.permission.capped_by_global_read_only).toBe(true); expect(stat.writable).toBe(false);
    expect(s.tools.some(item => item.tool.name === 'write_file')).toBe(false);
    const permissions = new DirectoryPermissions(config, realpathSync);
    const writer = writeFileTool({ worktree: repo, project: null, role: 'reader', permissions });
    expect((await writer.call({ path: join(external, 'new.txt'), content: 'forbidden' })).success).toBe(false);
    await s.bad('view_file', { path: join(tempFolder('mcp-rules-outside-'), 'other.txt') });
  });

  it('matches component boundaries and permits an explicitly named child below a denied parent', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-boundaries-');
    mkdirSync(join(external, 'allowed/child'), { recursive: true }); mkdirSync(join(external, 'allowed-sibling'));
    writeFileSync(join(external, 'allowed/child/note.txt'), 'permitted child');
    const config = { directories: [{ path: join(external, 'allowed'), access: 'deny' }, { path: join(external, 'allowed/child'), access: 'read-only' }] };
    const reader = setup(repo, 'read-only', config);
    await reader.bad('list_dir', { path: join(external, 'allowed') });
    expect(await reader.ok('view_file', { path: join(external, 'allowed/child/note.txt') })).toContain('permitted child');
    const full = setup(repo, 'full', { directories: [{ path: join(external, 'allowed'), access: 'full' }] });
    await full.ok('write_file', { path: join(external, 'allowed/new.txt'), content: 'yes' });
    await full.bad('write_file', { path: join(external, 'allowed-sibling/no.txt'), content: 'no' });
  });

  it('grants full-mode external writes, edits, deletion, directories, copy and move only where configured', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-writer-'), other = tempFolder('mcp-rules-default-');
    const s = setup(repo, 'full', { directories: [{ path: external, access: 'full' }] });
    const note = join(external, 'note.txt');
    await s.ok('write_file', { path: note, content: 'first' });
    await s.ok('edit_file', { path: note, edits: [{ op: 'replace_text', old: 'first', new: 'second' }] });
    expect(readFileSync(note, 'utf8')).toBe('second'); expect((await s.stat(note)).permission.access).toBe('full');
    await s.ok('make_directory', { path: join(external, 'sub') });
    const base = (await s.stat('math.js')).version;
    await s.ok('copy_path', { source: 'math.js', destination: join(external, 'sub/copy.js'), base });
    await s.ok('move_path', { source: join(external, 'sub/copy.js'), destination: join(external, 'sub/moved.js'), base: (await s.stat(join(external, 'sub/copy.js'))).version });
    const preview = JSON.parse(await s.ok('remove_directory', { path: join(external, 'sub'), recursive: true, preview: true }));
    await s.ok('remove_directory', { path: join(external, 'sub'), recursive: true, base: preview.version });
    await s.ok('delete_file', { path: note, base: (await s.stat(note)).hash });
    expect(existsSync(note)).toBe(false);
    await s.bad('write_file', { path: join(other, 'no.txt'), content: 'no' });
    await s.bad('remove_directory', { path: external, preview: true });
  });

  it('uses the most-specific canonical rule and hides denied metadata from list/find', async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, 'restricted/editable'), { recursive: true }); mkdirSync(join(repo, 'restricted/hidden'));
    writeFileSync(join(repo, 'restricted/plain.txt'), 'readable'); writeFileSync(join(repo, 'restricted/hidden/secret.txt'), 'secret marker');
    const s = setup(repo, 'full', { directories: [
      { path: join(repo, 'restricted'), access: 'read-only' },
      { path: join(repo, 'restricted/editable'), access: 'full' },
      { path: join(repo, 'restricted/hidden'), access: 'deny' },
    ] });
    expect(await s.ok('view_file', { path: 'restricted/plain.txt' })).toContain('readable');
    await s.bad('write_file', { path: 'restricted/plain.txt', content: 'no' });
    await s.ok('write_file', { path: 'restricted/editable/new.txt', content: 'yes' });
    await s.bad('stat_path', { path: 'restricted/hidden/secret.txt' });
    await s.bad('view_file', { path: 'restricted/hidden/../hidden/secret.txt' });
    if (process.platform === 'win32') await s.bad('view_file', { path: join(repo, 'restricted/hidden/secret.txt').toUpperCase() });
    expect(await s.ok('list_dir', { path: 'restricted' })).not.toContain('hidden');
    const found = await s.ok('find_files', { pattern: '**/*.txt', path: 'restricted' });
    expect(found).toContain('plain.txt'); expect(found).toContain('new.txt'); expect(found).not.toContain('secret.txt');
    const stat = await s.stat('restricted/editable/new.txt');
    expect(stat.permission.rule.path).toBe(join(repo, 'restricted/editable').replaceAll('\\', '/'));
  });

  it('checks descendants before recursive mutations and prunes denied external walks', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-walk-');
    mkdirSync(join(external, 'tree/hidden'), { recursive: true }); writeFileSync(join(external, 'tree/visible.txt'), 'visible'); writeFileSync(join(external, 'tree/hidden/no.txt'), 'private');
    const s = setup(repo, 'full', { directories: [{ path: external, access: 'full' }, { path: join(external, 'tree/hidden'), access: 'deny' }] });
    const found = await s.ok('find_files', { path: external, pattern: '**/*.txt' });
    expect(found).toContain('visible.txt'); expect(found).not.toContain('no.txt');
    await s.bad('remove_directory', { path: join(external, 'tree'), recursive: true, preview: true });
    await s.bad('copy_path', { source: join(external, 'tree'), destination: 'copy', recursive: true, preview: true });
    expect(existsSync(join(repo, 'copy'))).toBe(false); expect(existsSync(join(external, 'tree/visible.txt'))).toBe(true);
  });

  it('authorizes search input files before starting rg, never scanning a denied directory', async () => {
    const repo = tempRepo(); mkdirSync(join(repo, 'blocked'));
    writeFileSync(join(repo, 'blocked/no.txt'), 'secret');
    for (let i = 0; i < 70; i++) writeFileSync(join(repo, `allowed-${i}.txt`), 'public');
    const permissions = new DirectoryPermissions({ directories: [{ path: join(repo, 'blocked'), access: 'deny' }] }, realpathSync);
    const invoked: string[][] = [];
    const operation = searchFilesTool({ worktree: repo, project: null, role: 'implementer', externalRead: true, permissions }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git/no-hooks') }, 'unused', {
      run: (args, cwd) => { invoked.push([...args]); return spawn(process.execPath, ['-e', 'process.exit(1)'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) as RipgrepProcess; },
    });
    const reply = await operation.call({ pattern: 'secret', include_ignored: true });
    expect(reply.success, text(reply)).toBe(true); expect(invoked.length).toBeGreaterThan(1);
    for (const args of invoked) {
      const paths = args.slice(args.indexOf('--') + 1);
      expect(paths.length).toBeLessThanOrEqual(64); expect(paths).not.toContain('.');
      expect(paths.every(path => !path.includes('blocked'))).toBe(true);
    }
  });

  it('captures configuration once and protects the active configuration from file tools', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-frozen-'), configPath = join(repo, 'permissions.json');
    const config = { directories: [{ path: external, access: 'read-only' }] };
    writeFileSync(configPath, JSON.stringify(config));
    const loaded = readDirectoryConfig(repo, configPath);
    const s = setup(repo, 'full', loaded.config, loaded.path);
    config.directories[0]!.access = 'full'; writeFileSync(configPath, JSON.stringify(config));
    await s.bad('write_file', { path: join(external, 'still-no.txt'), content: 'no' });
    await s.bad('view_file', { path: configPath }); await s.bad('write_file', { path: configPath, content: '{}' });
    const restarted = readDirectoryConfig(repo, configPath);
    const next = setup(repo, 'full', restarted.config, restarted.path);
    await next.ok('write_file', { path: join(external, 'now-yes.txt'), content: 'yes' });
    const mutable = { directories: [{ path: external, access: 'read-only' }] };
    const fixed = setup(repo, 'full', mutable); mutable.directories[0]!.access = 'full';
    await fixed.bad('write_file', { path: join(external, 'mutated-input.txt'), content: 'no' });
  });

  it('pins rule identities and reauthorizes after asynchronous writer waits', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rules-pin-');
    const permissions = new DirectoryPermissions({ directories: [{ path: external, access: 'full' }] }, realpathSync);
    const path = startCall({ worktree: repo, project: null, role: 'implementer', externalRead: true, permissions }).judge(join(external, 'new.txt'), 'write');
    expect(path.ok).toBe(true); if (!path.ok) return;
    const backup = join(tempFolder('mcp-rules-backup-'), 'old');
    const result = await writeAtomic(path, Buffer.from('must not publish'), null, { beforeRehash: () => {
      renameSync(external, backup); mkdirSync(external);
    } });
    expect(result.ok).toBe(false); expect(existsSync(join(external, 'new.txt'))).toBe(false);
    expect(startCall({ worktree: repo, project: null, role: 'reader', externalRead: true, permissions }).judge(external, 'read').ok).toBe(false);
  });

  it('rejects invalid, duplicate, linked and protected rule roots before offering tools', () => {
    const repo = tempRepo(); mkdirSync(join(repo, '.ssh'));
    symlinkSync(repo, join(repo, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const invalid: unknown[] = [null, {}, { directories: null }, { directories: [], other: true }, { directories: new Array(129).fill({ path: repo, access: 'deny' }) },
      ...['relative', join(repo, 'absent'), join(repo, 'math.js'), join(repo, '.git'), join(repo, '.ssh'), join(repo, 'alias')].map(path => ({ directories: [{ path, access: 'full' }] })),
      { directories: [{ path: repo, access: 'write' }] }, { directories: [{ path: repo, access: ['full'] }] }, { directories: [{ path: repo, access: 'full', extra: true }] },
      { directories: [{ path: repo, access: 'full' }, { path: join(repo, '.'), access: 'deny' }] },
    ];
    for (const config of invalid) expect(() => setup(repo, 'full', config)).toThrow();
    const valid: DirectoryRule[] = [{ path: repo, access: 'deny' }]; expect(() => setup(repo, 'read-only', { directories: valid })).not.toThrow();
  });
});
