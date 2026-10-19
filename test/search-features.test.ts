import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { fileServerTools } from '../src/files/file-server.ts';
import { DirectoryPermissions } from '../src/files/directory-permissions.ts';
import { realpathSync } from 'node:fs';
import { MCPSession } from './mcp-client.fixture.ts';
import { locateRipgrep, searchFilesTool, type RipgrepProcess } from '../src/files/search-files.ts';
import type { ToolReply } from '../src/contract.ts';
import { git, removeTempRepos, tempFolder, tempRepo } from './git.fixture.ts';

const text = (reply: ToolReply): string => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
afterEach(removeTempRepos);
function setup() {
  const repo = tempRepo();
  const ripgrep = locateRipgrep(() => {});
  expect(ripgrep).not.toBeNull();
  const tools = fileServerTools({ worktree: repo, project: null }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git/no-hooks') }, 'full', ripgrep);
  const call = (name: string, args: Record<string, unknown>) => tools.find(item => item.tool.name === name)!.call(args);
  const ok = async (name: string, args: Record<string, unknown>) => {
    const reply = await call(name, args);
    expect(reply.success, text(reply)).toBe(true);
    return text(reply);
  };
  return { repo, tools, call, ok };
}

describe('search discovery features', () => {
  // Catches literal matching still interpreting regex metacharacters, or changing the regex default.
  it('matches a literal pattern without changing the default regular expression search', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'literals.txt'), 'a.b\naxb\nA.B\n');
    const literal = await s.ok('search_files', { pattern: 'a.b', path: 'literals.txt', literal: true });
    expect(literal).toMatch(/1:[0-9a-f]+\|a\.b/);
    expect(literal).not.toContain('|axb');
    expect(literal).not.toContain('|A.B');
    const regex = await s.ok('search_files', { pattern: 'a.b', path: 'literals.txt' });
    expect(regex).toContain('|axb');
    const folded = await s.ok('search_files', { pattern: 'a.b', path: 'literals.txt', literal: true, case_insensitive: true });
    expect(folded).toContain('|A.B');
  });

  // Catches treating pattern arrays as regexes, AND matching, or counting a line more than once.
  it('searches multiple literal patterns with OR logic and emits each matching line once', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'names.txt'), 'firstName\nfirst_name\nfirstName and first_name\nfirstXname\n');
    const output = await s.ok('search_files', { patterns: ['firstName', 'first_name', 'firstName'], path: 'names.txt' });
    expect(output.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(3);
    expect(output).toContain('|firstName');
    expect(output).toContain('|first_name');
    expect(output).not.toContain('|firstXname');
    const dot = await s.ok('search_files', { patterns: ['first.name'], path: 'names.txt' });
    expect(dot).toContain('No line matches');
  });

  // Catches missing/duplicated context and exclusions interpreted relative to the narrowed path.
  it('merges anchored context windows and excludes whole canonical paths', async () => {
    const s = setup();
    mkdirSync(join(s.repo, 'test'));
    writeFileSync(join(s.repo, 'context.txt'), 'first\nhit-one\nbetween\nhit-two\nlast\n');
    writeFileSync(join(s.repo, 'test/hidden.txt'), 'hit-hidden\n');
    const output = await s.ok('search_files', { pattern: 'hit', context: 1, exclude: ['TEST/**'] });
    expect(output).not.toContain('hidden');
    expect(output).toMatch(/context 1:[0-9a-f]+\|first/);
    expect(output).toMatch(/context 3:[0-9a-f]+\|between/);
    expect(output).toMatch(/context 5:[0-9a-f]+\|last/);
    const records = output.split('\n').filter(line => /^(?:context )?\d+:[0-9a-f]+\|/.test(line));
    expect(records).toHaveLength(5);
    const view = await s.ok('view_file', { path: 'context.txt' });
    for (const line of records) expect(view).toContain(line.replace(/^context /, ''));
  });

  // Catches glob-only discovery, unstable ranking, and rebased or ignored exclusions.
  it('ranks fuzzy filename matches explicitly while keeping the glob default', async () => {
    const s = setup();
    mkdirSync(join(s.repo, 'folder/foo'), { recursive: true });
    mkdirSync(join(s.repo, 'excluded'));
    for (const name of ['xfoo.ts', 'foobar.ts', 'foo.ts', 'foo', 'f-o-o.ts', 'folder/foo/bar.ts', 'excluded/foo']) writeFileSync(join(s.repo, name), 'file');
    const result = await s.ok('find_files', { pattern: 'FOO', mode: 'fuzzy', exclude: ['excluded/**'] });
    expect(result.split('\n')).toEqual(['foo', 'foo.ts', 'foobar.ts', 'xfoo.ts', 'f-o-o.ts', 'folder/foo/bar.ts']);
    expect(await s.ok('find_files', { pattern: 'foo' })).toBe('foo');
    expect(await s.ok('find_files', { pattern: 'foo', mode: 'fuzzy', path: 'folder', exclude: ['foo/**'] })).toBe('folder/foo/bar.ts');
    expect(await s.ok('find_files', { pattern: 'foo', mode: 'fuzzy', path: 'folder', exclude: ['folder/**'] })).toContain('No file matches');
  });

  // Catches ambiguous selectors, implicit multiline OR, and unbounded input expansion.
  it('refuses malformed selectors, context, and exclusion arrays at the boundary', async () => {
    const s = setup();
    const invalid = [
      {}, { pattern: '', patterns: ['x'] }, { pattern: 'x', patterns: ['y'] },
      { patterns: [] }, { patterns: null }, { patterns: 'x' }, { patterns: [null] }, { patterns: [''] },
      { patterns: ['x'], literal: false }, { pattern: 'x', literal: 'maybe' },
      { patterns: Array(33).fill('x') }, { patterns: Array.from({ length: 5 }, (_, i) => 'a'.repeat(1999) + i) },
      { pattern: 'x\ny', literal: true }, { patterns: ['x\ry'] }, { patterns: ['x\0y'] },
      ...[-1, 21, 0.5, null, '1', NaN, Infinity].map(context => ({ pattern: 'x', context })),
      ...[null, 'test/**', [null], [''], Array(17).fill('x'), ['a'.repeat(513)]].map(exclude => ({ pattern: 'x', exclude })),
    ];
    for (const args of invalid) expect((await s.call('search_files', args)).success, JSON.stringify(args)).toBe(false);
    for (const args of [{ mode: null }, { mode: 'auto' }, { mode: 'fuzzy', pattern: ' ' }, { mode: 'fuzzy', pattern: 'x\ny' }, { mode: 'fuzzy', pattern: 'x'.repeat(513) }, { exclude: null }]) {
      expect((await s.call('find_files', { pattern: 'x', ...args })).success, JSON.stringify(args)).toBe(false);
    }
  });

  // Catches argv option injection and confusing backslash+n with an actual LF.
  it('keeps literal Unicode, backslashes, and leading dashes as data', async () => {
    const s = setup();
    const slashN = String.fromCharCode(92) + 'n';
    writeFileSync(join(s.repo, 'special.txt'), ['--hidden', slashN, '界😀'].join('\n'));
    for (const pattern of ['--hidden', slashN, '界😀']) {
      expect(await s.ok('search_files', { pattern, literal: true, path: 'special.txt' })).toContain(`|${pattern}`);
    }
  });

  // Catches context contributing to offsets and future hits accidentally consumed as context.
  it('paginates by matches even when context overlaps the page boundary', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'many.txt'), Array.from({ length: 205 }, (_, i) => `hit-${i}`).join('\n'));
    const args = { patterns: ['hit-', 'hit-0'], context: 1, path: 'many.txt' };
    const page = await s.ok('search_files', args);
    expect(page).toContain('next: offset=200');
    expect(page.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(200);
    expect(page).toMatch(/context 201:[0-9a-f]+\|hit-200/);
    const rest = await s.ok('search_files', { ...args, offset: 200 });
    expect(rest.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(5);
    expect(rest).not.toContain('next:');
    const all = await s.ok('search_files', { ...args, full: true });
    expect(all.split('\n').filter(line => /^\d+:[0-9a-f]+\|/.test(line))).toHaveLength(205);
    expect(all).not.toContain('context ');
  });

  // Catches oversized first windows overflowing replies or preventing match progress.
  it('makes progress with oversized Unicode context and preserves full output', async () => {
    const s = setup();
    const wide = '界😀'.repeat(1500);
    writeFileSync(join(s.repo, 'wide.txt'), [...Array(20).fill(wide), 'needle-one', ...Array(20).fill(wide), 'needle-two'].join('\n'));
    const args = { patterns: ['needle-'], context: 20, path: 'wide.txt' };
    const first = await s.ok('search_files', args);
    expect(first).toContain('|needle-one'); expect(first).toContain('context omitted:');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(50 * 1024);
    expect(first).toContain('next: offset=1');
    const last = await s.ok('search_files', { ...args, offset: 1 });
    expect(last).toContain('|needle-two'); expect(last).not.toContain('next:');
    const all = await s.ok('search_files', { ...args, full: true });
    expect(all).not.toContain('[cut:'); expect(all).not.toContain('context omitted:');
    expect(all).toContain(wide); expect(all).toContain('|needle-two');
  });

  // Catches literal OR bypassing the common collection ceiling.
  it('retains the match ceiling with multiple literals and full context output', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'flood.txt'), 'hit\n'.repeat(10_001));
    const reply = await s.call('search_files', { patterns: ['hit', 'hi'], context: 20, full: true, path: 'flood.txt' });
    expect(reply.success).toBe(false); expect(text(reply)).toContain('10,000 matches');
  });

  // Catches postfilter-only exclusions, empty batches scanning '.', and denied files reaching rg.
  it('passes only authorized non-excluded files to rg and skips empty selections', async () => {
    const repo = tempRepo();
    mkdirSync(join(repo, 'blocked')); mkdirSync(join(repo, 'private'));
    writeFileSync(join(repo, 'blocked/no.txt'), 'hidden'); writeFileSync(join(repo, 'private/no.txt'), 'private');
    for (let i = 0; i < 70; i++) writeFileSync(join(repo, `allowed-${i}.txt`), 'visible');
    const permissions = new DirectoryPermissions({ directories: [{ path: join(repo, 'private'), access: 'deny' }] }, realpathSync);
    const invoked: string[][] = [];
    const run = (args: readonly string[], cwd: string) => { invoked.push([...args]); return spawn(process.execPath, ['-e', 'process.exit(1)'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as RipgrepProcess; };
    const place = { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git/no-hooks') };
    const operation = searchFilesTool({ worktree: repo, project: null, role: 'reader', permissions }, place, 'unused', { run });
    const result = await operation.call({ patterns: ['hit'], glob: '**/*.txt', exclude: ['blocked/**'] });
    expect(result.success, text(result)).toBe(true); expect(invoked.length).toBeGreaterThan(1);
    const paths = invoked.flatMap(args => args.slice(args.indexOf('--') + 1));
    expect(paths).toHaveLength(70); expect(paths.every(path => path.startsWith('allowed-'))).toBe(true);
    invoked.length = 0;
    expect((await operation.call({ pattern: 'hit', exclude: ['**'] })).success).toBe(true);
    expect(invoked).toEqual([]);
    // Legacy library callers have no directory rules; exclusions must still force file batching.
    const legacy = searchFilesTool({ worktree: repo, project: null, role: 'reader' }, place, 'unused', { run });
    expect((await legacy.call({ pattern: 'hit', exclude: ['**'] })).success).toBe(true);
    expect(invoked).toEqual([]);
  });

  // Catches unstable ranking, wrong full/offset behavior, and ignored files leaking into discovery.
  it('keeps fuzzy ties, pagination, full output, and ignored-file selection deterministic', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'items'));
    for (let i = 204; i >= 0; i--) writeFileSync(join(s.repo, `items/${String(i).padStart(3, '0')}-ff.txt`), 'file');
    writeFileSync(join(s.repo, '.gitignore'), 'ignored-ff.txt\n'); writeFileSync(join(s.repo, 'ignored-ff.txt'), 'ignored');
    const args = { pattern: 'ff', mode: 'fuzzy', path: 'items' };
    const page = await s.ok('find_files', args);
    expect(page.split('\n')[0]).toBe('items/000-ff.txt'); expect(page).toContain('next: offset=200');
    expect((await s.ok('find_files', { ...args, offset: 200, full: true })).split('\n')).toEqual(['items/200-ff.txt', 'items/201-ff.txt', 'items/202-ff.txt', 'items/203-ff.txt', 'items/204-ff.txt']);
    expect((await s.ok('find_files', { ...args, full: true })).split('\n')).toHaveLength(205);
    expect(await s.ok('find_files', { pattern: 'ignored', mode: 'fuzzy' })).toContain('No file matches');
    expect(await s.ok('find_files', { pattern: 'ignored', mode: 'fuzzy', include_ignored: true })).toBe('ignored-ff.txt');
    expect(await s.ok('find_files', { pattern: 'fiel', mode: 'fuzzy', path: 'items' })).toContain('No file matches');
  });

  // Catches glob syntax drifting for classes/alternatives and authorized external absolute paths.
  it('uses canonical exclusions and existing ignored-file rules for literal searches', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'src'));
    for (const name of ['src/a.ts', 'src/b.ts', 'src/c.md']) writeFileSync(join(s.repo, name), 'a.b');
    writeFileSync(join(s.repo, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(s.repo, 'ignored.txt'), 'a.b');
    const output = await s.ok('search_files', { pattern: 'a.b', literal: true, path: 'src', exclude: ['SRC/[ab].{ts,tsx}'] });
    expect(output).toContain('src/c.md'); expect(output).not.toContain('src/a.ts'); expect(output).not.toContain('src/b.ts');
    expect(await s.ok('search_files', { patterns: ['a.b'] })).not.toContain('ignored.txt');
    expect(await s.ok('search_files', { patterns: ['a.b'], include_ignored: true })).toContain('ignored.txt');
    git(s.repo, 'add', '-f', 'ignored.txt');
    expect(await s.ok('search_files', { patterns: ['a.b'] })).toContain('ignored.txt');
    const outside = tempFolder('search-external-');
    writeFileSync(join(outside, 'visible.txt'), 'a.b'); writeFileSync(join(outside, 'hidden.txt'), 'a.b');
    const tools = fileServerTools({ worktree: s.repo, project: null, directoryConfig: { config: { directories: [{ path: outside, access: 'read-only' }] } } }, { worktree: s.repo, gitDir: join(s.repo, '.git'), hooksPath: join(s.repo, '.git/no-hooks') }, 'read-only', locateRipgrep(() => {}));
    const result = await tools.find(item => item.tool.name === 'search_files')!.call({ patterns: ['a.b'], path: outside, exclude: ['**/hidden.txt'] });
    expect(result.success, text(result)).toBe(true);
    expect(text(result)).toContain('visible.txt'); expect(text(result)).not.toContain('hidden.txt');
  });

  // Catches missing transport schemas, overwritten descriptions, and options lost during dispatch.
  it('advertises and executes the new options over real MCP stdio', async () => {
    const repo = tempRepo(); mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/search-files.ts'), 'before\na.b\na_b\naXb\n');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const session = await MCPSession.open({ transport: 'stdio', command: process.execPath, args: [join(root, 'src/files/server.ts'), '--root', repo, '--access', 'read-only', '--ripgrep', locateRipgrep(() => {})!], cwd: root });
    try {
      const find = session.tools.find(tool => tool.name === 'find_files')!;
      const search = session.tools.find(tool => tool.name === 'search_files')!;
      expect(find.inputSchema).toHaveProperty('properties.mode.enum', ['glob', 'fuzzy']);
      expect(search.inputSchema).toHaveProperty('properties.patterns');
      expect(search.inputSchema).not.toHaveProperty('properties.literal.default');
      expect(search.inputSchema).toHaveProperty('properties.context.maximum', 20);
      expect(find.description).toContain('fuzzy'); expect(search.description).toContain('literal');
      const fuzzy = await session.call('find_files', { pattern: 'srchfl', mode: 'fuzzy' });
      expect(fuzzy.isError).toBe(false); expect(fuzzy.content[0]?.text).toBe('src/search-files.ts');
      const found = await session.call('search_files', { patterns: ['a.b', 'a_b'], context: 1 });
      expect(found.isError).toBe(false);
      const output = found.content[0]?.text ?? '';
      expect(output).toContain('|a.b'); expect(output).toContain('|a_b'); expect(output).toMatch(/context 1:[0-9a-f]+\|before/);
      expect((await session.call('search_files', { pattern: 'x', patterns: ['y'] })).isError).toBe(true);
    } finally { await session.close(); }
  });

  // Catches new matching modes bypassing permissions or exposing protected names.
  it('filters denied and credential paths before fuzzy ranking or literal content output', async () => {
    const repo = tempRepo(); mkdirSync(join(repo, 'blocked'));
    writeFileSync(join(repo, 'blocked/needle'), 'needle-private');
    writeFileSync(join(repo, 'needle-public.txt'), 'needle-public');
    writeFileSync(join(repo, '.env'), 'needle-credential');
    const tools = fileServerTools({ worktree: repo, project: null, directoryConfig: { config: { directories: [{ path: join(repo, 'blocked'), access: 'deny' }] } } }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git/no-hooks') }, 'read-only', locateRipgrep(() => {}));
    const fuzzy = await tools.find(item => item.tool.name === 'find_files')!.call({ pattern: 'needle', mode: 'fuzzy' });
    expect(fuzzy.success, text(fuzzy)).toBe(true); expect(text(fuzzy)).toBe('needle-public.txt');
    const found = await tools.find(item => item.tool.name === 'search_files')!.call({ patterns: ['needle'], context: 20 });
    expect(found.success, text(found)).toBe(true); expect(text(found)).toContain('|needle-public');
    expect(text(found)).not.toMatch(/private|credential|\.env|blocked/);
  });

  // Catches context anchors hashing normalized/rendered text instead of the reader's logical lines.
  it('preserves reader anchor parity for BOM, CRLF, and no final newline', async () => {
    const s = setup();
    writeFileSync(join(s.repo, 'crlf.txt'), '\ufeffbefore\r\nneedle\r\nafter');
    const output = await s.ok('search_files', { patterns: ['needle'], context: 20, path: 'crlf.txt' });
    const view = await s.ok('view_file', { path: 'crlf.txt' });
    const records = output.split('\n').filter(line => /^(?:context )?\d+:[0-9a-f]+\|/.test(line));
    expect(records).toHaveLength(3);
    for (const line of records) expect(view).toContain(line.replace(/^context /, ''));
    expect(output).toMatch(/context 1:[0-9a-f]+\|before/);
    expect(output).toMatch(/context 3:[0-9a-f]+\|after/);
  });

  // Catches silently trimming meaningful query characters and broadening fuzzy results.
  it('preserves spaces in valid fuzzy queries and documents first-greedy ranking', async () => {
    const s = setup();
    for (const name of ['foo.ts', ' foo.ts', 'foo bar.ts', 'a---a-b-c.ts', 'a--b--c.ts']) writeFileSync(join(s.repo, name), 'file');
    expect(await s.ok('find_files', { pattern: ' foo', mode: 'fuzzy' })).toBe(' foo.ts');
    expect(await s.ok('find_files', { pattern: 'foo ', mode: 'fuzzy' })).toBe('foo bar.ts');
    expect((await s.ok('find_files', { pattern: 'abc', mode: 'fuzzy' })).split('\n')).toEqual(['a--b--c.ts', 'a---a-b-c.ts']);
  });

  // Catches a UTF-8 byte overflow flushing an empty batch and accidentally scanning the root.
  it('never starts an empty rg batch for an individually long Unicode path', async () => {
    const s = setup();
    const outside = tempFolder('search-wide-path-');
    const win = process.platform === 'win32';
    const name = Array.from({ length: win ? 20 : 12 }, (_, i) => `${'界'.repeat(win ? 145 : 65)}${i}`).join('/') + '/needle.txt';
    if (win) expect(Buffer.byteLength(name)).toBeGreaterThan(8 * 1024);
    mkdirSync(join(outside, name, '..'), { recursive: true }); writeFileSync(join(outside, name), 'needle');
    const invoked: string[][] = [];
    const operation = searchFilesTool({ worktree: s.repo, project: null, role: 'reader', externalRead: true }, { worktree: s.repo, gitDir: join(s.repo, '.git'), hooksPath: join(s.repo, '.git/no-hooks') }, 'unused', {
      run: (args, cwd) => { invoked.push([...args]); return spawn(process.execPath, ['-e', 'process.exit(1)'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as RipgrepProcess; },
    });
    const reply = await operation.call({ patterns: ['needle'], path: outside, exclude: ['blocked/**'] });
    expect(reply.success, text(reply)).toBe(true);
    expect(invoked.map(args => args.slice(args.indexOf('--') + 1))).toEqual([[name]]);
  });

  // Catches independent argv budgets exceeding Windows' serialized command-line limit.
  it('searches quote-heavy literal arrays alongside large file batches and ignored-folder skips', async () => {
    const s = setup();
    const quote = String.fromCharCode(34);
    const patterns = [0, 1, 2, 3, 4].map(i => quote.repeat(i === 4 ? 191 : 1999) + i);
    expect(patterns.reduce((sum, value) => sum + Buffer.byteLength(value), 0)).toBe(8192);
    for (let i = 0; i < 70; i++) writeFileSync(join(s.repo, `allowed-${String(i).padStart(2, '0')}-${'a'.repeat(119)}.txt`), 'ordinary text');
    writeFileSync(join(s.repo, '.gitignore'), 'ignored-*/\n');
    for (let i = 0; i < 60; i++) {
      const folder = join(s.repo, `ignored-${i}-${'b'.repeat(130)}`);
      mkdirSync(folder); writeFileSync(join(folder, 'skip.txt'), 'ordinary text');
    }
    expect(await s.ok('search_files', { patterns })).toContain('No line matches');
  });

  // Catches stripping a POSIX absolute exclusion's root; this uses native absolute paths on each OS.
  it('honors absolute external exclusions in both tools before dispatching rg', async () => {
    const s = setup(), outside = tempFolder('search-rooted-exclusions-');
    mkdirSync(join(s.repo, 'src')); writeFileSync(join(s.repo, 'src/rooted.txt'), 'needle');
    expect(await s.ok('find_files', { pattern: '/src/**' })).toBe('src/rooted.txt');
    expect(await s.ok('find_files', { pattern: '**', exclude: ['/src/**'] })).not.toContain('src/rooted.txt');
    expect(await s.ok('search_files', { patterns: ['needle'], exclude: ['/src/**'] })).toContain('No line matches');
    writeFileSync(join(outside, 'visible.txt'), 'needle'); writeFileSync(join(outside, 'hidden.txt'), 'needle');
    const absolute = realpathSync(join(outside, 'hidden.txt')).replaceAll(String.fromCharCode(92), '/');
    const roots = { worktree: s.repo, project: null, directoryConfig: { config: { directories: [{ path: outside, access: 'read-only' as const }] } } };
    const place = { worktree: s.repo, gitDir: join(s.repo, '.git'), hooksPath: join(s.repo, '.git/no-hooks') };
    const tools = fileServerTools(roots, place, 'read-only', locateRipgrep(() => {}));
    for (const mode of ['glob', 'fuzzy']) {
      const reply = await tools.find(item => item.tool.name === 'find_files')!.call({ pattern: mode === 'glob' ? '**' : 'txt', mode, path: outside, exclude: [absolute] });
      expect(reply.success, text(reply)).toBe(true); expect(text(reply)).toContain('visible.txt'); expect(text(reply)).not.toContain('hidden.txt');
    }
    const invoked: string[][] = [];
    const operation = searchFilesTool({ worktree: s.repo, project: null, role: 'reader', externalRead: true }, place, 'unused', {
      run: (args, cwd) => { invoked.push([...args]); return spawn(process.execPath, ['-e', 'process.exit(1)'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as RipgrepProcess; },
    });
    const reply = await operation.call({ patterns: ['needle'], path: outside, exclude: [absolute] });
    expect(reply.success, text(reply)).toBe(true);
    expect(invoked.map(args => args.slice(args.indexOf('--') + 1))).toEqual([['visible.txt']]);
  });
});
