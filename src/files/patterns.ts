// The file tools' path patterns (FILES Implementation Decision 10): find_files' `pattern`, and
// search_files' `glob` once it comes, select files by their canonical path (worktree-relative, `/`,
// engine entries prefixed `engine/<repo>/`) with one rule. `*` and `?` stop at `/` and `**` crosses
// it, so `*.ts` is top-level files only, `src/*.ts` the files directly in src, and `**/*.ts` every
// depth; `[...]` is a character class and `{a,b}` alternatives. Patterns ignore case, and `*` and `**`
// match names that start with a dot, since the tools list dot files and dot folders. Node's
// path.matchesGlob does neither (case-sensitive on Windows, and no leading dots on Node 24.21.0).
//
// A pattern is the brain's own text, and the studio has one thread, so matching must stay cheap
// whatever the pattern: never a backtracking regular expression (`*a*a*a*a*b` against a long name is
// exponential there). The pattern compiles into one state machine, `{a,b}` groups included, with no
// expansion into alternatives; a path is matched by walking sets of its states, and each set's step
// on a character is remembered, so a later path pays one lookup per character. One compiled pattern
// (one call) has a work budget: once working out steps has cost more than that, it matches nothing
// more and says so, and the tool refuses rather than stall.
import { CONTROL } from './files.ts';

/** The longest pattern the tools take. */
export const MAX_PATTERN = 512;
/** The most alternatives a pattern's `{a,b}` groups may make, counted as if expanded. */
const MAX_ALTERNATIVES = 64;
/** The most remembered state sets; past it the memory starts over. */
const MAX_REMEMBERED = 4096;
/** The most state visits one compiled pattern may spend working out steps: well under a second. */
export const MAX_WORK = 20_000_000;

/** Shared transition-work budget for a bounded group of patterns. */
export interface PatternBudget { spent: number }

export interface CompiledPattern {
  readonly ok: true;
  readonly pattern: string;
  /** Whether the whole canonical path matches; false for every path once the work budget is spent. */
  matches(canonical: string): boolean;
  /** Whether the work budget ran out, so the answers since mean nothing. */
  exhausted(): boolean;
}

export type PathPattern = CompiledPattern | { readonly ok: false; readonly reason: string };

type Ranges = readonly (readonly [number, number])[];

/** What the brain wrote, read into items before it becomes states. */
type Item =
  | { readonly kind: 'char'; readonly char: string }
  /** `?`: one character, not `/`. */
  | { readonly kind: 'one' }
  /** `*`: any characters but `/`. */
  | { readonly kind: 'star' }
  /** `**` that isn't a whole folder: any characters, `/` included. */
  | { readonly kind: 'deep' }
  /** `**\/`: any number of whole folders, none included. */
  | { readonly kind: 'folders' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: Ranges }
  | { readonly kind: 'group'; readonly options: readonly (readonly Item[])[] };

/**
 * One state. `next` is where reading its character leads (char, one, class) or where it hands on
 * without reading (star, deep, folders); star, deep and folders also stay on themselves. folders
 * goes to its `within` state part-way through a folder's name, which returns at the next `/`.
 * split hands on to each of a group's options.
 */
type State =
  | { readonly kind: 'match' }
  | { readonly kind: 'char'; readonly char: string; readonly next: number }
  | { readonly kind: 'one'; readonly next: number }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: Ranges; readonly next: number }
  | { readonly kind: 'star'; readonly next: number }
  | { readonly kind: 'deep'; readonly next: number }
  | { kind: 'folders'; readonly next: number; within: number }
  | { readonly kind: 'within'; readonly back: number }
  | { readonly kind: 'split'; readonly options: readonly number[] };

/**
 * `raw` read as a path pattern, or why it isn't one. `\` is turned into `/`, as paths are, so it
 * escapes nothing: `[*]` matches a literal star. A leading `/` or `./` is dropped, since every
 * canonical path is relative to the worktree. Canonical exclusions retain an absolute leading /.
 */
export function compilePattern(raw: unknown, budget?: PatternBudget, normalization: 'relative' | 'canonical' = 'relative'): PathPattern {
  if (typeof raw !== 'string') return { ok: false, reason: 'pattern must be text, such as **/*.ts.' };
  if (raw.length > MAX_PATTERN) return { ok: false, reason: `pattern is longer than ${MAX_PATTERN} characters.` };
  if (CONTROL.test(raw)) return { ok: false, reason: 'pattern holds a control character.' };
  let pattern = raw.trim().replaceAll('\\', '/');
  for (;;) {
    if (pattern.startsWith('./')) pattern = pattern.slice(2);
    else if (normalization === 'relative' && pattern.startsWith('/')) pattern = pattern.slice(1);
    else break;
  }
  if (pattern === '') return { ok: false, reason: 'pattern is empty; give one such as **/*.ts.' };
  const items = itemsOf(Array.from(pattern.toLowerCase()), true);
  if (alternativesOf(items) > MAX_ALTERNATIVES) return { ok: false, reason: `pattern's {…} groups make more than ${MAX_ALTERNATIVES} alternatives; narrow it.` };
  const states: State[] = [{ kind: 'match' }];
  const start = compileSequence(items, 0, states);
  return { ok: true, pattern, ...machine(states, start, budget) };
}

/** The items of `text`; `segmentStart` says whether its first character starts a folder or file name. */
function itemsOf(text: readonly string[], segmentStart: boolean): Item[] {
  const items: Item[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const atStart = index === 0 ? segmentStart : text[index - 1] === '/';
    if (char === '*') {
      let run = 1;
      while (text[index + run] === '*') run += 1;
      if (run === 1) {
        items.push({ kind: 'star' });
      } else if (atStart && text[index + run] === '/') {
        items.push({ kind: 'folders' });
        run += 1;
      } else {
        items.push({ kind: 'deep' });
      }
      index += run - 1;
    } else if (char === '?') {
      items.push({ kind: 'one' });
    } else if (char === '[') {
      const close = classEnd(text, index);
      if (close < 0) {
        items.push({ kind: 'char', char });
        continue;
      }
      items.push(classOf(text.slice(index + 1, close)));
      index = close;
    } else if (char === '{') {
      const group = groupAt(text, index);
      if (group === null) {
        items.push({ kind: 'char', char });
        continue;
      }
      items.push({ kind: 'group', options: group.options.map((option) => itemsOf(option, atStart)) });
      index = group.end;
    } else {
      items.push({ kind: 'char', char });
    }
  }
  return items;
}

/** The `{…}` opened at `start` when it holds a top-level comma, outside classes; null leaves the `{` literal. */
function groupAt(text: readonly string[], start: number): { end: number; options: string[][] } | null {
  let depth = 0;
  const cuts = [start];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '[') {
      const end = classEnd(text, index);
      if (end > 0) index = end;
    } else if (char === '{') {
      depth += 1;
    } else if (char === ',' && depth === 1) {
      cuts.push(index);
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (cuts.length === 1) return null;
        cuts.push(index);
        return { end: index, options: cuts.slice(1).map((cut, at) => text.slice(cuts[at]! + 1, cut)) };
      }
    }
  }
  return null;
}

/** Where the class opened at `start` closes: the `]` after at least one member (a leading `]` is a member), or -1. */
function classEnd(text: readonly string[], start: number): number {
  let index = start + 1;
  if (text[index] === '!' || text[index] === '^') index += 1;
  if (text[index] === ']') index += 1;
  for (; index < text.length; index += 1) if (text[index] === ']') return index;
  return -1;
}

/** A class from the characters between `[` and `]`: `!` or `^` first negates, `a-z` is a range, a `-` at either end is itself. */
function classOf(body: readonly string[]): Item {
  const negated = body[0] === '!' || body[0] === '^';
  const ranges: [number, number][] = [];
  for (let index = negated ? 1 : 0; index < body.length; index += 1) {
    const from = body[index]!.codePointAt(0)!;
    if (body[index + 1] === '-' && index + 2 < body.length) {
      const to = body[index + 2]!.codePointAt(0)!;
      ranges.push(from <= to ? [from, to] : [to, from]);
      index += 2;
    } else {
      ranges.push([from, from]);
    }
  }
  return { kind: 'class', negated, ranges };
}

/** How many alternatives `items` would expand to, counting no further than just past the cap. */
function alternativesOf(items: readonly Item[]): number {
  let count = 1;
  for (const item of items) {
    if (item.kind !== 'group') continue;
    let options = 0;
    for (const option of item.options) options = Math.min(options + alternativesOf(option), MAX_ALTERNATIVES + 1);
    count = Math.min(count * options, MAX_ALTERNATIVES + 1);
  }
  return count;
}

/** Adds the states for `items`, last first, ending at `then`; returns the first one's index. */
function compileSequence(items: readonly Item[], then: number, states: State[]): number {
  let next = then;
  for (let index = items.length - 1; index >= 0; index -= 1) next = compileItem(items[index]!, next, states);
  return next;
}

function compileItem(item: Item, next: number, states: State[]): number {
  switch (item.kind) {
    case 'char': return states.push({ kind: 'char', char: item.char, next }) - 1;
    case 'one': return states.push({ kind: 'one', next }) - 1;
    case 'class': return states.push({ kind: 'class', negated: item.negated, ranges: item.ranges, next }) - 1;
    case 'star': return states.push({ kind: 'star', next }) - 1;
    case 'deep': return states.push({ kind: 'deep', next }) - 1;
    case 'folders': {
      const folders: State = { kind: 'folders', next, within: -1 };
      const index = states.push(folders) - 1;
      folders.within = states.push({ kind: 'within', back: index }) - 1;
      return index;
    }
    case 'group': return states.push({ kind: 'split', options: item.options.map((option) => compileSequence(option, next, states)) }) - 1;
  }
}

/** A set of states the walk can be in, and where each character it has read from there led. */
interface StateSet {
  readonly states: readonly number[];
  readonly key: string;
  readonly accepts: boolean;
  readonly steps: Map<string, StateSet>;
}

/** The matcher over `states` from `start`, remembering each state set's step on each character. */
function machine(states: readonly State[], start: number, budget: PatternBudget = { spent: 0 }): Pick<CompiledPattern, 'matches' | 'exhausted'> {
  let spent = false;
  // Reused by every step rather than made per character: which states the set being built holds
  // (by this step's mark), and the states still to visit.
  const seen = new Uint32Array(states.length);
  let mark = 0;
  const pending: number[] = [];
  let known = new Map<string, StateSet>();

  /** The set holding `from` and every state they hand on to without reading, remembered once. */
  const setOf = (from: readonly number[]): StateSet => {
    mark += 1;
    const held: number[] = [];
    pending.length = 0;
    pending.push(...from);
    while (pending.length > 0) {
      const index = pending.pop()!;
      if (seen[index] === mark) continue;
      seen[index] = mark;
      held.push(index);
      const state = states[index]!;
      if (state.kind === 'split') pending.push(...state.options);
      else if (state.kind === 'star' || state.kind === 'deep' || state.kind === 'folders') pending.push(state.next);
    }
    budget.spent += held.length;
    held.sort((a, b) => a - b);
    const key = held.join(',');
    const found = known.get(key);
    if (found !== undefined) return found;
    if (known.size >= MAX_REMEMBERED) known = new Map();
    const made: StateSet = { states: held, key, accepts: seen[0] === mark, steps: new Map() };
    known.set(key, made);
    return made;
  };

  /** Where reading `char` takes the set `from`, remembered on it. */
  const step = (from: StateSet, char: string): StateSet => {
    budget.spent += from.states.length;
    const point = char.codePointAt(0)!;
    const reached: number[] = [];
    for (const index of from.states) {
      const state = states[index]!;
      switch (state.kind) {
        case 'char': if (char === state.char) reached.push(state.next); break;
        case 'one': if (char !== '/') reached.push(state.next); break;
        case 'class':
          if (char !== '/' && state.ranges.some(([low, high]) => point >= low && point <= high) !== state.negated) reached.push(state.next);
          break;
        case 'star': if (char !== '/') reached.push(index); break;
        case 'deep': reached.push(index); break;
        case 'folders': reached.push(char === '/' ? index : state.within); break;
        case 'within': reached.push(char === '/' ? state.back : index); break;
        default: break;
      }
    }
    const next = setOf(reached);
    from.steps.set(char, next);
    return next;
  };

  let first = setOf([start]);
  return {
    exhausted: () => spent || budget.spent > MAX_WORK,
    matches(canonical: string): boolean {
      if (spent || budget.spent > MAX_WORK) return false;
      // The memory may have started over since the start set was made; the set is the same either way.
      if (!known.has(first.key)) first = setOf([start]);
      let current = first;
      for (const char of canonical.toLowerCase()) {
        current = current.steps.get(char) ?? step(current, char);
        if (budget.spent > MAX_WORK) {
          spent = true;
          return false;
        }
      }
      return current.accepts;
    },
  };
}
