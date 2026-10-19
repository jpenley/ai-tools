import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { containsDirectory, type DirectoryRule } from './directory-permissions.ts';

type Grant = DirectoryRule & { readonly identity: string };
const key = (path: string) => process.platform === 'win32' ? path.toUpperCase() : path;
export function directoryIdentity(path: string): string {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Session grants require an existing non-linked directory.');
  return `${stats.dev}:${stats.ino}`;
}

/** Connection-local grants. Only the approval tool's trusted callback may add one.
 * No serialization, config writes, environment grant tokens or self-approval route.
 */
export class SessionDirectoryGrants {
  private readonly grants = new Map<string, Grant>();
  private closed = false;
  private revocations = 0;
  get revision(): number { return this.revocations; }
  add(path: string, access: 'read-only' | 'full', expectedIdentity: string): DirectoryRule {
    if (this.closed) throw new Error('Permission session has closed.');
    if (dirname(path) === path) throw new Error('Whole-filesystem session grants are not supported.');
    if (!this.grants.has(key(path)) && this.grants.size >= 64) throw new Error('Session directory grant limit reached (64). Revoke unused grants first.');
    if (directoryIdentity(path) !== expectedIdentity) throw new Error('Directory changed during approval; request again.');
    const grant = Object.freeze({ path, access, source: 'session:user-approved', identity: expectedIdentity });
    this.grants.set(key(path), grant);
    return grant;
  }
  revoke(path: string): boolean { this.revocations += 1; return this.grants.delete(key(path)); }
  isRoot(path: string): boolean { return this.grants.has(key(path)); }
  effective(path: string): DirectoryRule | undefined {
    if (this.closed) return undefined;
    const grant = [...this.grants.values()].filter(rule => containsDirectory(rule.path, path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (grant && directoryIdentity(grant.path) !== grant.identity) throw new Error('A session grant root changed; revoke it and request approval again.');
    return grant;
  }
  close(): void { this.closed = true; this.revocations += 1; this.grants.clear(); }
}
