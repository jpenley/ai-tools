import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileServerTools } from '../src/files/file-server.ts';
import { locateRipgrep } from '../src/files/search-files.ts';
import { gitTool } from '../src/git/git.ts';
import type { ToolReply } from '../src/contract.ts';
import { git, removeTempRepos, tempRepo } from './git.fixture.ts';

const text = (reply: ToolReply): string => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
afterEach(() => { vi.restoreAllMocks(); removeTempRepos(); });
function setup(ripgrep: string | null = null) {
  const repo = tempRepo();
  const place = { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') };
  const tools = fileServerTools({ worktree: repo, project: null }, place, 'full', ripgrep);
  const call = async (name: string, args: Record<string, unknown>) => tools.find(item => item.tool.name === name)!.call(args);
  const ok = async (name: string, args: Record<string, unknown>) => {
    const reply = await call(name, args);
    expect(reply.success, text(reply)).toBe(true);
    return text(reply);
  };
  return { repo, place, tools, call, ok };
}

describe('output controls at tool-call boundaries', () => {
  // Catches ignoring full, removing ordinary pagination, or treating full as offset=0.
  it.each(['list_dir', 'find_files'])('%s can return every remaining path without losing default pagination', async name => {
    const s = setup();
    mkdirSync(join(s.repo, 'items'));
    for (let i = 0; i < 205; i++) writeFileSync(join(s.repo, 'items', `${String(i).padStart(3, '0')}.txt`), 'item');
    const args = { path: 'items', ...(name === 'find_files' ? { pattern: '**/*.txt' } : {}) };
    const page = await s.ok(name, args);
    expect(page.split('\n')).toHaveLength(201);
    expect(page).toContain('next: offset=200');
    const full = await s.ok(name, { ...args, full: true });
    expect(full.split('\n')).toHaveLength(205);
    expect(full).toContain('items/204.txt');
    expect(full).not.toContain('next:');
    const remaining = await s.ok(name, { ...args, offset: 200, full: true });
    expect(remaining.split('\n')).toHaveLength(5);
    expect(remaining).not.toContain('items/199.txt');
  });

  // Catches line/byte/line-length caps leaking into full mode, or ignoring an explicit range.
  it('view_file returns uncut selected lines in full mode and retains range/tail selection', async () => {
    const s = setup();
    const long = '界😀'.repeat(2000);
    const content = [long, ...Array.from({ length: 450 }, (_, i) => `row-${i}-${'x'.repeat(250)}`)].join('\n');
    writeFileSync(join(s.repo, 'large.txt'), content);
    const page = await s.ok('view_file', { path: 'large.txt' });
    expect(page).toContain('[cut:');
    expect(page).toContain('next: start_line=');
    const full = await s.ok('view_file', { path: 'large.txt', full: true });
    expect(full.includes(long)).toBe(true);
    expect(full).toContain('row-449-');
    expect(full).not.toMatch(/\[cut:|next:/);
    expect(Buffer.byteLength(full)).toBeGreaterThan(50 * 1024);
    const selected = await s.ok('view_file', { path: 'large.txt', full: true, start_line: 2, end_line: 4 });
    expect(selected).toContain('showing 2-4 of 451');
    expect(selected).not.toContain('row-3-');
    const tail = await s.ok('view_file', { path: 'large.txt', full: true, tail_lines: 2 });
    expect(tail).toContain('showing 450-451 of 451');
  });

  // Catches skipped files, offset ignored on continuation, or max_lines still capping full output.
  it('view_files paginates by path index and full mode returns all selected files and lines', async () => {
    const s = setup();
    const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    for (const path of paths) writeFileSync(join(s.repo, path), Array.from({ length: 100 }, (_, i) => `${path}-${i}-${'x'.repeat(200)}`).join('\n'));
    const first = await s.ok('view_files', { paths, max_lines: 100 });
    expect(first).toContain('next: offset=2');
    expect(first).not.toContain('c.txt-0-');
    const second = await s.ok('view_files', { paths, max_lines: 100, offset: 2 });
    expect(second).toContain('c.txt-0-');
    expect(second).toContain('d.txt-99-');
    expect(second).not.toContain('a.txt-0-');
    expect(second).not.toContain('next: offset=');
    const full = await s.ok('view_files', { paths, max_lines: 1, full: true });
    for (const path of paths) expect(full).toContain(`${path}-99-`);
    expect(full).not.toMatch(/omitted:|continue:|next:/);
    expect(Buffer.byteLength(full)).toBeGreaterThan(50 * 1024);
    const remaining = await s.ok('view_files', { paths, offset: 3, full: true });
    expect(remaining).toContain('d.txt-99-');
    expect(remaining).not.toContain('c.txt-0-');
  });

  // Catches full diffs still clipping records or long lines, and dropping stale-continuation checks.
  it('diff_files returns complete uncut diffs in full mode while retaining continuation hashes', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'before.txt'), 'before\n');
    const long = '界😀'.repeat(2000);
    writeFileSync(join(s.repo, 'after.txt'), [long, ...Array.from({ length: 450 }, (_, i) => `added-${i}-${'x'.repeat(250)}`)].join('\n'));
    const args = { left: 'before.txt', right: 'after.txt' };
    const page = await s.ok('diff_files', args);
    expect(page).toContain('next: offset=');
    const full = await s.ok('diff_files', { ...args, max_lines: 1, full: true });
    expect(full.includes(`+${long}`)).toBe(true);
    expect(full).toContain('+added-449-');
    expect(full).not.toMatch(/\[cut:|next:/);
    expect(Buffer.byteLength(full)).toBeGreaterThan(50 * 1024);
    expect((await s.call('diff_files', { ...args, offset: 1, full: true })).success).toBe(false);
    const left_base = /left_base=([0-9a-f]+)/.exec(page)![1];
    const right_base = /right_base=([0-9a-f]+)/.exec(page)![1];
    const remaining = await s.ok('diff_files', { ...args, offset: 2, left_base, right_base, full: true });
    expect(remaining).not.toContain('-before');
    expect(remaining).toContain('+added-449-');
  });

  // Catches reply caps or long-line cuts in full searches, and bypassed collection safeguards.
  it('search_files returns all collected matches uncut but still refuses excessive collection', async () => {
    const ripgrep = locateRipgrep(() => {});
    expect(ripgrep).not.toBeNull();
    const s = setup(ripgrep);
    const long = 'hit-long-' + '界😀'.repeat(2000);
    writeFileSync(join(s.repo, 'hits.txt'), [long, ...Array.from({ length: 204 }, (_, i) => `hit-${i}-${'x'.repeat(300)}`)].join('\n'));
    const args = { pattern: '^hit', path: 'hits.txt' };
    const page = await s.ok('search_files', args);
    expect(page).toContain('[cut:');
    expect(page).toContain('next: offset=');
    const full = await s.ok('search_files', { ...args, full: true });
    expect(full.includes(long)).toBe(true);
    expect(full.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(205);
    expect(full).toContain('hit-203-');
    expect(full).not.toMatch(/\[cut:|next:/);
    const remaining = await s.ok('search_files', { ...args, offset: 200, full: true });
    expect(remaining.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(5);
    writeFileSync(join(s.repo, 'too-many.txt'), 'hit\n'.repeat(10_001));
    const refused = await s.call('search_files', { pattern: '^hit', path: 'too-many.txt', full: true });
    expect(refused.success).toBe(false);
    expect(text(refused)).toContain('10,000 matches');
  });

  // Catches dropped characters/newlines at byte or line page boundaries and replayed reads.
  it('git offers lossless snapshot pagination and full output including very long Unicode lines', async () => {
    const s = setup();
    git(s.repo, 'config', 'core.autocrlf', 'false');
    const content = '界😀'.repeat(12_000) + '\r\n' + Array.from({ length: 2505 }, (_, i) => `row-${i}\n`).join('') + 'no final newline';
    writeFileSync(join(s.repo, 'output.txt'), content);
    git(s.repo, 'add', 'output.txt');
    git(s.repo, 'commit', '-qm', 'Add output fixture');
    const tool = gitTool(s.place);
    const first = await tool.call({ args: ['show', 'HEAD:output.txt'] });
    expect(first.success).toBe(true);
    const marker = /\nnext: cursor=([^\s]+)$/.exec(text(first));
    expect(marker).not.toBeNull();
    expect(Buffer.byteLength(text(first))).toBeLessThanOrEqual(50 * 1024);
    const allRemaining = await tool.call({ cursor: marker![1], full: true });
    expect(allRemaining.success).toBe(true);
    expect(text(first).slice(0, marker!.index) + text(allRemaining) === content).toBe(true);
    let reply = first;
    let reconstructed = '';
    for (let page = 0; page < 20; page++) {
      const value = text(reply);
      expect(reply.success).toBe(true);
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(50 * 1024);
      const next = /\nnext: cursor=([^\s]+)$/.exec(value);
      reconstructed += next ? value.slice(0, next.index) : value;
      if (!next) break;
      reply = await tool.call({ cursor: next[1] });
    }
    expect(reconstructed === content).toBe(true);
    const full = await tool.call({ args: ['show', 'HEAD:output.txt'], full: true });
    expect(full.success).toBe(true);
    expect(text(full) === content).toBe(true);
    expect((await gitTool(s.place).call({ cursor: marker![1] })).success).toBe(false);
  });

  // Catches continuation accidentally re-executing a commit, and conflicts validated after a write.
  it('git continuation never reruns mutations and rejects cursor-plus-command before execution', async () => {
    const s = setup();
    git(s.repo, 'config', 'core.autocrlf', 'false');
    git(s.repo, 'config', 'user.name', 'Test');
    git(s.repo, 'config', 'user.email', 'test@example.invalid');
    mkdirSync(join(s.repo, 'many'));
    for (let i = 0; i < 2100; i++) writeFileSync(join(s.repo, 'many', `${i}.txt`), 'item');
    git(s.repo, 'add', 'many');
    const tool = gitTool(s.place, 'full');
    const committed = await tool.call({ args: ['commit', '-m', 'Many files'] });
    expect(committed.success, text(committed)).toBe(true);
    const cursor = /\nnext: cursor=([^\s]+)$/.exec(text(committed))?.[1];
    expect(cursor).toBeDefined();
    const continued = await tool.call({ cursor, full: true });
    expect(continued.success, text(continued)).toBe(true);
    expect(git(s.repo, 'rev-list', '--count', 'HEAD')).toBe('2');
    writeFileSync(join(s.repo, 'pending.txt'), 'not staged');
    expect((await tool.call({ cursor, args: ['add', 'pending.txt'] })).success).toBe(false);
    expect(git(s.repo, 'diff', '--cached', '--name-only')).toBe('');
  }, 30_000);

  // Catches treating process overflow as successful complete output in either output mode.
  it.each([false, true])('git retains its process-buffer safeguard with full=%s', async full => {
    const s = setup();
    writeFileSync(join(s.repo, 'overflow.txt'), 'x'.repeat(17 * 1024 * 1024));
    git(s.repo, 'add', 'overflow.txt');
    git(s.repo, 'commit', '-qm', 'Add oversized output fixture');
    const reply = await gitTool(s.place).call({ args: ['show', 'HEAD:overflow.txt'], full });
    expect(reply.success).toBe(false);
    expect(text(reply)).toMatch(/buffer|16 MiB/i);
    expect(text(reply)).not.toContain('next: cursor=');
  });

  // Catches a cursor cache growing without bounds, expired snapshots staying accessible, or eviction replaying commands.
  it('git cursors expire and older snapshots are evicted without replaying commands', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'pages.txt'), 'line\n'.repeat(2100));
    git(s.repo, 'add', 'pages.txt');
    git(s.repo, 'commit', '-qm', 'Add paginated fixture');
    const tool = gitTool(s.place);
    const cursors: string[] = [];
    for (let i = 0; i < 5; i++) {
      const reply = await tool.call({ args: ['show', 'HEAD:pages.txt'] });
      expect(reply.success).toBe(true);
      cursors.push(/\nnext: cursor=([^\s]+)$/.exec(text(reply))![1]!);
    }
    expect((await tool.call({ cursor: cursors[0] })).success).toBe(false);
    expect((await tool.call({ cursor: cursors[1] })).success).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 1000 + 1);
    const expired = await tool.call({ cursor: cursors[4] });
    expect(expired.success).toBe(false);
    expect(text(expired)).toContain('expired');
  });

  // Catches an omitted first file causing an endless offset=0 loop at the normal reply budget.
  it('view_files makes progress for a file that nearly fills a normal page', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'dense.txt'), ('x'.repeat(1900) + '\n').repeat(100));
    const reply = await s.ok('view_files', { paths: ['dense.txt'], max_lines: 100 });
    expect(reply).toContain('1:');
    expect(reply).toContain('next: start_line=');
    expect(reply).not.toContain('next: offset=0');
    expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(50 * 1024);
  });

  // Catches recoverable aggregate-budget exhaustion consuming a path as a permanent per-file failure.
  it.each([false, true])('view_files defers individually valid files at the aggregate input budget with full=%s', async full => {
    const s = setup();
    writeFileSync(join(s.repo, 'budget-a.txt'), 'a'.repeat(10 * 1024 * 1024));
    writeFileSync(join(s.repo, 'budget-b.txt'), 'b'.repeat(10 * 1024 * 1024));
    const paths = ['budget-a.txt', 'budget-b.txt'];
    const first = await s.ok('view_files', { paths, full });
    expect(first.includes('next: offset=1')).toBe(true);
    expect(first.includes('ERROR:')).toBe(false);
    const second = await s.ok('view_files', { paths, offset: 1, full });
    expect(second.includes('budget-b.txt  file=')).toBe(true);
    expect(second.includes('ERROR:')).toBe(false);
    expect(second.includes('next: offset=')).toBe(false);
  });

  // Catches permissive full parsing or an override skipping access and per-file read limits.
  it('every tool validates full and full mode preserves protected-path and input-size checks', async () => {
    const ripgrep = locateRipgrep(() => {});
    expect(ripgrep).not.toBeNull();
    const s = setup(ripgrep);
    const calls: Array<[string, Record<string, unknown>]> = [
      ['list_dir', { path: '.' }], ['find_files', { pattern: '**' }],
      ['search_files', { pattern: 'add', path: 'math.js' }], ['view_file', { path: 'math.js' }],
      ['view_files', { paths: ['math.js'] }], ['diff_files', { left: 'math.js', right: 'math.js' }],
    ];
    for (const [name, args] of calls) {
      expect(s.tools.find(tool => tool.tool.name === name)!.tool.inputSchema).toHaveProperty('properties.full');
      for (const full of [null, 0, -1, '', 'true']) {
        const reply = await s.call(name, { ...args, full });
        expect(reply.success, name).toBe(false);
        expect(text(reply)).toContain('full must be');
      }
      expect((await s.call(name, { ...args, full: false })).success, name).toBe(true);
    }
    const tool = gitTool(s.place);
    for (const full of [null, 0, -1, '', 'true']) expect((await tool.call({ args: ['status'], full })).success).toBe(false);
    expect((await tool.call({ args: ['status'], full: false })).success).toBe(true);
    expect((await tool.call({ args: ['add', '.'], full: true })).success).toBe(false);
    expect((await s.call('view_file', { path: '.git/config', full: true })).success).toBe(false);
    expect((await s.call('view_files', { paths: ['.git/config'], full: true })).content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('ERROR:') })]));
    writeFileSync(join(s.repo, 'oversized.txt'), 'x'.repeat(16 * 1024 * 1024 + 1));
    expect((await s.call('view_file', { path: 'oversized.txt', full: true })).success).toBe(false);
    expect((await s.call('diff_files', { left: 'math.js', right: 'oversized.txt', full: true })).success).toBe(false);
    const multi = await s.ok('view_files', { paths: ['oversized.txt'], full: true });
    expect(multi).toContain('ERROR:');
  });
});
