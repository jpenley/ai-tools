import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileServerTools } from '../src/files/file-server.ts';
import { withFileLock } from '../src/files/files.ts';
import { transferPathTool } from '../src/files/core/transfer.ts';
import { git, removeTempRepos, tempFolder, tempRepo } from './git.fixture.ts';
import type { ToolReply } from '../src/contract.ts';

const text = (reply: ToolReply): string => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
afterEach(removeTempRepos);
function setup(access: 'full' | 'read-only' | 'super' | 'deny' = 'full', repo = tempRepo()) {
  const tools = fileServerTools({ worktree: repo, project: null }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') }, access, null);
  const call = async (name: string, args: Record<string, unknown>) => tools.find(item => item.tool.name === name)!.call(args);
  const ok = async (name: string, args: Record<string, unknown>): Promise<string> => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(true); return text(reply); };
  const bad = async (name: string, args: Record<string, unknown>): Promise<string> => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(false); return text(reply); };
  const stat = async (path: string, recursive = false): Promise<{ version: string; hash: string; exists: boolean; writable: boolean }> => JSON.parse(await ok('stat_path', { path, recursive }));
  return { repo, tools, call, ok, bad, stat };
}

describe('expanded Files operations', () => {
  it('registers readers in both modes and mutations only in full mode with correct annotations', () => {
    for (const access of ['full', 'read-only'] as const) {
      const { tools } = setup(access);
      for (const name of ['stat_path', 'view_files', 'diff_files', 'read_excerpt']) expect(tools.find(item => item.tool.name === name)?.tool.annotations?.readOnlyHint).toBe(true);
      for (const name of ['move_path', 'copy_path', 'make_directory', 'remove_directory']) {
        const operation = tools.find(item => item.tool.name === name);
        if (access === 'read-only') expect(operation).toBeUndefined();
        else { expect(operation?.tool.annotations?.readOnlyHint).toBe(false); expect(operation?.tool.annotations?.destructiveHint).toBe(true); }
      }
      expect(tools.every(item => !item.tool.description.includes('undefined'))).toBe(true);
    }
  });

  it('reports allowed metadata, hashes, missing files and external access without exposing protected metadata', async () => {
    const s = setup();
    const info = await s.stat('math.js');
    expect(info.exists).toBe(true); expect(info.writable).toBe(true); expect(info.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await s.stat('absent.txt')).exists).toBe(false);
    const external = tempFolder('mcp-stat-'); writeFileSync(join(external, 'note.txt'), 'outside');
    await s.bad('stat_path', { path: join(external, 'note.txt') });
    expect((await setup('super', s.repo).stat(join(external, 'note.txt'))).writable).toBe(false);
    const reader = setup('read-only', s.repo);
    expect((await reader.stat('math.js')).writable).toBe(false);
    await reader.bad('stat_path', { path: external });
    for (const path of ['.git/config', '.env', '.ssh/config']) await s.bad('stat_path', { path });
  });

  it('creates empty directories, requires explicit parents, and refuses external/protected/root paths', async () => {
    const s = setup();
    await s.bad('make_directory', { path: 'one/two' });
    await s.ok('make_directory', { path: 'one/two', parents: true });
    expect(existsSync(join(s.repo, 'one/two'))).toBe(true);
    expect(JSON.parse(await s.ok('make_directory', { path: 'one/two' })).created).toBe(false);
    for (const path of ['.', '.git/new', '.ssh/new', join(tempFolder('mcp-mkdir-'), 'new')]) await s.bad('make_directory', { path, parents: true });
  });

  it('copies binary bytes without clobbering, requires versions, and guards overwrite', async () => {
    const s = setup();
    const data = Buffer.from([0, 1, 2, 255, 128]); writeFileSync(join(s.repo, 'source.bin'), data);
    const base = (await s.stat('source.bin')).version;
    await s.bad('copy_path', { source: 'source.bin', destination: 'copy.bin' });
    await s.ok('copy_path', { source: 'source.bin', destination: 'copy.bin', base });
    expect(readFileSync(join(s.repo, 'copy.bin'))).toEqual(data);
    await s.bad('copy_path', { source: 'source.bin', destination: 'copy.bin', base });
    await s.bad('copy_path', { source: 'source.bin', destination: 'copy.bin', base, overwrite: true });
    const destinationBase = (await s.stat('copy.bin')).version;
    writeFileSync(join(s.repo, 'copy.bin'), 'new destination');
    await s.bad('copy_path', { source: 'source.bin', destination: 'copy.bin', base, overwrite: true, destination_base: destinationBase });
    const freshDestination = (await s.stat('copy.bin')).version;
    await s.ok('copy_path', { source: 'source.bin', destination: 'copy.bin', base, overwrite: true, destination_base: freshDestination });
    expect(readFileSync(join(s.repo, 'copy.bin'))).toEqual(data);
    expect(readdirSync(s.repo).some(name => name.endsWith('.ff-tmp'))).toBe(false);
    writeFileSync(join(s.repo, 'source.bin'), 'changed');
    await s.bad('copy_path', { source: 'source.bin', destination: 'stale.bin', base });
    expect(existsSync(join(s.repo, 'stale.bin'))).toBe(false);
  });

  it('moves/renames files without Git staging and refuses stale or occupied targets', async () => {
    const s = setup();
    const base = (await s.stat('math.js')).hash;
    await s.ok('move_path', { source: 'math.js', destination: 'renamed.js', base });
    expect(existsSync(join(s.repo, 'math.js'))).toBe(false);
    expect(readFileSync(join(s.repo, 'renamed.js'), 'utf8')).toContain('return a + b');
    expect(git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
    writeFileSync(join(s.repo, 'occupied.js'), 'occupied');
    const newBase = (await s.stat('renamed.js')).version;
    await s.bad('move_path', { source: 'renamed.js', destination: 'occupied.js', base: newBase });
    await s.ok('move_path', { source: 'renamed.js', destination: 'occupied.js', base: newBase, overwrite: true, destination_base: (await s.stat('occupied.js')).version });
    expect(existsSync(join(s.repo, 'renamed.js'))).toBe(false);
  });

  it('copies external sources only in super mode and never permits external mutations', async () => {
    const s = setup('super'), outside = tempFolder('mcp-transfer-');
    const external = join(outside, 'source.txt'); writeFileSync(external, 'external');
    const base = (await s.stat(external)).version;
    await s.ok('copy_path', { source: external, destination: 'imported.txt', base });
    expect(readFileSync(join(s.repo, 'imported.txt'), 'utf8')).toBe('external');
    await s.bad('move_path', { source: external, destination: 'moved.txt', base });
    await s.bad('copy_path', { source: 'imported.txt', destination: join(outside, 'exported.txt'), base: (await s.stat('imported.txt')).version });
    await s.bad('remove_directory', { path: outside, recursive: true, preview: true });
    expect(readFileSync(external, 'utf8')).toBe('external');
    expect(await s.ok('read_excerpt', { path: external })).toContain('external');
    expect(await s.ok('diff_files', { left: external, right: 'imported.txt' })).toContain('identical');
    const reader = setup('read-only', s.repo);
    await reader.bad('read_excerpt', { path: external });
    await reader.bad('diff_files', { left: external, right: 'imported.txt' });
    expect(await reader.ok('view_files', { paths: [external] })).toContain('ERROR');
  });

  it('previews and transfers bounded trees only with explicit recursion and source versions', async () => {
    const s = setup();
    mkdirSync(join(s.repo, 'tree/empty'), { recursive: true });
    writeFileSync(join(s.repo, 'tree/a.bin'), Buffer.from([0, 255]));
    await s.bad('copy_path', { source: 'tree', destination: 'copy', preview: true });
    const preview = JSON.parse(await s.ok('copy_path', { source: 'tree', destination: 'copy', recursive: true, preview: true }));
    expect(existsSync(join(s.repo, 'copy'))).toBe(false);
    await s.ok('copy_path', { source: 'tree', destination: 'copy', recursive: true, base: preview.source.version });
    expect(existsSync(join(s.repo, 'copy/empty'))).toBe(true);
    const base = (await s.stat('copy', true)).version;
    await s.bad('move_path', { source: 'copy', destination: 'copy/child', recursive: true, base });
    await s.ok('move_path', { source: 'copy', destination: 'moved', recursive: true, base });
    expect(existsSync(join(s.repo, 'copy'))).toBe(false);
    expect(readFileSync(join(s.repo, 'moved/a.bin'))).toEqual(Buffer.from([0, 255]));
  });

  it('requires fresh preview versions before recursive removal and leaves protected trees intact', async () => {
    const s = setup();
    mkdirSync(join(s.repo, 'tree/empty'), { recursive: true }); writeFileSync(join(s.repo, 'tree/note.txt'), 'keep');
    await s.bad('remove_directory', { path: 'tree' });
    await s.bad('remove_directory', { path: 'tree', recursive: true });
    const preview = JSON.parse(await s.ok('remove_directory', { path: 'tree', recursive: true, preview: true }));
    writeFileSync(join(s.repo, 'tree/new.txt'), 'new');
    await s.bad('remove_directory', { path: 'tree', recursive: true, base: preview.version });
    expect(existsSync(join(s.repo, 'tree/note.txt'))).toBe(true);
    const next = JSON.parse(await s.ok('remove_directory', { path: 'tree', recursive: true, preview: true }));
    await s.ok('remove_directory', { path: 'tree', recursive: true, base: next.version });
    expect(existsSync(join(s.repo, 'tree'))).toBe(false);
    mkdirSync(join(s.repo, 'empty'));
    await s.ok('remove_directory', { path: 'empty', base: (await s.stat('empty')).version });
    mkdirSync(join(s.repo, 'protected/.git'), { recursive: true });
    writeFileSync(join(s.repo, 'protected/ordinary.txt'), 'keep');
    await s.bad('remove_directory', { path: 'protected', recursive: true, preview: true });
    await s.bad('copy_path', { source: 'protected', destination: 'bad-copy', recursive: true, preview: true });
    expect(existsSync(join(s.repo, 'bad-copy'))).toBe(false);
    expect(existsSync(join(s.repo, 'protected/ordinary.txt'))).toBe(true);
    await s.bad('remove_directory', { path: '.', recursive: true, preview: true });
  });

  it('rejects links, hard-linked mutation sources and protected descendants before mutation', async () => {
    const s = setup();
    mkdirSync(join(s.repo, 'tree'));
    symlinkSync(s.repo, join(s.repo, 'tree/link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await s.stat('tree/link')).writable).toBe(false);
    await s.bad('copy_path', { source: 'tree', destination: 'copy', recursive: true, preview: true });
    expect(existsSync(join(s.repo, 'copy'))).toBe(false);
    linkSync(join(s.repo, 'math.js'), join(s.repo, 'hard.js'));
    await s.bad('move_path', { source: 'hard.js', destination: 'moved.js', preview: true });
    await s.bad('copy_path', { source: 'math.js', destination: '.git/copied', preview: true });
    await s.bad('copy_path', { source: 'math.js', destination: '.env', preview: true });
  });

  it('revalidates source and destination versions after waiting for existing writer locks', async () => {
    const s = setup();
    const base = (await s.stat('math.js')).version;
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = withFileLock(join(s.repo, 'math.js'), async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const pending = s.call('copy_path', { source: 'math.js', destination: 'z-copy.js', base });
    writeFileSync(join(s.repo, 'math.js'), 'changed while waiting'); release(); await hold;
    const result = await pending;
    expect(result.success, text(result)).toBe(false); expect(text(result)).toContain('STALE');
    expect(existsSync(join(s.repo, 'z-copy.js'))).toBe(false);
  });

  it('reports partial recursive copy/move failures without deleting unprocessed source files', async () => {
    for (const moving of [false, true]) {
      const s = setup(); mkdirSync(join(s.repo, 'tree'));
      writeFileSync(join(s.repo, 'tree/a.txt'), 'a'); writeFileSync(join(s.repo, 'tree/b.txt'), 'b');
      const operation = transferPathTool({ worktree: s.repo, project: null, role: 'implementer' }, moving, {
        beforeEntry: entry => { if (entry.relative === 'b.txt') throw new Error('injected failure'); },
      });
      const result = await operation.call({ source: 'tree', destination: 'partial', recursive: true, base: (await s.stat('tree', true)).version });
      expect(result.success).toBe(false); expect(text(result)).toContain('Partial completion: 2');
      expect(readFileSync(join(s.repo, 'partial/a.txt'), 'utf8')).toBe('a');
      expect(readFileSync(join(s.repo, 'tree/b.txt'), 'utf8')).toBe('b');
      expect(existsSync(join(s.repo, 'tree/a.txt'))).toBe(!moving);
    }
  });

  it('refuses a destination link planted after preflight without touching its target', async () => {
    const s = setup(), outside = tempFolder('mcp-link-race-');
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    const operation = transferPathTool({ worktree: s.repo, project: null, role: 'implementer' }, false, {
      beforeEntry: () => symlinkSync(outside, join(s.repo, 'raced'), process.platform === 'win32' ? 'junction' : 'dir'),
    });
    const result = await operation.call({ source: 'math.js', destination: 'raced', base: (await s.stat('math.js')).version });
    expect(result.success).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(outside)).toEqual(['keep.txt']);
  });

  it('bounds recursive work before mutating', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'large'));
    for (let i = 0; i < 1001; i++) writeFileSync(join(s.repo, 'large', `${i}.txt`), 'x');
    expect(await s.bad('copy_path', { source: 'large', destination: 'copy', recursive: true, preview: true })).toContain('1000');
    expect(existsSync(join(s.repo, 'copy'))).toBe(false);
    mkdirSync(join(s.repo, 'preview'));
    for (let i = 0; i < 180; i++) writeFileSync(join(s.repo, 'preview', `${String(i).padStart(3, '0')}-${'x'.repeat(100)}.txt`), '');
    const preview = await s.ok('stat_path', { path: 'preview', recursive: true });
    expect(JSON.parse(preview).tree.manifest_truncated).toBe(true);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(50 * 1024);
  });

  it('supports anchored tail reads, bounded multi-file reads and diffs', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(s.repo, 'b.txt'), 'one\nchanged\nthree\n');
    const tail = await s.ok('view_file', { path: 'a.txt', tail_lines: 1 });
    expect(tail).toContain('showing 3-3 of 3'); expect(tail).toContain('|three');
    await s.bad('view_file', { path: 'a.txt', tail_lines: 401 });
    await s.bad('view_file', { path: 'a.txt', tail_lines: 1, start_line: 1 });
    const multiple = await s.ok('view_files', { paths: ['a.txt', '.git/config', 'b.txt'], max_lines: 1 });
    expect(multiple).toContain('a.txt  file='); expect(multiple).toContain('ERROR'); expect(multiple).toContain('b.txt  file=');
    await s.bad('view_files', { paths: new Array(9).fill('a.txt') });
    const diff = await s.ok('diff_files', { left: 'a.txt', right: 'b.txt' });
    expect(diff).toContain('-two'); expect(diff).toContain('+changed');
    expect(await s.ok('diff_files', { left: 'a.txt', right: 'a.txt' })).toContain('identical');
    await s.bad('diff_files', { left: 'a.txt', right: '.git/config' });
    expect(Buffer.byteLength(multiple)).toBeLessThanOrEqual(50 * 1024);
    writeFileSync(join(s.repo, 'wide.txt'), `${'😀'.repeat(4000)}\n`.repeat(100));
    const bounded = await s.ok('view_files', { paths: ['wide.txt', 'wide.txt'], max_lines: 100 });
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(50 * 1024);
    expect(bounded).toContain('omitted');
    expect(await s.ok('diff_files', { left: 'a.txt', right: 'wide.txt', max_lines: 1 })).toContain('next: offset=');
  });

  it('reads large-file byte excerpts without granting edit-ready hashes and handles UTF-8 boundaries', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'large.txt'), 'hello\n'); truncateSync(join(s.repo, 'large.txt'), 17 * 1024 * 1024);
    expect(await s.bad('view_file', { path: 'large.txt' })).toContain('too large');
    const excerpt = await s.ok('read_excerpt', { path: 'large.txt', max_bytes: 6 });
    expect(excerpt).toContain('edit_ready=no'); expect(excerpt).toContain('hello'); expect(excerpt).not.toContain('file=');
    await s.bad('read_excerpt', { path: 'large.txt', byte_offset: 100, max_bytes: 8 });
    writeFileSync(join(s.repo, 'unicode.txt'), 'a😀b😀c');
    const first = await s.ok('read_excerpt', { path: 'unicode.txt', max_bytes: 4 });
    expect(first).toContain('next_byte_offset=1');
    const second = await s.ok('read_excerpt', { path: 'unicode.txt', byte_offset: 1, max_bytes: 4 });
    expect(second).toContain('😀'); expect(second).toContain('next_byte_offset=5');
    await s.bad('read_excerpt', { path: '.git/config' });
    await s.bad('read_excerpt', { path: 'unicode.txt', max_bytes: 32769 });
    writeFileSync(join(s.repo, 'invalid.txt'), Buffer.from([65, 66, 67, 255]));
    await s.bad('read_excerpt', { path: 'invalid.txt', max_bytes: 4 });
    writeFileSync(join(s.repo, 'invalid.txt'), Buffer.from([65, 66, 67, 255, 68]));
    await s.bad('read_excerpt', { path: 'invalid.txt', max_bytes: 4 });
    writeFileSync(join(s.repo, 'metadata-only.txt'), 'header'); truncateSync(join(s.repo, 'metadata-only.txt'), 65 * 1024 * 1024);
    expect(JSON.parse(await s.ok('stat_path', { path: 'metadata-only.txt' })).content_hashed).toBe(false);
    await s.bad('copy_path', { source: 'metadata-only.txt', destination: 'oversized-copy', preview: true });
    expect(existsSync(join(s.repo, 'oversized-copy'))).toBe(false);
  });
});
