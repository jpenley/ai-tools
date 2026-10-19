import { compilePattern, MAX_WORK, type CompiledPattern, type PatternBudget } from './patterns.ts';

export interface PathExclusions {
  readonly ok: true;
  readonly active: boolean;
  matches(path: string): boolean;
  exhausted(): boolean;
}

export const excludeProperty = {
  type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 512 }, default: [],
  description: 'Exclude any matching whole canonical path, using the same case-insensitive glob syntax as find_files. At most 16 patterns; [] by default. path does not rebase these patterns; use test/** or **/*.min.js. External patterns match absolute paths.',
};

/** Exclusions share one transition budget and one character budget; exhaustion must fail closed. */
export function pathExclusions(raw: unknown): PathExclusions | { readonly ok: false; readonly reason: string } {
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 16)) return { ok: false, reason: 'exclude must be an array of at most 16 whole-path glob patterns.' };
  const budget: PatternBudget = { spent: 0 };
  const patterns: CompiledPattern[] = [];
  for (const [index, value] of (raw as unknown[] | undefined ?? []).entries()) {
    const compiled = compilePattern(value, budget, 'canonical');
    if (!compiled.ok) return { ok: false, reason: `exclude[${index}]: ${compiled.reason}` };
    patterns.push(compiled);
  }
  let characters = 0;
  return {
    ok: true, active: patterns.length > 0,
    exhausted: () => characters > MAX_WORK || patterns.some(pattern => pattern.exhausted()),
    matches(path) {
      for (const pattern of patterns) {
        // Keep find_files' leading-/ shorthand for relative names without losing external POSIX roots.
        const candidate = pattern.pattern.startsWith('/') && !path.startsWith('/') ? `/${path}` : path;
        characters += candidate.length;
        if (characters > MAX_WORK) return false;
        if (pattern.matches(candidate)) return true;
      }
      return false;
    },
  };
}
