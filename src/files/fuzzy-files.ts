import { CONTROL } from './files.ts';
import { MAX_PATTERN, MAX_WORK } from './patterns.ts';

/** Lower is better: match class, skipped characters, start, basename length, path length. */
export type FuzzyRank = readonly [number, number, number, number, number];
interface FuzzyQuery {
  readonly ok: true;
  readonly pattern: string;
  rank(path: string): FuzzyRank | null;
  exhausted(): boolean;
}

/** Deterministic subsequences, not spelling correction; no edit distance or persistent history. */
export function compileFuzzyQuery(raw: unknown): FuzzyQuery | { readonly ok: false; readonly reason: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'pattern must be a non-empty fuzzy filename query.' };
  if (raw.length > MAX_PATTERN || CONTROL.test(raw)) return { ok: false, reason: `A fuzzy pattern must be at most ${MAX_PATTERN} characters with no control characters.` };
  const pattern = raw.replaceAll('\\', '/');
  const folded = pattern.toLowerCase();
  const query = Array.from(folded);
  let work = 0;
  return {
    ok: true, pattern,
    exhausted: () => work > MAX_WORK,
    rank(path) {
      // Charge even contiguous matches so cached/fast string operations cannot evade a whole-call bound.
      work += 4 * (path.length + query.length);
      if (work > MAX_WORK) return null;
      const canonical = path.toLowerCase();
      const basename = canonical.slice(canonical.lastIndexOf('/') + 1);
      const base = Array.from(basename);
      const whole = Array.from(canonical);
      const tail: readonly [number, number] = [base.length, whole.length];
      if (basename === folded) return [0, 0, 0, ...tail];
      if (basename.startsWith(folded)) return [1, 0, 0, ...tail];
      const at = basename.indexOf(folded);
      if (at >= 0) return [2, 0, Array.from(basename.slice(0, at)).length, ...tail];
      const inBase = subsequence(base, query);
      if (inBase !== null) return [3, ...inBase, ...tail];
      const inPath = subsequence(whole, query);
      return inPath === null ? null : [4, ...inPath, ...tail];
    },
  };
}

function subsequence(path: readonly string[], query: readonly string[]): readonly [number, number] | null {
  let next = 0, first = -1;
  for (let index = 0; index < path.length; index++) {
    if (path[index] !== query[next]) continue;
    if (first < 0) first = index;
    next++;
    if (next === query.length) return [index - first + 1 - query.length, first];
  }
  return null;
}

export function compareFuzzy(a: FuzzyRank, b: FuzzyRank): number {
  for (let index = 0; index < a.length; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
