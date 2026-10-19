import { isCredentialFileName as legacyCredentialName } from './credentials.ts';

/** Narrow source-code exceptions, not an exemption for arbitrary source files.
 * Credential stores (.env, JSON, PEM, key files, etc.) retain the existing policy.
 */
export function isCredentialFileName(name: string): boolean {
  if (/^credentials?(?:\.(?:test|spec))?\.(?:[cm]?[jt]s|[jt]sx)$/i.test(name)) return false;
  return legacyCredentialName(name);
}
