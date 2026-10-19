import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext, ToolReply } from '../src/contract.ts';
import type { ToolAccess } from '../src/shared/access.ts';
import { fileServerTools } from '../src/files/file-server.ts';
import type { DirectoryConfig } from '../src/files/directory-permissions.ts';
import { MCPSession, type MCPCallResult } from './mcp-client.fixture.ts';
import { tempFolder, tempRepo, removeTempRepos } from './git.fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (reply: ToolReply | MCPCallResult) => reply.content.map(part => part.type === 'text' ? part.text ?? '' : '').join('');
const approved: ToolCallContext = { requestDirectoryApproval: async () => true };
const request = (path: string, access: 'read-only' | 'full' = 'full') => ({ path, access, reason: 'Work on the requested directory.' });
const sessions: MCPSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); removeTempRepos(); });
function setup(mode: ToolAccess = 'full', config: DirectoryConfig = { config: { directories: [] } }, repo = tempRepo()) {
  const tools = fileServerTools({ worktree: repo, project: null, directoryConfig: config }, { worktree: repo, gitDir: join(repo, '.git'), hooksPath: join(repo, '.git', 'no-hooks') }, mode, null);
  const call = (name: string, args: Record<string, unknown>, context?: ToolCallContext) => tools.find(tool => tool.tool.name === name)!.call(args, context);
  return { tools, repo, call };
}
async function open(repo: string, mode: ToolAccess, options: { capabilities?: Record<string, unknown>; onElicitation?: (params: Record<string, unknown>, id: string) => unknown | Promise<unknown>; args?: string[] } = {}) {
  const session = await MCPSession.open({ transport: 'stdio', command: process.execPath, cwd: root, args: options.args ?? [join(root, 'src/files/server.ts'), '--root', repo, '--access', mode], ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }), ...(options.onElicitation === undefined ? {} : { onElicitation: options.onElicitation }) });
  sessions.push(session); return session;
}

describe('super and session-local permissions', () => {
  it('super grants external reads but obeys project/global denials, protected paths and external write limits', async () => {
    const repo = tempRepo(), outside = tempFolder('super-outside-');
    for (const path of [join(repo, 'private'), join(outside, 'private'), join(outside, '.ssh')]) { mkdirSync(path); writeFileSync(join(path, 'note.txt'), 'do not read'); }
    writeFileSync(join(outside, 'note.txt'), 'external read');
    const config = { config: { directories: [{ path: join(repo, 'private'), access: 'deny' }] }, path: join(repo, 'project.json'), fallbacks: [{ config: { directories: [{ path: join(outside, 'private'), access: 'deny' }] }, path: join(outside, 'global.json') }] };
    const s = setup('super', config, repo);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).success).toBe(true);
    for (const path of [join(repo, 'private/note.txt'), join(outside, 'private/note.txt'), join(outside, '.ssh/note.txt'), join(repo, 'project.json'), join(outside, 'global.json')]) expect((await s.call('view_file', { path })).success).toBe(false);
    expect((await s.call('write_file', { path: join(outside, 'new.txt'), content: 'not granted' })).success).toBe(false);
    expect((await s.call('write_file', { path: 'local.txt', content: 'project write' })).success).toBe(true);
  });

  it('requires a trusted host callback, refuses model self-approval, and does not grant on decline or cancellation', async () => {
    const s = setup(), outside = tempFolder('approval-outside-'); writeFileSync(join(outside, 'note.txt'), 'external');
    const allow = vi.fn(async () => true);
    expect((await s.call('request_directory_access', request(outside))).success).toBe(false);
    expect((await s.call('request_directory_access', { ...request(outside), approved: true }, { requestDirectoryApproval: allow })).success).toBe(false);
    expect(allow).not.toHaveBeenCalled();
    expect((await s.call('request_directory_access', request(outside), { requestDirectoryApproval: async () => false })).success).toBe(false);
    const controller = new AbortController();
    expect((await s.call('request_directory_access', request(outside), { signal: controller.signal, requestDirectoryApproval: async () => { controller.abort(); return true; } })).success).toBe(false);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).success).toBe(false);
  });

  it('grants read-only access, asks again for an upgrade, honors exclusions, and revokes without persistence or cross-session leakage', async () => {
    const outside = tempFolder('approval-upgrade-'), other = tempFolder('approval-other-');
    for (const name of ['private', 'readonly']) mkdirSync(join(outside, name));
    writeFileSync(join(outside, 'note.txt'), 'external'); writeFileSync(join(outside, 'private/note.txt'), 'private');
    const config = { config: { directories: [{ path: join(outside, 'private'), access: 'deny' }, { path: join(outside, 'readonly'), access: 'read-only' }] }, protectedPaths: [join(outside, 'future-permissions.json')] };
    const s = setup('full', config), sibling = setup('full', config, s.repo);
    symlinkSync(outside, join(s.repo, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await s.call('request_directory_access', request(outside, 'read-only'), approved)).success).toBe(true);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).success).toBe(true);
    expect((await s.call('write_file', { path: join(outside, 'new.txt'), content: 'no' })).success).toBe(false);
    const confirm = vi.fn(async () => true);
    expect((await s.call('request_directory_access', request(outside), { requestDirectoryApproval: confirm })).success).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect((await s.call('write_file', { path: join(outside, 'new.txt'), content: 'approved' })).success).toBe(true);
    expect(JSON.parse(text(await s.call('stat_path', { path: join(outside, 'new.txt') }))).permission.rule).toMatchObject({ access: 'full', source: 'session:user-approved' });
    expect((await s.call('view_file', { path: 'alias/note.txt' })).success).toBe(true);
    for (const path of ['alias/no.txt', join(outside, 'future-permissions.json'), join(outside, 'private/no.txt'), join(outside, 'readonly/no.txt'), join(other, 'no.txt')]) expect((await s.call('write_file', { path, content: 'no' })).success).toBe(false);
    expect((await s.call('remove_directory', { path: outside, preview: true })).success).toBe(false);
    expect((await sibling.call('view_file', { path: join(outside, 'note.txt') })).success).toBe(false);
    expect((await s.call('revoke_directory_access', { path: outside })).success).toBe(true);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).success).toBe(false);
    expect(readFileSync(join(outside, 'new.txt'), 'utf8')).toBe('approved');
  });

  it('never escalates settings or a server read-only ceiling, or grants linked/filesystem-root directories', async () => {
    const outside = tempFolder('approval-hard-limits-'), repo = tempRepo();
    mkdirSync(join(outside, 'denied')); mkdirSync(join(outside, 'reader'));
    symlinkSync(outside, join(repo, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const s = setup('full', { config: { directories: [{ path: join(outside, 'denied'), access: 'deny' }, { path: join(outside, 'reader'), access: 'read-only' }] } }, repo);
    const confirm = vi.fn(async () => true);
    for (const path of [join(outside, 'denied'), join(outside, 'reader'), join(repo, 'alias'), parse(repo).root]) {
      expect((await s.call('request_directory_access', request(path), { requestDirectoryApproval: confirm })).success).toBe(false);
    }
    expect(confirm).not.toHaveBeenCalled();
    const reader = setup('read-only');
    expect((await reader.call('request_directory_access', request(outside), { requestDirectoryApproval: confirm })).success).toBe(false);
    expect((await reader.call('request_directory_access', request(outside, 'read-only'), approved)).success).toBe(true);
    expect(reader.tools.some(tool => tool.tool.name === 'write_file')).toBe(false);
  });

  it('does not reinstate a grant from an outstanding prompt after revocation', async () => {
    const s = setup(), outside = tempFolder('approval-revoked-');
    expect((await s.call('request_directory_access', request(outside), { requestDirectoryApproval: async () => { await s.call('revoke_directory_access', { path: outside }); return true; } })).success).toBe(false);
    expect((await s.call('write_file', { path: join(outside, 'no.txt'), content: 'no' })).success).toBe(false);
  });

  it('pins directory identities around approval and throughout the grant, and refuses late approval after close', async () => {
    const s = setup(), outside = tempFolder('approval-identity-'), path = join(outside, 'target'); mkdirSync(path);
    expect((await s.call('request_directory_access', request(path), { requestDirectoryApproval: async () => { renameSync(path, join(outside, 'old')); mkdirSync(path); return true; } })).success).toBe(false);
    expect((await s.call('request_directory_access', request(path), approved)).success).toBe(true);
    renameSync(path, join(outside, 'old2')); mkdirSync(path); writeFileSync(join(path, 'new.txt'), 'replacement');
    expect((await s.call('view_file', { path: join(path, 'new.txt') })).success).toBe(false);
    expect((await s.call('revoke_directory_access', { path })).success).toBe(true);
    const tool = s.tools.find(tool => tool.tool.name === 'request_directory_access')!;
    expect((await s.call('request_directory_access', request(path), { requestDirectoryApproval: async () => { await tool.close?.(); return true; } })).success).toBe(false);
  });
});

describe('host-mediated MCP form approval', { timeout: 30_000 }, () => {
  it('fails closed on unsupported or URL-only hosts and does not accept approved:true as an argument', async () => {
    const repo = tempRepo(), outside = tempFolder('approval-mcp-');
    const confirm = vi.fn(async () => ({ action: 'accept', content: { approve: true } }));
    for (const capabilities of [{}, { elicitation: { url: {} } }]) {
      const s = await open(repo, 'full', { capabilities, onElicitation: confirm });
      expect((await s.call('request_directory_access', request(outside))).isError).toBe(true);
      expect((await s.call('request_directory_access', { ...request(outside), approved: true })).isError).toBe(true);
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('requires accept plus approve:true, then grants only this session and removes access on revoke/restart', async () => {
    const repo = tempRepo(), outside = tempFolder('approval-mcp-'); writeFileSync(join(outside, 'note.txt'), 'external marker');
    const responses = [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept' }, { action: 'accept', content: { approve: false } }, { action: 'accept', content: { approve: 'true' } }, { action: 'accept', content: { approve: true } }];
    const prompts: Record<string, unknown>[] = [];
    const s = await open(repo, 'full', { capabilities: { elicitation: { form: {} } }, onElicitation: params => { prompts.push(params); return responses.shift(); } });
    for (let i = 0; i < 5; i++) expect((await s.call('request_directory_access', request(outside))).isError).toBe(true);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).isError).toBe(true);
    expect((await s.call('request_directory_access', request(outside))).isError).toBe(false);
    expect(prompts).toHaveLength(6);
    expect(prompts[0]).toMatchObject({ requestedSchema: { properties: { approve: { type: 'boolean', default: false } } } });
    expect(String(prompts[0]!['message'])).toContain(repo);
    expect(String(prompts[0]!['message'])).toContain(outside);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).isError).toBe(false);
    expect((await s.call('write_file', { path: join(outside, 'approved.txt'), content: 'yes' })).isError).toBe(false);
    const other = await open(repo, 'full');
    expect((await other.call('view_file', { path: join(outside, 'note.txt') })).isError).toBe(true);
    expect((await s.call('revoke_directory_access', { path: outside })).isError).toBe(false);
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).isError).toBe(true);
  });

  it('ignores uncorrelated responses and late accepts following cancellation', async () => {
    const repo = tempRepo(), outside = tempFolder('approval-mcp-cancel-'); writeFileSync(join(outside, 'note.txt'), 'external');
    let prompt!: () => void, respond!: (value: unknown) => void;
    const prompted = new Promise<void>(resolve => { prompt = resolve; });
    const response = new Promise<unknown>(resolve => { respond = resolve; });
    const s = await open(repo, 'full', { capabilities: { elicitation: {} }, onElicitation: () => { prompt(); return response; } });
    const pending = s.call('request_directory_access', request(outside));
    const id = s.lastRequestId; await prompted;
    s.respond('ai-tools-approval-not-the-server-id', { action: 'accept', content: { approve: true } });
    s.notify('notifications/cancelled', { requestId: id });
    expect((await pending).isError).toBe(true);
    respond({ action: 'accept', content: { approve: true } });
    expect((await s.call('view_file', { path: join(outside, 'note.txt') })).isError).toBe(true);
  });

  it('closes a pending prompt promptly on disconnect without installing a grant', async () => {
    const repo = tempRepo(), outside = tempFolder('approval-mcp-disconnect-');
    let prompt!: () => void;
    const prompted = new Promise<void>(resolve => { prompt = resolve; });
    const s = await open(repo, 'full', { capabilities: { elicitation: { form: {} } }, onElicitation: () => { prompt(); return new Promise(() => {}); } });
    const pending = s.call('request_directory_access', request(outside)).catch(() => null);
    await prompted; await s.close();
    const reply = await pending; expect(reply === null || reply.isError).toBe(true);
    const other = await open(repo, 'full');
    expect((await other.call('write_file', { path: join(outside, 'no.txt'), content: 'no' })).isError).toBe(true);
  });

  it('times out missing host approval and rejects a subsequent late accept', async () => {
    const repo = tempRepo(), outside = tempFolder('approval-mcp-timeout-');
    const url = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    const script = `
      import { serveMcp } from ${url('src/mcp/stdio.ts')};
      import { fileServerTools } from ${url('src/files/file-server.ts')};
      import { createToolRegistry } from ${url('src/registry.ts')};
      const realTimer = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delay, ...args) => realTimer(fn, delay === 120000 ? 25 : delay, ...args);
      const repo = ${JSON.stringify(repo)};
      const registry = createToolRegistry(fileServerTools({worktree:repo,project:null}, {worktree:repo,gitDir:repo+'/.git',hooksPath:repo+'/.git/no-hooks'}, 'full', null));
      serveMcp({name:'approval-timeout-test',tools:async()=>registry.tools,call:(tool,args,context)=>registry.call({tool,arguments:args},context),disconnect:()=>{void registry.close()},close:()=>{void registry.close()}});
    `;
    let respond!: (value: unknown) => void;
    const response = new Promise<unknown>(resolve => { respond = resolve; });
    const s = await open(repo, 'full', { args: ['--input-type=module', '-e', script], capabilities: { elicitation: { form: {} } }, onElicitation: () => response });
    expect((await s.call('request_directory_access', request(outside))).isError).toBe(true);
    respond({ action: 'accept', content: { approve: true } });
    expect((await s.call('write_file', { path: join(outside, 'no.txt'), content: 'no' })).isError).toBe(true);
  });
});
