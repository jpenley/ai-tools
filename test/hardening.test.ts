import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fileServerTools } from '../src/files/file-server.ts';
import { startCall, readText } from '../src/files/files.ts';
import { deleteFileTool } from '../src/files/delete-file.ts';
import { gitArguments, gitTool, gitVerdict } from '../src/git/git.ts';
import { locateRipgrep } from '../src/files/search-files.ts';
import { RequestQueue } from '../src/mcp/request-queue.ts';
import { git, removeTempRepos, tempFolder, tempRepo } from './git.fixture.ts';
import type { ToolReply } from '../src/contract.ts';

const text = (reply: ToolReply) => reply.content.map(part => part.type === 'text' ? part.text : '').join('');
afterEach(removeTempRepos);
function setup(mode: 'full' | 'read-only' = 'full', repo = tempRepo(), directories?: Array<{ path: string; access: string }>) {
  const place = { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(tempFolder('empty-hooks-'), 'hooks') };
  mkdirSync(place.hooksPath);
  const tools = fileServerTools({ worktree: repo, project: null, ...(directories === undefined ? {} : { directoryConfig: { config: { directories } } }) }, place, mode, locateRipgrep(() => {}));
  const call = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.tool.name === name)!.call(args);
  const ok = async (name: string, args: Record<string, unknown>) => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(true); return text(reply); };
  const bad = async (name: string, args: Record<string, unknown>) => { const reply = await call(name, args); expect(reply.success, text(reply)).toBe(false); return text(reply); };
  const stat = async (path: string) => JSON.parse(await ok('stat_path', { path })) as { version: string; hash?: string; writable: boolean; permission: { access: string } };
  return { repo, place, tools, call, ok, bad, stat };
}
const directoryLink = (target: string, name: string) => symlinkSync(target, name, process.platform === 'win32' ? 'junction' : 'dir');

describe('read-only link traversal and hardening', { timeout: 30_000 }, () => {
  it('reads linked directories, reports read-only, copies bytes and refuses every mutation through them', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'real'));
    writeFileSync(join(s.repo, 'real/note.txt'), 'linked marker\n');
    directoryLink(join(s.repo, 'real'), join(s.repo, 'alias'));
    expect(await s.ok('view_file', { path: 'alias/note.txt' })).toContain('linked marker');
    expect(await s.ok('read_excerpt', { path: 'alias/note.txt' })).toContain('linked marker');
    expect(await s.ok('view_files', { paths: ['alias/note.txt'] })).toContain('linked marker');
    expect(await s.ok('list_dir', { path: 'alias' })).toContain('note.txt');
    expect(await s.ok('find_files', { path: 'alias', pattern: '**/*.txt' })).toContain('note.txt');
    if (s.tools.some(tool => tool.tool.name === 'search_files')) expect(await s.ok('search_files', { path: 'alias', pattern: 'marker' })).toContain('linked marker');
    const info = await s.stat('alias/note.txt');
    expect(info.writable).toBe(false); expect(info.permission.access).toBe('read-only');
    await s.ok('copy_path', { source: 'alias/note.txt', destination: 'copied.txt', base: info.version });
    await s.ok('copy_path', { source: 'alias', destination: 'copied-dir', base: JSON.parse(await s.ok('stat_path', { path: 'alias', recursive: true })).version, recursive: true });
    for (const [name, args] of [
      ['write_file', { path: 'alias/new.txt', content: 'no' }],
      ['edit_file', { path: 'alias/note.txt', edits: [{ op: 'replace_text', old: 'linked', new: 'changed' }] }],
      ['delete_file', { path: 'alias/note.txt', base: info.version }],
      ['make_directory', { path: 'alias/new-dir' }],
      ['move_path', { source: 'alias/note.txt', destination: 'moved', base: info.version }],
      ['copy_path', { source: 'copied.txt', destination: 'alias/dest', base: (await s.stat('copied.txt')).version }],
      ['remove_directory', { path: 'alias', recursive: true, preview: true }],
    ] as const) await s.bad(name, args);
    expect(readFileSync(join(s.repo, 'real/note.txt'), 'utf8')).toBe('linked marker\n');
    expect(s.tools.some(tool => /^(symlink|junction|link_path|create_link)$/.test(tool.tool.name))).toBe(false);
  });

  it('retains link read-only even when the destination has an explicit full grant', async () => {
    const repo = tempRepo(), target = tempFolder('link-grant-');
    writeFileSync(join(target, 'note.txt'), 'target'); directoryLink(target, join(repo, 'alias'));
    const s = setup('full', repo, [{ path: target, access: 'full' }]);
    await s.ok('write_file', { path: join(target, 'direct.txt'), content: 'direct' });
    expect((await s.stat('alias/note.txt')).permission.access).toBe('read-only');
    await s.bad('write_file', { path: 'alias/forbidden.txt', content: 'no' });
    await s.bad('delete_file', { path: 'alias/note.txt', base: (await s.stat('alias/note.txt')).version });
    const reader = setup('read-only', repo, [{ path: target, access: 'full' }]);
    expect(await reader.ok('view_file', { path: 'alias/note.txt' })).toContain('target');
    await setup('read-only', repo).bad('view_file', { path: 'alias/note.txt' });
  });

  it('does not bypass denied alias descendants, denied targets, credentials or Git internals', async () => {
    const repo = tempRepo(), target = tempFolder('link-deny-');
    mkdirSync(join(target, 'private')); writeFileSync(join(target, 'private/note.txt'), 'hidden');
    writeFileSync(join(target, '.env'), 'hidden'); directoryLink(target, join(repo, 'alias'));
    const s = setup('full', repo, [{ path: join(target, 'private'), access: 'deny' }]);
    await s.bad('view_file', { path: 'alias/private/note.txt' });
    await s.bad('view_file', { path: 'alias/.env' });
    directoryLink(join(repo, '.git'), join(repo, 'git-alias'));
    await s.bad('view_file', { path: 'git-alias/config' });
    // A rule on an existing physical directory under the alias canonicalizes to
    // the target at startup; linked rule roots themselves remain invalid.
    mkdirSync(join(repo, '.ssh')); directoryLink(target, join(repo, '.ssh/hidden'));
    await s.bad('view_file', { path: '.ssh/hidden/private/note.txt' });
  });

  it('rejects cycles and rechecks retargeted links before reading', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'one')); mkdirSync(join(s.repo, 'two'));
    writeFileSync(join(s.repo, 'one/note.txt'), 'one'); writeFileSync(join(s.repo, 'two/note.txt'), 'two');
    directoryLink(join(s.repo, 'one'), join(s.repo, 'alias'));
    const path = startCall({ worktree: s.repo, project: null, role: 'reader', externalRead: true }).judge('alias/note.txt', 'read');
    expect(path.ok).toBe(true);
    renameSync(join(s.repo, 'alias'), join(s.repo, 'old-alias')); directoryLink(join(s.repo, 'two'), join(s.repo, 'alias'));
    if (path.ok) expect(readText(path).ok).toBe(false);
    directoryLink(join(s.repo, 'one'), join(s.repo, 'one/loop'));
    await s.bad('stat_path', { path: 'one/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/loop/note.txt' });
  });

  it.skipIf(process.platform === 'win32')('supports file symlinks without allowing mutation of the link or its target', async () => {
    const s = setup(); symlinkSync('math.js', join(s.repo, 'alias.js'));
    expect(await s.ok('view_file', { path: 'alias.js' })).toContain('return a + b');
    const info = await s.stat('alias.js'); expect(info.writable).toBe(false);
    await s.bad('delete_file', { path: 'alias.js', base: info.version });
    expect(lstatSync(join(s.repo, 'alias.js')).isSymbolicLink()).toBe(true);
  });

  it('allows narrowly named credential source modules, but still hides actual stores', async () => {
    const s = setup(); mkdirSync(join(s.repo, 'src'));
    for (const name of ['credentials.ts', 'credential.js', 'credentials.test.ts']) {
      writeFileSync(join(s.repo, 'src', name), 'export const value = 1;\n');
      expect(await s.ok('view_file', { path: `src/${name}` })).toContain('export const');
      expect(await s.ok('find_files', { pattern: '**/*.ts' })).toContain('credentials.ts');
    }
    for (const name of ['credentials.json', '.env', 'id_rsa']) {
      writeFileSync(join(s.repo, name), 'not for tools'); await s.bad('view_file', { path: name });
    }
  });

  it('deletes individual binary and large files with fresh versions, never directories or hard links', async () => {
    const s = setup(); writeFileSync(join(s.repo, 'raw.bin'), Buffer.from([0, 255, 1]));
    const old = await s.stat('raw.bin'); writeFileSync(join(s.repo, 'raw.bin'), Buffer.from([0, 255, 2]));
    await s.bad('delete_file', { path: 'raw.bin', base: old.version });
    await s.ok('delete_file', { path: 'raw.bin', base: (await s.stat('raw.bin')).hash });
    writeFileSync(join(s.repo, 'large.bin'), ''); truncateSync(join(s.repo, 'large.bin'), 65 * 1024 * 1024);
    await s.ok('delete_file', { path: 'large.bin', base: (await s.stat('large.bin')).version });
    linkSync(join(s.repo, 'math.js'), join(s.repo, 'hard.js'));
    await s.bad('delete_file', { path: 'hard.js', base: (await s.stat('hard.js')).hash });
    await s.bad('delete_file', { path: '.', base: 'anything' });
    expect(existsSync(join(s.repo, 'raw.bin'))).toBe(false); expect(existsSync(join(s.repo, 'large.bin'))).toBe(false);
  });

  it('rechecks binary deletion after an asynchronous wait', async () => {
    const s = setup(); writeFileSync(join(s.repo, 'raw.bin'), Buffer.from([0, 1]));
    const operation = deleteFileTool({ worktree: s.repo, project: null, role: 'implementer' }, { beforeRecheck: () => { writeFileSync(join(s.repo, 'raw.bin'), Buffer.from([0, 2])); } });
    expect((await operation.call({ path: 'raw.bin', base: (await s.stat('raw.bin')).version })).success).toBe(false);
    expect(readFileSync(join(s.repo, 'raw.bin'))).toEqual(Buffer.from([0, 2]));
  });

  it('converts EOL, BOM and final newline explicitly while preserving defaults and stale protection', async () => {
    const s = setup(); writeFileSync(join(s.repo, 'format.txt'), '\ufeffone\r\ntwo\r\n');
    const before = (await s.stat('format.txt')).hash;
    await s.ok('write_file', { path: 'format.txt', base: before, content: 'one\ntwo\n', eol: 'lf', bom: false, final_newline: false });
    expect(readFileSync(join(s.repo, 'format.txt'), 'utf8')).toBe('one\ntwo');
    await s.bad('write_file', { path: 'format.txt', base: before, content: 'stale', eol: 'crlf' });
    await s.ok('write_file', { path: 'format.txt', base: (await s.stat('format.txt')).hash, content: 'one\ntwo', eol: 'crlf', bom: true, final_newline: true });
    expect(readFileSync(join(s.repo, 'format.txt'), 'utf8')).toBe('\ufeffone\r\ntwo\r\n');
    await s.ok('write_file', { path: 'format.txt', base: (await s.stat('format.txt')).hash, content: 'three\nfour\n' });
    expect(readFileSync(join(s.repo, 'format.txt'), 'utf8')).toBe('\ufeffthree\r\nfour\r\n');
    await s.bad('write_file', { path: 'format.txt', content: 'bad', eol: 'mixed' });
  });

  it.skipIf(process.platform === 'win32')('preserves private/executable modes through edits and replacement and creates private files', async () => {
    const s = setup();
    for (const mode of [0o600, 0o755]) {
      writeFileSync(join(s.repo, 'mode.txt'), 'before\n'); chmodSync(join(s.repo, 'mode.txt'), mode);
      await s.ok('write_file', { path: 'mode.txt', base: (await s.stat('mode.txt')).hash, content: 'after\n' });
      expect(lstatSync(join(s.repo, 'mode.txt')).mode & 0o777).toBe(mode);
      await s.ok('edit_file', { path: 'mode.txt', edits: [{ op: 'replace_text', old: 'after', new: 'edited' }] });
      expect(lstatSync(join(s.repo, 'mode.txt')).mode & 0o777).toBe(mode);
    }
    await s.ok('write_file', { path: 'private.txt', content: 'new' });
    expect(lstatSync(join(s.repo, 'private.txt')).mode & 0o777).toBe(0o600);
  });

  it('renders distant changes as separate hunks and paginates without losing lines or accepting stale continuations', async () => {
    const s = setup(); const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(join(s.repo, 'a.txt'), lines.join('\n')); lines[2] = 'first change'; lines[90] = 'last change';
    writeFileSync(join(s.repo, 'b.txt'), lines.join('\n'));
    const args = { left: 'a.txt', right: 'b.txt', context_lines: 2 };
    const full = await s.ok('diff_files', args);
    expect(full.match(/^@@/gm)).toHaveLength(2); expect(full).not.toContain('line 50');
    const left_base = (await s.stat('a.txt')).hash, right_base = (await s.stat('b.txt')).hash;
    let offset = 0; const body: string[] = [];
    for (;;) {
      const page = await s.ok('diff_files', { ...args, max_lines: 2, offset, left_base, right_base });
      body.push(...page.split('\n').slice(3).filter(line => !line.startsWith('next:')));
      const next = /next: offset=(\d+)/.exec(page); if (!next) break; offset = Number(next[1]);
    }
    expect(body.join('\n')).toBe(full.split('\n').slice(3).join('\n'));
    writeFileSync(join(s.repo, 'b.txt'), 'changed');
    await s.bad('diff_files', { ...args, offset: 2, left_base, right_base });
    await s.bad('diff_files', { ...args, offset: 2 });
  });
});

describe('diff reconstruction', () => {
  it('produces coherent multi-hunk ranges for insertions, deletions, repeated lines and moved anchors', async () => {
    const s = setup(); let seed = 7;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 30; run++) {
      const a = Array.from({ length: 30 }, (_, i) => random(3) ? `unique ${i}` : 'repeated');
      const b = [...a];
      for (let i = 0; i < 8; i++) b.splice(random(b.length + 1), random(3), ...Array.from({ length: random(3) }, () => `added ${random(5)}`));
      writeFileSync(join(s.repo, 'a.txt'), a.join('\n') + '\n'); writeFileSync(join(s.repo, 'b.txt'), b.join('\n') + '\n');
      const diff = await s.ok('diff_files', { left: 'a.txt', right: 'b.txt', context_lines: random(4), max_lines: 400 });
      if (diff.startsWith('identical:')) { expect(a).toEqual(b); continue; }
      const rebuilt: string[] = []; let cursor = 0;
      for (const line of diff.split('\n').slice(3)) {
        const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
        if (hunk) {
          const start = Number(hunk[1]) - (Number(hunk[2]) ? 1 : 0);
          expect(start).toBeGreaterThanOrEqual(cursor); rebuilt.push(...a.slice(cursor, start)); cursor = start;
        } else if (line.startsWith('+')) rebuilt.push(line.slice(1));
        else if (line.startsWith('-') || line.startsWith(' ')) {
          expect(line.slice(1)).toBe(a[cursor++]); if (line.startsWith(' ')) rebuilt.push(line.slice(1));
        } else throw new Error(`Unexpected diff record: ${line}`);
      }
      rebuilt.push(...a.slice(cursor)); expect(rebuilt).toEqual(b);
    }
  });
});

const externalInputs = [
  ['grep', '-f', 'outside.txt', 'HEAD'], ['grep', '-nfoutside.txt', 'HEAD'], ['grep', '--file=outside.txt', 'HEAD'],
  ['commit', '-Foutside.txt'], ['commit', '--file', 'outside.txt'], ['commit', '--template=outside.txt'],
  ['tag', '-F', 'outside.txt', 'tag'], ['merge', '-F', 'outside.txt', 'HEAD'],
  ['add', '--pathspec-from-file=outside.txt'], ['restore', '--pathspec-from-f=outside.txt'],
  ['ls-files', '-Xoutside.txt'], ['ls-files', '--exclude-per-directory=../../outside.txt'],
  ['blame', '-S', 'outside.txt', 'math.js'], ['blame', '--ignore-revs-file=outside.txt', 'math.js'],
  ['rev-parse', '--resolve-git-dir', 'outside'],
];
describe('Git input and configuration boundaries', () => {
  it.each(externalInputs)('refuses file input: %j', (...args) => {
    for (const mode of ['read-only', 'full'] as const) expect(gitVerdict(args, mode).kind).toBe('block');
  });
  it('keeps inline input and owner helpers available but blocks tool-supplied configuration/execution', () => {
    for (const args of [['commit', '-m', 'message'], ['commit', '-mfix-input'], ['grep', '-e', 'pattern', 'HEAD'], ['grep', '-efoo', 'HEAD'], ['blame', '--ignore-rev', 'HEAD', 'math.js'], ['ls-files', '--exclude=pattern'], ['fetch', 'origin'], ['add', 'math.js']]) expect(gitVerdict(args, 'full').kind).toBe('allow');
    for (const args of [['config', 'filter.inject.clean', 'program'], ['-c', 'filter.inject.clean=program', 'add', '.'], ['fetch', '--upload-pack=program', 'origin'], ['rebase', '--exec=program', 'HEAD'], ['fetch', 'ext::program']]) expect(gitVerdict(args, 'full').kind).toBe('block');
    expect(gitArguments({ worktree: '/repo', gitDir: '/repo/.git', hooksPath: '/hooks' }, ['checkout', 'HEAD'])).toContain('core.symlinks=false');
  });
  it('allows an owner-configured clean filter without letting the tool change configuration', async () => {
    const s = setup(); git(s.repo, 'config', 'filter.owner.clean', 'cat'); git(s.repo, 'config', 'filter.owner.required', 'true');
    writeFileSync(join(s.repo, '.gitattributes'), 'filtered.txt filter=owner\n'); writeFileSync(join(s.repo, 'filtered.txt'), 'owner filter\n');
    const tool = gitTool(s.place, 'full');
    const reply = await tool.call({ args: ['add', 'filtered.txt'] }); expect(reply.success, text(reply)).toBe(true);
    expect(git(s.repo, 'show', ':filtered.txt')).toBe('owner filter');
    expect((await tool.call({ args: ['config', 'filter.owner.clean', 'other'] })).success).toBe(false);
    expect(git(s.repo, 'config', 'filter.owner.clean')).toBe('cat');
  });
});

describe('Git link ceilings', () => {
  it('rejects full startup through linked roots rather than losing the read-only ceiling during canonicalization', () => {
    const s = setup(), parent = tempFolder('linked-root-'); directoryLink(s.repo, join(parent, 'alias'));
    const root = fileURLToPath(new URL('../', import.meta.url));
    for (const kind of ['files', 'git']) {
      const result = spawnSync(process.execPath, [`src/${kind}/server.ts`, '--root', join(parent, 'alias'), '--access', 'full'], { cwd: root, encoding: 'utf8', input: '', timeout: 10_000 });
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('may not traverse symlinks/junctions');
    }
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'git', arguments: { args: ['status', '--short'] } } }) + '\n';
    const output = execFileSync(process.execPath, ['src/git/server.ts', '--root', join(parent, 'alias'), '--access', 'read-only'], { cwd: root, encoding: 'utf8', input: request, timeout: 10_000 });
    expect(JSON.parse(output).result.isError).toBe(false);
  });
  it('refuses worktree rewrites around ignored junctions without affecting reads', async () => {
    const s = setup(), target = tempFolder('git-link-target-');
    writeFileSync(join(target, 'keep.txt'), 'keep'); directoryLink(target, join(s.repo, 'alias'));
    writeFileSync(join(s.repo, '.gitignore'), 'alias/\n');
    const tool = gitTool(s.place, 'full');
    for (const args of [['clean', '-fdx'], ['reset', '--hard'], ['checkout', 'HEAD'], ['rm', '-rf', 'alias']]) {
      const reply = await tool.call({ args }); expect(reply.success).toBe(false); expect(text(reply)).toContain('symlinks/junctions');
    }
    expect((await tool.call({ args: ['status', '--short'] })).success).toBe(true);
    expect(lstatSync(join(s.repo, 'alias')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('checks out a tracked symlink as a regular file without changing owner configuration', async () => {
    const s = setup(); git(s.repo, 'config', 'core.symlinks', 'true');
    writeFileSync(join(s.repo, 'blob.txt'), 'math.js');
    const blob = git(s.repo, 'hash-object', '-w', 'blob.txt');
    git(s.repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},link.txt`);
    git(s.repo, 'commit', '-qm', 'Owner-created symlink tree');
    const reply = await gitTool(s.place, 'full').call({ args: ['restore', '--source=HEAD', '--', 'link.txt'] });
    expect(reply.success, text(reply)).toBe(true);
    expect(lstatSync(join(s.repo, 'link.txt')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(s.repo, 'link.txt'), 'utf8')).toBe('math.js');
    expect(git(s.repo, 'config', 'core.symlinks')).toBe('true');
  });
});

describe('bounded MCP scheduling', () => {
  it('bounds active work and queued calls and rejects overflow', async () => {
    const queue = new RequestQueue(1, 1); let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    let secondRan = false; const second = queue.run(async () => { secondRan = true; });
    await expect(queue.run(async () => {})).rejects.toThrow('queue is full'); expect(secondRan).toBe(false);
    release(); await Promise.all([first, second]); expect(secondRan).toBe(true);
  });
  it('cancels queued work without executing it and warns about active cancellation', async () => {
    const queue = new RequestQueue(1, 1); let release!: () => void;
    const first = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController(); let ran = false;
    const cancelled = queue.run(async () => { ran = true; }, controller.signal);
    controller.abort(); await expect(cancelled).rejects.toThrow('before execution');
    const next = queue.run(async () => {}); release(); await Promise.all([first, next]); expect(ran).toBe(false);
    const activeController = new AbortController();
    await expect(queue.run(async () => { activeController.abort(); }, activeController.signal)).rejects.toThrow('may have completed');
  });
  it('rejects oversized JSON-RPC batches over the public transport', () => {
    const root = fileURLToPath(new URL('../', import.meta.url)); const repo = tempRepo();
    const input = JSON.stringify(Array.from({ length: 33 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }))) + '\n';
    const output = execFileSync(process.execPath, ['src/git/server.ts', '--root', repo, '--access', 'read-only'], { cwd: root, encoding: 'utf8', input, timeout: 10_000 });
    expect(JSON.parse(output).error.message).toContain('32 requests');
  });
});

describe('MCP cancellation transport', () => {
  it('shares one concurrency budget across messages and cancels queued calls before execution', () => {
    const module = new URL('../src/mcp/stdio.ts', import.meta.url).href;
    const script = `import { serveMcp } from ${JSON.stringify(module)};
      const started = []; let active = 0, peak = 0;
      serveMcp({ name: 'fixture', tools: async () => [],
        call: async (name) => { started.push(name); active++; peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 50)); active--;
          return { success: true, content: [{type: 'text', text: name}] }; },
        close: () => { console.error(JSON.stringify({started, peak})); } });`;
    const messages: unknown[] = Array.from({ length: 6 }, (_, index) => ({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: String(index + 1) } }));
    messages.push({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 6 } });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stderr.trim());
    expect(state.peak).toBe(4); expect(state.started).toEqual(['1', '2', '3', '4', '5']);
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(replies.find(reply => reply.id === 6).result.content[0].text).toContain('cancelled before execution');
  });
});
