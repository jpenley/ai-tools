// Credential filenames are classified without opening their contents.

const CREDENTIAL_FILES: readonly { readonly name: RegExp; readonly kind: string }[] = [
  { name: /^auth\.json$/i, kind: 'a Codex sign-in' },
  { name: /^\.?credentials/i, kind: 'a credentials file' },
  { name: /^\.git-credentials$/i, kind: 'a credentials file' },
  // A .env's example, sample or template is meant to be committed; its lines are still read.
  { name: /^\.env(rc)?(?!\.(example|sample|template)$)([._-].+)?$/i, kind: 'an environment file' },
  { name: /\.(pem|key|p12|pfx)$/i, kind: 'a key file' },
  { name: /^id_(rsa|dsa|ecdsa|ed25519)/i, kind: 'an SSH key' },
];

/** Files that hold credentials only when a line sets one, by name, with the line that does (a `${VAR}` reference sets none). */
const TOKEN_FILES: readonly { readonly name: RegExp; readonly line: RegExp; readonly kind: string }[] = [
  { name: /^\.npmrc$/i, line: /(_authToken|_auth|_password)\s{0,10}=\s{0,10}(?!\$\{)\S/, kind: 'an npm token' },
  { name: /^[._]netrc$/i, line: /\bpassword\s{1,10}\S/, kind: 'a .netrc password' },
];



/** Classifies the last path segment without reading contents, including Windows drive, stream and trailing-dot aliases. */
export function isCredentialFileName(path: string): boolean {
  // One trailing separator names the same file, as `.env/` does to Windows.
  const trimmed = path.replace(/[\\/]$/, '');
  const segment = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  // A drive-relative `C:auth.json` names auth.json; any later colon starts a stream name.
  const name = segment.replace(/^[A-Za-z]:/, '').replace(/:.*$/, '').replace(/[. ]+$/, '');
  return CREDENTIAL_FILES.some((file) => file.name.test(name)) || TOKEN_FILES.some((file) => file.name.test(name));
}
