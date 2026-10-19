import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { git, removeTempRepos, tempFolder, tempRepo } from './git.fixture.ts';
import { MCPSession, type MCPCallResult } from './mcp-client.fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const gitProgram = (process.env['PATH'] ?? '').split(delimiter).map(folder => join(folder, process.platform === 'win32' ? 'git.exe' : 'git')).find(path => existsSync(path))!;
const sessions: MCPSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  removeTempRepos();
});

async function open(kind: 'files' | 'git', repo: string, access: string, permissions?: string, globalPermissions?: string) {
  const session = await MCPSession.open({ transport: 'stdio', command: process.execPath, args: [join(root, 'src', kind, 'server.ts'), '--root', repo, '--access', access, '--git', gitProgram, ...(permissions === undefined ? [] : ['--permissions', permissions]), ...(globalPermissions === undefined ? [] : ['--global-permissions', globalPermissions])], cwd: root });
  sessions.push(session);
  return session;
}
const text = (reply: MCPCallResult): string => reply.content.map(part => (part as { text?: string }).text ?? '').join('');

describe('separate file and Git MCP servers', { timeout: 30_000 }, () => {
  it('resolves separated package exports and legacy tool aliases', () => {
    const files = ['delete-file', 'edit-file', 'file-server', 'files', 'find-files', 'list-dir', 'patterns', 'search-files', 'view-file', 'write-file'];
    for (const name of files) {
      const expected = pathToFileURL(join(root, 'src', 'files', `${name}.ts`)).href;
      expect(import.meta.resolve(`@factory-floor/ai-tools/files/${name}`)).toBe(expected);
      expect(import.meta.resolve(`@factory-floor/ai-tools/tools/${name}`)).toBe(expected);
    }
    for (const [name, folder] of [['git', 'git'], ['access', 'shared'], ['arguments', 'shared']]) {
      const expected = pathToFileURL(join(root, 'src', folder!, `${name}.ts`)).href;
      expect(import.meta.resolve(`@factory-floor/ai-tools/${folder}/${name}`)).toBe(expected);
      expect(import.meta.resolve(`@factory-floor/ai-tools/tools/${name}`)).toBe(expected);
    }
  });

  it('exposes full-output controls and safe Git cursor continuation over real MCP', async () => {
    const repo = tempRepo();
    git(repo, 'config', 'core.autocrlf', 'false');
    const content = Array.from({ length: 2505 }, (_, i) => `output-${i}-${'x'.repeat(40)}\n`).join('');
    writeFileSync(join(repo, 'output.txt'), content);
    git(repo, 'add', 'output.txt');
    git(repo, 'commit', '-qm', 'Add output fixture');
    const files = await open('files', repo, 'read-only');
    for (const name of ['list_dir', 'find_files', 'search_files', 'view_file', 'view_files', 'diff_files']) {
      expect(files.tools.find(tool => tool.name === name)?.inputSchema, name).toHaveProperty('properties.full');
    }
    const normal = text(await files.call('view_file', { path: 'output.txt' }));
    expect(normal).toContain('next: start_line=401');
    const full = await files.call('view_file', { path: 'output.txt', full: true });
    expect(full.isError).not.toBe(true);
    expect(text(full)).toContain('output-2504');
    expect(Buffer.byteLength(text(full))).toBeGreaterThan(50 * 1024);
    expect(text(full)).not.toContain('next:');
    const multi = await files.call('view_files', { paths: ['output.txt'], max_lines: 1, full: true });
    expect(multi.isError).not.toBe(true);
    expect(text(multi)).toContain('output-2504');
    const session = await open('git', repo, 'read-only');
    const page = await session.call('git', { args: ['show', 'HEAD:output.txt'] });
    expect(page.isError).not.toBe(true);
    const marker = /\nnext: cursor=([^\s]+)$/.exec(text(page));
    expect(marker).not.toBeNull();
    const rest = await session.call('git', { cursor: marker![1], full: true });
    expect(rest.isError).not.toBe(true);
    expect(text(page).slice(0, marker!.index) + text(rest) === content).toBe(true);
    const all = await session.call('git', { args: ['show', 'HEAD:output.txt'], full: true });
    expect(text(all) === content).toBe(true);
  });

  it('loads file readers only and refuses guessed writers and access changes over real MCP', async () => {
    const repo = tempRepo();
    const session = await open('files', repo, 'read-only');
    expect(session.server.name).toBe('ai-tools-files');
    expect(session.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['view_file', 'list_dir', 'find_files', 'stat_path', 'view_files', 'diff_files', 'read_excerpt']));
    expect(session.tools.some(tool => ['edit_file', 'write_file', 'delete_file', 'move_path', 'copy_path', 'make_directory', 'remove_directory', 'git', 'run'].includes(tool.name))).toBe(false);
    expect((await session.call('view_file', { path: 'math.js', access: 'full' })).isError).toBe(false);
    for (const name of ['edit_file', 'write_file', 'delete_file', 'move_path', 'copy_path', 'make_directory', 'remove_directory', 'set_access', 'git']) {
      expect((await session.call(name, { path: 'math.js', content: 'overwritten', access: 'full', args: ['add', '.'] })).isError).toBe(true);
    }
    expect(readFileSync(join(repo, 'math.js'), 'utf8')).toContain('return a + b;');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('loads full file access, edits with a read hash, and keeps stale writes and outside paths refused', async () => {
    const repo = tempRepo();
    const session = await open('files', repo, 'full');
    expect(session.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['view_file', 'list_dir', 'find_files', 'edit_file', 'write_file', 'delete_file']));
    expect((await session.call('write_file', { path: 'note.txt', content: 'first\n' })).isError).toBe(false);
    const base = /file=([0-9a-f]{16})/.exec(text(await session.call('view_file', { path: 'note.txt' })))![1]!;
    expect((await session.call('edit_file', { path: 'note.txt', base, edits: [{ op: 'replace_text', old: 'first', new: 'second' }] })).isError).toBe(false);
    expect(readFileSync(join(repo, 'note.txt'), 'utf8')).toBe('second\n');
    expect((await session.call('write_file', { path: 'note.txt', content: 'stale', base })).isError).toBe(true);
    const latest = /file=([0-9a-f]{16})/.exec(text(await session.call('view_file', { path: 'note.txt' })))![1]!;
    expect((await session.call('delete_file', { path: 'note.txt', base: latest })).isError).toBe(false);
    expect(existsSync(join(repo, 'note.txt'))).toBe(false);
    expect((await session.call('write_file', { path: join(dirname(repo), 'escape.txt'), content: 'escape' })).isError).toBe(true);
    expect((await session.call('write_file', { path: '.git/config', content: 'escape' })).isError).toBe(true);
    expect((await session.call('git', { args: ['status'] })).isError).toBe(true);
  });

  it('loads owner-selected directory overrides over MCP with a hard global read-only ceiling', async () => {
    const repo = tempRepo(), external = tempFolder('mcp-rule-cli-');
    const config = join(repo, 'permissions.json');
    writeFileSync(config, JSON.stringify({ directories: [{ path: external, access: 'full' }] }));
    const full = await open('files', repo, 'full', config);
    const reader = await open('files', repo, 'read-only', config);
    const path = join(external, 'allowed.txt');
    expect((await full.call('write_file', { path, content: 'override' })).isError).toBe(false);
    const stat = await reader.call('stat_path', { path });
    expect(stat.isError, text(stat)).toBe(false);
    expect(JSON.parse(text(stat)).permission).toMatchObject({ access: 'read-only', capped_by_global_read_only: true, rule: { access: 'full' } });
    expect((await reader.call('write_file', { path: join(external, 'not-allowed.txt'), content: 'no', access: 'full' })).isError).toBe(true);
    expect((await full.call('view_file', { path: config })).isError).toBe(true);
    writeFileSync(config, JSON.stringify({ directories: [] }));
    expect((await full.call('write_file', { path: join(external, 'still-active.txt'), content: 'yes' })).isError).toBe(false);
    const restarted = await open('files', repo, 'read-only', config);
    expect((await restarted.call('view_file', { path })).isError).toBe(true);
    await expect(open('git', repo, 'full', config)).rejects.toThrow();
    writeFileSync(config, '{ invalid json');
    await expect(open('files', repo, 'full', config)).rejects.toThrow();
  });

  it('discovers only the current project, applies global defaults and rejects a foreign --permissions path', async () => {
    const repo = tempRepo(), other = tempRepo(), outside = tempFolder('mcp-discovery-outside-');
    mkdirSync(join(repo, '.mcp-config')); mkdirSync(join(outside, 'private')); mkdirSync(join(outside, 'reader'));
    const project = join(repo, '.mcp-config/ai-tools-files-permissions.json');
    writeFileSync(project, JSON.stringify({ directories: [{ path: outside, access: 'full' }] }));
    const global = join(outside, 'global.json');
    writeFileSync(global, JSON.stringify({ directories: [{ path: join(outside, 'private'), access: 'deny' }, { path: join(outside, 'reader'), access: 'read-only' }] }));
    const first = await open('files', repo, 'full', undefined, global);
    const second = await open('files', other, 'full', undefined, global);
    const path = join(outside, 'first-project.txt');
    expect((await first.call('write_file', { path, content: 'isolated' })).isError).toBe(false);
    expect((await second.call('view_file', { path })).isError).toBe(true);
    expect((await first.call('view_file', { path: project })).isError).toBe(true);
    expect((await first.call('write_file', { path: join(outside, 'private/no.txt'), content: 'no' })).isError).toBe(true);
    expect((await first.call('write_file', { path: join(outside, 'reader/no.txt'), content: 'no' })).isError).toBe(true);
    const stat = await first.call('stat_path', { path: join(outside, 'reader') });
    expect(JSON.parse(text(stat)).permission.rule.source).toBe(global.replaceAll('\\', '/'));
    await expect(open('files', other, 'full', project)).rejects.toThrow(/project-scoped/);
  });

  it('exposes no tools in deny mode and accepts super for Git with ordinary full Git behavior', async () => {
    const repo = tempRepo();
    for (const kind of ['files', 'git'] as const) {
      const denied = await open(kind, repo, 'deny');
      expect(denied.tools).toEqual([]);
      expect((await denied.call(kind === 'files' ? 'view_file' : 'git', { path: 'math.js', args: ['status'] })).isError).toBe(true);
    }
    const superGit = await open('git', repo, 'super');
    expect((await superGit.call('git', { args: ['status', '--porcelain'] })).isError).toBe(false);
  });

  it('exposes versioned copy, move and directory operations over real MCP', async () => {
    const repo = tempRepo();
    const session = await open('files', repo, 'full');
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await session.call(name, args);
      expect(result.isError, text(result)).toBe(false);
      return text(result);
    };
    await call('make_directory', { path: 'new/sub', parents: true });
    const base = JSON.parse(await call('stat_path', { path: 'math.js' })).version;
    await call('copy_path', { source: 'math.js', destination: 'new/sub/copied.js', base });
    const copied = JSON.parse(await call('stat_path', { path: 'new/sub/copied.js' })).version;
    await call('move_path', { source: 'new/sub/copied.js', destination: 'new/sub/renamed.js', base: copied });
    expect(await call('diff_files', { left: 'math.js', right: 'new/sub/renamed.js' })).toContain('identical');
    expect(await call('view_files', { paths: ['math.js', 'new/sub/renamed.js'] })).toContain('file=');
    expect(await call('read_excerpt', { path: 'new/sub/renamed.js', max_bytes: 16 })).toContain('edit_ready=no');
    const preview = JSON.parse(await call('remove_directory', { path: 'new', recursive: true, preview: true }));
    await call('remove_directory', { path: 'new', recursive: true, base: preview.version });
    expect(existsSync(join(repo, 'new'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('allows broad external reads only in super mode without engine declarations', async () => {
    const repo = tempRepo();
    const outside = tempFolder('mcp-external-');
    const file = join(outside, 'external.txt');
    writeFileSync(file, 'external marker\n');
    mkdirSync(join(outside, '.notes'));
    writeFileSync(join(outside, '.notes', 'note.txt'), 'hidden marker\n');
    mkdirSync(join(outside, '.ssh'));
    writeFileSync(join(outside, '.ssh', 'config'), 'secret');
    mkdirSync(join(outside, '.git'));
    writeFileSync(join(outside, '.git', 'config'), 'git secret');
    const full = await open('files', repo, 'super');
    const scoped = await open('files', repo, 'full');
    expect((await scoped.call('view_file', { path: file })).isError).toBe(true);
    const reader = await open('files', repo, 'read-only');
    const read = await full.call('view_file', { path: file });
    expect(read.isError, text(read)).toBe(false);
    expect(text(read)).toContain('external marker');
    const base = /file=([0-9a-f]{16})/.exec(text(read))![1]!;
    expect((await reader.call('view_file', { path: file, access: 'full' })).isError).toBe(true);
    expect((await full.call('view_file', { path: join(outside, '.notes', 'note.txt') })).isError).toBe(false);
    const listing = await full.call('list_dir', { path: outside });
    expect(listing.isError, text(listing)).toBe(false);
    expect(text(listing)).toContain('external.txt');
    const found = await full.call('find_files', { path: outside, pattern: '**/*.txt' });
    expect(found.isError, text(found)).toBe(false);
    expect(text(found)).toContain('external.txt');
    if (full.tools.some(tool => tool.name === 'search_files')) {
      for (const path of [outside, file]) {
        const search = await full.call('search_files', { path, pattern: 'external marker' });
        expect(search.isError, text(search)).toBe(false);
        expect(text(search)).toContain('external marker');
      }
    }
    for (const path of [join(outside, '.ssh', 'config'), join(outside, '.git', 'config')]) {
      expect((await full.call('view_file', { path })).isError).toBe(true);
    }
    expect((await full.call('write_file', { path: file, base, content: 'changed' })).isError).toBe(true);
    expect((await full.call('edit_file', { path: file, edits: [{ op: 'replace_text', old: 'external', new: 'changed' }] })).isError).toBe(true);
    expect((await full.call('delete_file', { path: file, base })).isError).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('external marker\n');
    // engine/ is an ordinary repository folder, not a privileged mount namespace.
    mkdirSync(join(repo, 'engine', 'ordinary'), { recursive: true });
    expect((await full.call('write_file', { path: 'engine/ordinary/new.txt', content: 'ordinary' })).isError).toBe(false);
    symlinkSync(outside, join(repo, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await full.call('view_file', { path: 'external-link/external.txt' })).isError).toBe(false);
    expect((await full.call('write_file', { path: 'external-link/new.txt', content: 'blocked' })).isError).toBe(true);
  });

  it('keeps Git read-only even when calls supply full access or try branch and commit writes', async () => {
    const repo = tempRepo();
    const session = await open('git', repo, 'read-only');
    expect(session.server.name).toBe('ai-tools-git');
    expect(session.tools.map(tool => tool.name)).toEqual(['git']);
    const before = git(repo, 'rev-parse', 'HEAD');
    for (const args of [['add', '.'], ['commit', '-m', 'injected'], ['branch', 'injected'], ['reset', '--hard']]) {
      expect((await session.call('git', { args, access: 'full' })).isError).toBe(true);
    }
    expect((await session.call('set_access', { access: 'full' })).isError).toBe(true);
    expect((await session.call('git', { args: ['status'] })).isError).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'branch', '--list', 'injected')).toBe('');
  });

  it('supports full Git staging, commits, branch switching, merge, fetch and push to a local bare repo', async () => {
    const repo = tempRepo();
    // The contract under test is Git operations, independent of the owner's checkout line endings.
    git(repo, 'config', 'core.autocrlf', 'false');
    git(repo, 'config', 'user.name', 'MCP test');
    git(repo, 'config', 'user.email', 'mcp@example.invalid');
    // Owner signing defaults must not make an ordinary MCP write invoke a signer.
    git(repo, 'config', 'user.signingkey', 'MCP-TEST-KEY');
    git(repo, 'config', 'gpg.program', join(repo, 'missing-signer'));
    git(repo, 'config', 'tag.forceSignAnnotated', 'true');
    git(repo, 'config', 'push.gpgSign', 'true');
    const remote = tempFolder('ff-mcp-remote-');
    git(remote, 'init', '--bare');
    git(remote, 'config', 'receive.certNonceSeed', 'mcp-test-nonce');
    git(repo, 'remote', 'add', 'origin', remote);
    const session = await open('git', repo, 'full');
    const call = async (...args: string[]): Promise<void> => {
      const reply = await session.call('git', { args });
      expect(reply.isError, text(reply)).toBe(false);
    };
    await call('switch', '-c', 'feature');
    writeFileSync(join(repo, 'feature.txt'), 'feature\n');
    await call('add', 'feature.txt');
    await call('commit', '-m', 'Add feature');
    await call('switch', 'main');
    await call('merge', '--no-ff', 'feature', '-m', 'Merge feature');
    await call('tag', '-m', 'Unsigned MCP tag', 'unsigned-tag');
    expect(git(repo, 'cat-file', 'tag', 'unsigned-tag')).not.toContain('BEGIN PGP SIGNATURE');
    await call('push', '--set-upstream', 'origin', 'main');
    await call('fetch', 'origin');
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect((await session.call('git', { args: ['-C', remote, 'status'] })).isError).toBe(true);
    expect((await session.call('git', { args: ['rebase', '-x', 'echo injected', 'HEAD'] })).isError).toBe(true);
    for (const args of [['commit', '-S', '-m', 'signed'], ['tag', '-s', 'signed'], ['commit', '--gpg-s', '-m', 'signed'], ['commit', '--g', '-m', 'signed'], ['push', '--signed'], ['push', '--signed=true'], ['push', '--signed=if-asked'], ['merge', '-s', 'external', 'feature'], ['rebase', '--stra=external', 'HEAD'], ['fetch', 'ext::echo injected'], ['fetch', '1helper::address'], ['push', '--repo=1helper://address'], ['fetch', 'SSH://example.invalid/repo']]) {
      expect((await session.call('git', { args })).isError).toBe(true);
    }
    expect((await session.call('write_file', { path: 'x', content: 'x' })).isError).toBe(true);
  });

  it('does not fetch or write missing objects during read-only Git calls in a partial clone', async () => {
    const source = tempRepo();
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    const repo = tempFolder('ff-mcp-partial-');
    git(source, 'clone', '--filter=blob:none', '--no-checkout', pathToFileURL(source).href, repo);
    expect(git(repo, 'rev-list', '--objects', '--missing=print', 'HEAD')).toMatch(/\?[0-9a-f]{40}/);
    const packs = join(repo, '.git', 'objects', 'pack');
    const before = readdirSync(packs).sort();
    const session = await open('git', repo, 'read-only');
    expect((await session.call('git', { args: ['show', 'HEAD:math.js'] })).isError).toBe(true);
    expect(readdirSync(packs).sort()).toEqual(before);
    expect(git(repo, 'rev-list', '--objects', '--missing=print', 'HEAD')).toMatch(/\?[0-9a-f]{40}/);
  });

  it('pins the requested root despite ambient Git directory and worktree overrides', () => {
    const repo = tempRepo();
    const other = tempRepo();
    const output = execFileSync(process.execPath, [join(root, 'src/git/server.ts'), '--root', repo, '--access', 'full'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other },
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git', arguments: { args: ['branch', 'requested-root'] } } })}\n`,
    });
    expect(JSON.parse(output).result.isError).toBe(false);
    expect(git(repo, 'branch', '--list', 'requested-root')).toContain('requested-root');
    expect(git(other, 'branch', '--list', 'requested-root')).toBe('');
  });

  it.each(['', 'write', 'FULL'])('rejects invalid startup access %j instead of choosing a permissive mode', async access => {
    await expect(open('git', tempRepo(), access)).rejects.toThrow();
  });
});
