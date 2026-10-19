import { flagArgument } from '../shared/arguments.ts';

const MAX_PATTERN = 2000;
const MAX_PATTERNS = 32;
const MAX_LITERAL_BYTES = 8 * 1024;

/** Parsed once at the tool boundary; every pattern reaches rg only as a --regexp value. */
export interface SearchQuery {
  readonly patterns: readonly string[];
  readonly literal: boolean;
  readonly label: string;
}

export function parseSearchQuery(input: Readonly<Record<string, unknown>>): { readonly ok: true; readonly query: SearchQuery } | { readonly ok: false; readonly reason: string } {
  const multiple = input['patterns'] !== undefined;
  if ((input['pattern'] !== undefined) === multiple) return { ok: false, reason: 'Provide exactly one of pattern or patterns.' };
  const literal = flagArgument(input['literal']);
  if (literal === null) return { ok: false, reason: 'literal must be true or false.' };
  if (multiple && input['literal'] !== undefined && !literal) return { ok: false, reason: 'patterns are always literal; omit literal or set it to true.' };
  const raw = multiple ? input['patterns'] : [input['pattern']];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PATTERNS) return { ok: false, reason: `patterns must be an array of 1-${MAX_PATTERNS} non-empty literal strings.` };
  const patterns: string[] = [];
  let bytes = 0;
  for (const [index, value] of raw.entries()) {
    const name = multiple ? `patterns[${index}]` : 'pattern';
    if (typeof value !== 'string' || value === '') return { ok: false, reason: `${name} must be a non-empty string.` };
    if (value.length > MAX_PATTERN) return { ok: false, reason: `${name} is longer than ${MAX_PATTERN} characters.` };
    if (value.includes('\0')) return { ok: false, reason: `${name} holds a NUL character.` };
    if ((multiple || literal) && /[\r\n]/.test(value)) return { ok: false, reason: `${name} must be a single-line literal (no CR or LF).` };
    bytes += Buffer.byteLength(value);
    if ((multiple || literal) && bytes > MAX_LITERAL_BYTES) return { ok: false, reason: `Literal patterns exceed ${MAX_LITERAL_BYTES} UTF-8 bytes in total; use fewer or shorter patterns.` };
    patterns.push(value);
  }
  const unique = [...new Set(patterns)];
  return { ok: true, query: { patterns: unique, literal: multiple || literal, label: multiple ? JSON.stringify(unique) : unique[0]! } };
}
