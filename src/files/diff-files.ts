import { readText, type FileSession, type TextFile } from './files.ts';
import { checked, fail, integer, pathProperty, tool } from './core/filesystem.ts';
import { cut } from './view-file.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';

type Change = { a0: number; a1: number; b0: number; b1: number };
const same = (a: TextFile, b: TextFile, i: number, j: number) => a.lines[i]?.text === b.lines[j]?.text && a.lines[i]?.ending === b.lines[j]?.ending;

/** Bounded patience diff: unique-line anchors with an LIS, not a quadratic LCS.
 * Repetitive/unanchored regions are emitted as replacements, never an incorrect diff.
 */
function changes(a: TextFile, b: TextFile): Change[] {
  let first = 0, lastA = a.lines.length, lastB = b.lines.length;
  while (first < lastA && first < lastB && same(a, b, first, first)) first++;
  while (lastA > first && lastB > first && same(a, b, lastA - 1, lastB - 1)) { lastA--; lastB--; }
  const pairs: Array<[number, number]> = [];
  if (lastA - first + lastB - first <= 100_000) {
    const unique = (file: TextFile, end: number) => {
      const map = new Map<string, number>();
      for (let i = first; i < end; i++) {
        const line = file.lines[i]!;
        const key = `${line.ending}\0${line.text}`;
        map.set(key, map.has(key) ? -1 : i);
      }
      return map;
    };
    const left = unique(a, lastA), right = unique(b, lastB);
    for (const [key, i] of left) {
      const j = right.get(key);
      if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
  }
  const tails: number[] = [], previous: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >>> 1; if (pairs[tails[mid]!]![1] < pairs[i]![1]) low = mid + 1; else high = mid; }
    previous[i] = low === 0 ? -1 : tails[low - 1]!;
    tails[low] = i;
  }
  const anchors: Array<[number, number]> = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) anchors.push(pairs[i]!);
  anchors.reverse(); anchors.push([lastA, lastB]);
  const result: Change[] = [];
  let a0 = first, b0 = first;
  for (const [nextA, nextB] of anchors) {
    let a1 = nextA, b1 = nextB;
    while (a0 < a1 && b0 < b1 && same(a, b, a0, b0)) { a0++; b0++; }
    while (a1 > a0 && b1 > b0 && same(a, b, a1 - 1, b1 - 1)) { a1--; b1--; }
    if (a0 !== a1 || b0 !== b1) result.push({ a0, a1, b0, b1 });
    a0 = nextA + 1; b0 = nextB + 1;
  }
  return result;
}

function* records(a: TextFile, b: TextFile, edits: Change[], context: number, full: boolean): Generator<string> {
  const groups: Array<{ range: Change; edits: Change[] }> = [];
  for (const edit of edits) {
    const before = Math.min(context, edit.a0, edit.b0);
    const after = Math.min(context, a.lines.length - edit.a1, b.lines.length - edit.b1);
    const range = { a0: edit.a0 - before, b0: edit.b0 - before, a1: edit.a1 + after, b1: edit.b1 + after };
    const last = groups.at(-1);
    if (last && range.a0 <= last.range.a1 && range.b0 <= last.range.b1) {
      last.range.a1 = range.a1; last.range.b1 = range.b1; last.edits.push(edit);
    } else groups.push({ range, edits: [edit] });
  }
  if (edits.length === 0) yield 'Formatting-only change (see BOM/EOL/final-newline metadata).';
  for (const { range, edits: group } of groups) {
    const countA = range.a1 - range.a0, countB = range.b1 - range.b0;
    yield `@@ -${countA ? range.a0 + 1 : range.a0},${countA} +${countB ? range.b0 + 1 : range.b0},${countB} @@`;
    let i = range.a0;
    for (const edit of group) {
      while (i < edit.a0) yield ` ${cut(a.lines[i++]!.text, full)}`;
      for (; i < edit.a1; i++) yield `-${cut(a.lines[i]!.text, full)}`;
      for (let j = edit.b0; j < edit.b1; j++) yield `+${cut(b.lines[j]!.text, full)}`;
    }
    while (i < range.a1) yield ` ${cut(a.lines[i++]!.text, full)}`;
  }
}

export function diffFilesTool(session: FileSession) {
  return tool('diff_files', 'Compare two allowed UTF-8 files (16 MiB each) using bounded multi-hunk contextual diff. Repeated/unanchored regions may be shown as replacements. Inspection only, not apply-ready. Paginate with offset; continuation requires left_base/right_base from the first page, refusing stale files. Default: 200 diff lines (max_lines up to 400) or about 48 KiB. max_lines includes hunk headers. full:true returns all remaining diff records and uncut lines, ignoring max_lines but retaining file-size and stale-hash checks.', {
    left: pathProperty, right: pathProperty,
    full: fullOutputProperty,
    max_lines: { type: 'integer', minimum: 1, maximum: 400 },
    context_lines: { type: 'integer', minimum: 0, maximum: 20 },
    offset: { type: 'integer', minimum: 0 },
    left_base: { type: 'string', description: 'Left file hash; required for continuation.' },
    right_base: { type: 'string', description: 'Right file hash; required for continuation.' },
  }, ['left', 'right'], input => {
    const full = fullOutputArgument(input['full']);
    if (full === null) fail('full must be true or false.');
    const left = checked(session, input['left'], 'read'), right = checked(session, input['right'], 'read');
    const read = (path: typeof left): TextFile => { const result = readText(path); if (!result.ok) fail(result.reason); return result.file; };
    const a = read(left), b = read(right);
    const limit = integer(input['max_lines'], 200, 1, 400, 'max_lines');
    const context = integer(input['context_lines'], 3, 0, 20, 'context_lines');
    const offset = integer(input['offset'], 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    if ((offset > 0 || input['left_base'] !== undefined || input['right_base'] !== undefined) && (input['left_base'] !== a.hash || input['right_base'] !== b.hash)) fail('STALE: continuation requires matching left_base and right_base; restart the diff.');
    if (a.hash === b.hash) return `identical: ${left.canonical} file=${a.hash}; ${right.canonical} file=${b.hash}`;
    const output = [`--- ${left.canonical} file=${a.hash} eol=${a.eol} bom=${a.bom} final-newline=${a.finalNewline}`, `+++ ${right.canonical} file=${b.hash} eol=${b.eol} bom=${b.bom} final-newline=${b.finalNewline}`, `left_base=${a.hash} right_base=${b.hash} offset=${offset}`];
    let index = 0, shown = 0, bytes = Buffer.byteLength(output.join('\n'));
    for (const line of records(a, b, changes(a, b), context, full)) {
      if (index++ < offset) continue;
      if (!full && (shown >= limit || bytes + Buffer.byteLength(line) > 48 * 1024)) {
        output.push(`next: offset=${offset + shown} left_base=${a.hash} right_base=${b.hash}`); break;
      }
      output.push(line); shown++; bytes += Buffer.byteLength(line) + 1;
    }
    return output.join('\n');
  });
}
