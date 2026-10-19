import { dirname, resolve } from 'node:path';
import type { BuiltInTool } from '../contract.ts';
import { writableAccess, type ToolAccess } from '../shared/access.ts';
import { startCall, type FileSession } from './files.ts';
import { directoryIdentity, SessionDirectoryGrants } from './session-grants.ts';
import { fail, reply } from './core/filesystem.ts';

export function requestDirectoryAccessTool(session: FileSession, mode: ToolAccess, grants: SessionDirectoryGrants): BuiltInTool {
  return {
    tool: {
      name: 'request_directory_access',
      description: 'Ask the user, through the MCP host, to approve read-only or full access to one existing non-linked directory for this connection only. Give a reason. No grant occurs without host-mediated explicit user approval. Unsupported hosts, decline, cancellation and timeout fail closed. Settings denials/read-only limits, server ceilings, protected paths and link read-only restrictions cannot be overridden. No settings files are changed.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', description: 'Existing directory, absolute or relative to the server root.' },
        access: { type: 'string', enum: ['read-only', 'full'] },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      }, required: ['path', 'access', 'reason'] },
    },
    async call(input, context) {
      try {
        if (Object.keys(input).some(key => !['path', 'access', 'reason'].includes(key))) fail('Unexpected argument; approval cannot be supplied through tool arguments.');
        const access = input['access'];
        if (access !== 'read-only' && access !== 'full') fail('access must be read-only or full.');
        if (mode === 'deny' || (access === 'full' && !writableAccess(mode))) fail('The server access ceiling cannot be escalated in-session.');
        if (typeof input['reason'] !== 'string' || !input['reason'].trim() || input['reason'].length > 1000) fail('Give a non-empty reason of at most 1000 characters.');
        const validate = () => {
          const path = startCall({ worktree: session.worktree, project: null, role: 'reader', externalRead: true }).judge(input['path'], 'read');
          if (!path.ok) fail(path.reason);
          if (path.kind !== 'folder' || path.throughLink || dirname(path.absolute) === path.absolute) fail('Use an existing non-linked directory below a filesystem root.');
          if (session.permissions?.isConfig(path.absolute)) fail('Configuration paths cannot be escalated.');
          const effective = session.permissions?.effective(path.absolute, session.worktree, writableAccess(mode), mode === 'super');
          if (effective?.rule && effective.rule.source !== 'session:user-approved' && (effective.rule.access === 'deny' || (access === 'full' && effective.rule.access !== 'full'))) fail('Settings explicitly restrict this directory; session approval cannot override them.');
          return { path, effective, identity: directoryIdentity(path.absolute) };
        };
        const before = validate();
        if (before.effective && (before.effective.access === 'full' || (access === 'read-only' && before.effective.access === 'read-only'))) return reply(true, { status: 'already-allowed', path: before.path.canonical, access: before.effective.access });
        if (!context?.requestDirectoryApproval) fail('This MCP host has not advertised form elicitation support; no permission was granted. Ask the owner to configure this project or use an approval-capable host.');
        const revision = grants.revision;
        const approved = await context.requestDirectoryApproval({ root: session.worktree, directory: before.path.absolute, access, reason: input['reason'] });
        if (!approved || context.signal?.aborted) fail('User approval was declined, cancelled, timed out or unavailable. No permission was granted.');
        if (grants.revision !== revision) fail('Session permissions were revoked or closed during approval; request again.');
        const after = validate();
        if (after.path.absolute !== before.path.absolute || after.identity !== before.identity) fail('Directory changed during approval; request again.');
        grants.add(after.path.absolute, access, before.identity);
        return reply(true, { status: 'granted', path: after.path.canonical, access, lifetime: 'this MCP connection only; revoke or disconnect to remove', exclusions: 'Settings restrictions, protected paths, server ceilings and link read-only limits remain enforced.' });
      } catch (error) { return reply(false, error instanceof Error ? error.message : 'Permission request failed; no grant was made.'); }
    },
    async close() { grants.close(); },
  };
}

export function revokeDirectoryAccessTool(session: FileSession, grants: SessionDirectoryGrants): BuiltInTool {
  return {
    tool: { name: 'revoke_directory_access', description: 'Revoke a user-approved session directory grant by its directory path. Does not change settings or delete files. No approval is needed to reduce access.', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] } },
    async call(input) {
      if (Object.keys(input).some(key => key !== 'path') || typeof input['path'] !== 'string' || input['path'].length > 4096) return reply(false, 'Give only the directory path to revoke.');
      const path = resolve(session.worktree, input['path'].replaceAll('\\', '/'));
      return reply(true, { path, revoked: grants.revoke(path) });
    },
  };
}
