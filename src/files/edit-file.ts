// The studio's line editor, `edit_file` (FILES-edit, studio-files.md): changes lines of a file by
// anchor, `N:hhhhhh` as view_file prints them, and lands only if the whole file is still the one the
// brain saw (its `base` hash) and every anchor still names its line. Several edits to one file land
// together or not at all, and the reply hands back the file's new hash and fresh anchors round what
// changed, so the next edit needs no new view. Only implementers have it, by the same name in every
// harness.
//
// Each call checks its arguments, judges its path for writing with the shared file module's path
// layer (files.ts), then, holding the file's lock, reads the file and runs FILES Implementation
// Decision 7's checks in order, the first failing one deciding the reply's single code; only then are
// the edits applied, bottom-up against the numbering the brain saw, and written through the module's
// atomic writer. Anchors are never moved to a look-alike line: any change refuses the edit
// (Implementation Decision 8). New lines take the file's ending, a BOM stays, and a file with no final
// newline keeps none (FILES-endings).
import { lstatSync } from 'node:fs';
import * as z from 'zod';
import type { GatewayTool, ToolReply } from '../contract.ts';
import type { BuiltInTool } from '../contract.ts';
import { listArgument } from '../shared/arguments.ts';
import { anchorOf, lineHash, MAX_FILE_BYTES, readText, startCall, withFileLock, writeAtomic, type AllowedPath, type FileSession, type TextFile, type WriterFaults } from './files.ts';
import { cut, VIEW_MAX_BYTES, VIEW_MAX_LINES } from './view-file.ts';

/** The most edits one call takes. */
export const EDIT_MAX_OPS = 50;
/** The lines of context a reply shows on each side of a changed region. */
const REPLY_CONTEXT = 2;
/** The lines of context a STALE or ANCHOR_MISMATCH report shows on each side of an anchor. */
const REPORT_CONTEXT = 3;
/** The most other line numbers a report lists for one anchor's hash, the nearest to it; the rest are counted. */
const REPORT_MATCHES = 20;

const OPS = ['replace', 'delete', 'insert_before', 'insert_after', 'append', 'replace_text'] as const;

/** The line editor as the gateway offers it: a flat, hand-written schema (Implementation Decision 1). */
export const EDIT_FILE_TOOL: GatewayTool = {
  name: 'edit_file',
  description:
    'Change lines of a text file in your task worktree by their anchors, N:hhhhhh as view_file shows them. ' +
    'Pass base, the file=<hash> from your latest view_file or edit_file reply for this file, and 1 to 50 edits, which land together or not at all. ' +
    'Ops: replace {from, to?, lines} replaces lines from..to (to defaults to from) with lines; delete {from, to?}; insert_before {at, lines}; insert_after {at, lines}; append {lines} adds lines at the end; ' +
    'replace_text {old, new} replaces the one place old occurs (it must occur exactly once) and needs no base. ' +
    'from, to and at are anchors such as 12:a3f9c0; every anchor refers to the file as you saw it, so do not renumber for earlier edits in the same call. Each element of lines is one line, without a line break. ' +
    'Edits may not overlap or share a line or an insert point. ' +
    'If the file changed since you saw it, or an anchor does not match its line, nothing is written and the reply starts STALE or ANCHOR_MISMATCH with the lines as they are now. ' +
    'The reply is "edited <path>  file=<old>-><new>  lines=<n>" then each changed region\'s lines with fresh anchors and 2 lines of context. ' +
    'A line view_file showed cut can still be deleted or inserted around by its anchor, or changed with replace_text; replace needs the whole line. ' +
    'New lines take the file\'s line ending; a byte-order mark and a missing final newline are kept. Engine repos (engine/<repo>) are read-only; .git, credential files, hard-linked files and links are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file, relative to your worktree, such as src/main.ts.' },
      base: { type: 'string', description: 'The file=<hash> from your latest view_file or edit_file reply for this file. Required unless every edit is replace_text.' },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: EDIT_MAX_OPS,
        description: 'The edits, 1 to 50, all against the file as you saw it.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: [...OPS], description: 'What the edit does.' },
            from: { type: 'string', description: 'replace and delete: the anchor of the first line, such as 12:a3f9c0.' },
            to: { type: 'string', description: 'replace and delete: the anchor of the last line; the same line as from when left out.' },
            at: { type: 'string', description: 'insert_before and insert_after: the anchor of the line to insert next to.' },
            lines: { type: 'array', items: { type: 'string' }, description: 'replace, insert_before, insert_after and append: the new lines, one per element, at least one.' },
            old: { type: 'string', description: 'replace_text: the text to replace, which must occur exactly once; it may span lines.' },
            new: { type: 'string', description: 'replace_text: the text to put in its place.' },
          },
          required: ['op'],
        },
      },
    },
    required: ['path', 'edits'],
  },
};

/** An anchor as an edit names it. */
interface Anchor {
  readonly number: number;
  readonly hash: string;
  /** As the brain wrote it, lower-cased: `N:hhhhhh`. */
  readonly text: string;
}

const anchor = z.string().regex(/^\s*\d+:[0-9a-fA-F]{6}\s*$/, 'must be an anchor N:hhhhhh, such as 12:a3f9c0, as view_file shows it').transform((raw): Anchor => {
  const [number, hash] = raw.trim().toLowerCase().split(':') as [string, string];
  // A number too large to be exact names no line; the range check refuses it.
  return { number: Number.isSafeInteger(Number(number)) ? Number(number) : Number.MAX_SAFE_INTEGER, hash, text: `${number}:${hash}` };
});
const text = z.string().refine((value) => !value.includes('\u0000'), "holds a NUL character; the studio's tools write UTF-8 text only")
  .refine((value) => value.isWellFormed(), "holds a lone surrogate, which is not UTF-8; the studio's tools write UTF-8 text only");
const line = text.refine((value) => !/[\r\n]/.test(value), 'holds a line break; give each line as its own element');
const lines = z.array(line).min(1, 'must hold at least one line');

const OP = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('replace'), from: anchor, to: anchor.optional(), lines }),
  z.strictObject({ op: z.literal('delete'), from: anchor, to: anchor.optional() }),
  z.strictObject({ op: z.literal('insert_before'), at: anchor, lines }),
  z.strictObject({ op: z.literal('insert_after'), at: anchor, lines }),
  z.strictObject({ op: z.literal('append'), lines }),
  z.strictObject({ op: z.literal('replace_text'), old: text.refine((value) => value !== '', 'must not be empty'), new: text }),
], { error: `must be one of ${OPS.join(', ')}` });
const EDITS = z.array(OP, { error: `must be a list of 1 to ${EDIT_MAX_OPS} edits` }).min(1, `must hold 1 to ${EDIT_MAX_OPS} edits`).max(EDIT_MAX_OPS, `must hold 1 to ${EDIT_MAX_OPS} edits`);

type Op = z.infer<typeof OP>;

/** The line editor for one session, bound when the session starts; `faults` only in tests. */
export function editFileTool(session: FileSession, faults: WriterFaults = {}): BuiltInTool {
  return {
    tool: EDIT_FILE_TOOL,
    async call(input): Promise<ToolReply> {
      // 1. BAD_ARGS: the arguments' shape, with lists sent as JSON text read back as lists first.
      const args = parsedArguments(input);
      if (typeof args === 'string') return refused('BAD_ARGS', args);
      const { base, edits } = args;
      // 2. PATH: the path's write rule.
      const path = startCall(session).judge(input['path'], 'write');
      if (!path.ok) return refused('PATH', path.reason);
      // The lock is taken before the first await, so edits sent together land in the order sent and
      // the later one finds the file changed (STALE), never a merge of both.
      return withFileLock(path.absolute, async () => {
        // 3. UNREADABLE, read again under the lock: the path layer's look came before it.
        const read = readText({ ...path, kind: kindNow(path) });
        if (!read.ok) return refused('UNREADABLE', read.reason);
        const file = read.file;
        const checked = check(path.canonical, file, base, edits);
        if (typeof checked === 'string') return { success: false, content: [{ type: 'text', text: checked }] };
        // 9. NO_CHANGE.
        const result = applied(file, checked);
        if (result.bytes.equals(file.bytes)) return refused('NO_CHANGE', `the edits leave ${path.canonical} exactly as it is.`);
        if (result.bytes.length > MAX_FILE_BYTES) {
          return refused('BAD_ARGS', `the edited file would be ${(result.bytes.length / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_FILE_BYTES / (1024 * 1024)} MB the studio's tools write.`);
        }
        // A replace_text-only call with no base is checked against what was read at step 3.
        const written = await writeAtomic(path, result.bytes, file.hash, faults);
        if (!written.ok && written.code === 'STALE') {
          // Changed between the read and the rename: read it again, still under the lock, so this
          // STALE has step 4's report.
          const now = readText({ ...path, kind: kindNow(path) });
          if (now.ok) {
            const text = report(`STALE: ${path.canonical} is ${now.file.hash}, not ${base ?? file.hash}.`, path.canonical, now.file, mismatchedIn(now.file, edits));
            return { success: false, content: [{ type: 'text', text }] };
          }
        }
        if (!written.ok) return refused(written.code, written.reason);
        return { success: true, content: [{ type: 'text', text: replyOf(path.canonical, file.hash, written.file, result.changes) }] };
      });
    },
  };
}

/** The checked arguments, or why they are refused. */
function parsedArguments(input: Record<string, unknown>): { base: string | null; edits: Op[] } | string {
  const rawBase = input['base'];
  if (rawBase !== undefined && rawBase !== null && typeof rawBase !== 'string') return 'base must be text: the file=<hash> from view_file.';
  const base = typeof rawBase === 'string' && rawBase.trim() !== '' ? rawBase.trim().toLowerCase() : null;
  if (base !== null && !/^[0-9a-f]{16}$/.test(base)) return 'base must be the 16 hex characters of file=<hash> from view_file.';
  const rawEdits = listArgument(input['edits']);
  const listed = Array.isArray(rawEdits)
    ? rawEdits.map((edit: unknown) => (edit !== null && typeof edit === 'object' && !Array.isArray(edit) && 'lines' in edit ? { ...edit, lines: listArgument((edit as { lines: unknown }).lines) } : edit))
    : rawEdits;
  const parsed = EDITS.safeParse(listed);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return `${placeOf(issue.path)} ${issue.message}.`;
  }
  const edits = parsed.data;
  for (const [index, edit] of edits.entries()) {
    if ((edit.op === 'replace' || edit.op === 'delete') && edit.to !== undefined && edit.from.number > edit.to.number) {
      return `edit ${index + 1}: from (${edit.from.text}) is after to (${edit.to.text}).`;
    }
  }
  if (base === null && edits.some((edit) => edit.op !== 'replace_text')) {
    return 'base is required unless every edit is replace_text: pass the file=<hash> from your latest view_file of the file.';
  }
  return { base, edits };
}

/** Where in the arguments a zod issue is, in words: `edits`, `edit 2`, `edit 2's lines[0]`. */
function placeOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'edits';
  const [index, field, ...rest] = path;
  const edit = `edit ${Number(index) + 1}`;
  if (field === undefined) return `${edit}:`;
  const tail = rest.map((key) => `[${String(key)}]`).join('');
  return `${edit}: ${String(field)}${tail}`;
}

/** What is at the allowed path now, under the lock, without following a link. */
function kindNow(path: AllowedPath): AllowedPath['kind'] {
  try {
    return lstatSync(path.absolute).isDirectory() ? 'folder' : 'file';
  } catch {
    return 'missing';
  }
}

/** One edit as a change to the text: characters `start`..`end` of the text (BOM excluded) become `insert`. */
interface Change {
  readonly start: number;
  readonly end: number;
  readonly insert: string;
}

/** Where each line starts in the text, with one entry past the end. */
function lineStarts(file: TextFile): number[] {
  const starts = [0];
  for (const each of file.lines) starts.push(starts.at(-1)! + each.text.length + each.ending.length);
  return starts;
}

/**
 * Runs Implementation Decision 7's steps 4 to 7 on the file as read: STALE, ANCHOR_MISMATCH,
 * NO_MATCH or AMBIGUOUS, OVERLAP. Returns the edits as changes to the text, or the whole refusal.
 */
function check(canonical: string, file: TextFile, base: string | null, edits: readonly Op[]): Change[] | string {
  const n = file.lines.length;
  const mismatched = mismatchedIn(file, edits);
  // 4. STALE, reporting the anchors that no longer match.
  if (base !== null && base !== file.hash) return report(`STALE: ${canonical} is ${file.hash}, not ${base}.`, canonical, file, mismatched);
  // 5. ANCHOR_MISMATCH, even when the base matches.
  if (mismatched.length > 0) {
    const count = new Set(mismatched.map((each) => each.text)).size;
    const what = count === 1 ? 'an anchor does not match its line' : `${count} anchors do not match their lines`;
    return report(`ANCHOR_MISMATCH: in ${canonical}, ${what}.`, canonical, file, mismatched);
  }

  // The text the edits change: the file without its BOM. A file with no final newline is worked on
  // with one, in the file's ending, so a line that was last and no longer is gains that ending; it is
  // taken off again once the edits are applied.
  const ending = file.eol === 'crlf' ? '\r\n' : '\n';
  const starts = lineStarts(file);
  const original = file.lines.map((each) => each.text + each.ending).join('');
  const end = (number: number): number => (number === n && !file.finalNewline ? starts[number]! + ending.length : starts[number]!);
  const newLines = (texts: readonly string[]): string => texts.map((each) => each + ending).join('');

  // 6. NO_MATCH or AMBIGUOUS, and each edit's region in lines (`first`..`last`, empty for an insert
  // point between lines `last` and `first`) for the overlap check.
  interface Region { readonly first: number; readonly last: number; readonly anchor: number | null; readonly change: Change }
  const regions: Region[] = [];
  for (const [index, edit] of edits.entries()) {
    switch (edit.op) {
      case 'replace':
      case 'delete': {
        const last = (edit.to ?? edit.from).number;
        regions.push({ first: edit.from.number, last, anchor: null, change: { start: starts[edit.from.number - 1]!, end: end(last), insert: edit.op === 'replace' ? newLines(edit.lines) : '' } });
        break;
      }
      case 'insert_before':
        regions.push({ first: edit.at.number, last: edit.at.number - 1, anchor: edit.at.number, change: { start: starts[edit.at.number - 1]!, end: starts[edit.at.number - 1]!, insert: newLines(edit.lines) } });
        break;
      case 'insert_after':
        regions.push({ first: edit.at.number + 1, last: edit.at.number, anchor: edit.at.number, change: { start: end(edit.at.number), end: end(edit.at.number), insert: newLines(edit.lines) } });
        break;
      // In a file with no final newline, the old last line gains the file's ending here (FILES-endings).
      // In an lf, mixed or none file that ending is LF, so a lone CR ending that line becomes part of a
      // CRLF terminator and leaves the line's text; the same holds for insert_after on that line.
      case 'append':
        regions.push({ first: n + 1, last: n, anchor: null, change: { start: end(n), end: end(n), insert: newLines(edit.lines) } });
        break;
      case 'replace_text': {
        const found = occurrence(original, edit.old, ending);
        if (found.count === 0) return codeReply('NO_MATCH', `edit ${index + 1}'s old text does not occur in ${canonical}; view the file and copy the text exactly.`);
        if (found.count > 1) return codeReply('AMBIGUOUS', `edit ${index + 1}'s old text occurs more than once in ${canonical}; add text round it so it occurs once.`);
        const startLine = lineAt(starts, found.at);
        const lastLine = lineAt(starts, found.at + found.length - 1);
        // A new text of several lines takes the file's ending; a lone CR is no ending and stays.
        const insert = edit.new.replaceAll('\r\n', '\n').replaceAll('\n', ending);
        regions.push({ first: startLine, last: lastLine, anchor: null, change: { start: found.at, end: found.at + found.length, insert } });
        break;
      }
    }
  }

  // 7. OVERLAP: two regions sharing a line, two inserts at one point, or an insert inside a region or
  // next to a line another edit changes.
  for (let a = 0; a < regions.length; a += 1) {
    for (let b = a + 1; b < regions.length; b += 1) {
      if (overlaps(regions[a]!, regions[b]!)) {
        return codeReply('OVERLAP', `edits ${a + 1} and ${b + 1} overlap in ${canonical}: they share a line or an insert point, or one inserts next to a line the other changes; make them one edit.`);
      }
    }
  }
  return regions.map((region) => region.change);
}

/** The edits' anchors that don't name their line in `file`: out of range, or another hash there. */
function mismatchedIn(file: TextFile, edits: readonly Op[]): Anchor[] {
  const n = file.lines.length;
  const anchors = edits.flatMap((edit) => 'from' in edit ? [edit.from, ...(edit.to === undefined ? [] : [edit.to])] : 'at' in edit ? [edit.at] : []);
  return anchors.filter((each) => each.number < 1 || each.number > n || lineHash(file.lines[each.number - 1]!.text) !== each.hash);
}

/** Whether two edits' regions overlap (Implementation Decision 7, step 7). */
function overlaps(a: { first: number; last: number; anchor: number | null }, b: { first: number; last: number; anchor: number | null }): boolean {
  const aPoint = a.last < a.first;
  const bPoint = b.last < b.first;
  // Two inserts at one point; insert_after N and insert_before N+1, or append and insert_after the last line, are one point.
  if (aPoint && bPoint) return a.last === b.last;
  if (!aPoint && !bPoint) return a.first <= b.last && b.first <= a.last;
  const [point, range] = aPoint ? [a, b] : [b, a];
  // An insert between two lines of a region, or one whose anchor is a line the region changes.
  const gap = point.last;
  return (range.first <= gap && gap < range.last) || (point.anchor !== null && range.first <= point.anchor && point.anchor <= range.last);
}

/** The line holding character `at` of the text. */
function lineAt(starts: readonly number[], at: number): number {
  let low = 0;
  let high = starts.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= at) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * Where `old` occurs in `text`, ordinal, overlapping places counting apart: as written, or, when it
 * spans lines and occurs nowhere as written, with its line breaks in the file's ending.
 */
function occurrence(text: string, old: string, ending: string): { count: number; at: number; length: number } {
  const found = places(text, old);
  if (found.count > 0 || !old.includes('\n')) return { ...found, length: old.length };
  const retried = old.replaceAll('\r\n', '\n').replaceAll('\n', ending);
  return retried === old ? { ...found, length: old.length } : { ...places(text, retried), length: retried.length };
}

/** Where `old` first occurs, and whether it occurs again: 0, 1 or 2 places, since more than one is enough to refuse. */
function places(text: string, old: string): { count: number; at: number } {
  const first = text.indexOf(old);
  if (first < 0) return { count: 0, at: -1 };
  return { count: text.indexOf(old, first + 1) < 0 ? 1 : 2, at: first };
}

/**
 * How many characters to take off the end of the edited text of a file with no final newline, so it
 * keeps none. The edits ran on the text with a temporary terminator in the file's ending; whatever
 * ends the text now is either that terminator, or the last of the new lines an edit reaching the end
 * added, each ending in the file's ending, so that many characters go. Only a delete reaching the end
 * leaves a real line's own terminator last, and that terminator goes. Never more: a last line holding
 * a lone CR keeps it.
 */
function finalTerminator(text: string, ordered: readonly Change[], originalLength: number, ending: string): number {
  const last = ordered.at(-1);
  if (last === undefined || last.end < originalLength || last.insert !== '') return text.length === 0 ? 0 : ending.length;
  return text.endsWith('\r\n') ? 2 : text.endsWith('\n') ? 1 : 0;
}

/** The file after the edits, and each edit's place in the new text. */
interface Applied {
  readonly bytes: Buffer;
  /** Each change's characters in the edited text: `start`..`start + length`. */
  readonly changes: { readonly start: number; readonly length: number }[];
}

/** Applies the checked changes bottom-up against the text as read (step 8), and keeps the file's BOM and final-newline state. */
function applied(file: TextFile, changes: readonly Change[]): Applied {
  const ending = file.eol === 'crlf' ? '\r\n' : '\n';
  const noFinalNewline = file.lines.length > 0 && !file.finalNewline;
  let text = file.lines.map((each) => each.text + each.ending).join('') + (noFinalNewline ? ending : '');
  const originalLength = text.length;
  // In text order; at one place an insert comes before the edit replacing what follows it.
  const ordered = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const change of [...ordered].reverse()) text = text.slice(0, change.start) + change.insert + text.slice(change.end);
  let shift = 0;
  const placed = ordered.map((change) => {
    const place = { start: change.start + shift, length: change.insert.length };
    shift += change.insert.length - (change.end - change.start);
    return place;
  });
  let final = text;
  if (noFinalNewline) final = final.slice(0, final.length - finalTerminator(final, ordered, originalLength, ending));
  const body = Buffer.from(final, 'utf8');
  return { bytes: file.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body, changes: placed };
}

/**
 * The reply to an edit that landed: the header, then each changed region's lines with fresh anchors
 * and 2 lines of context, regions whose context overlaps or touches merged, in line order, at most
 * 400 lines and 50 KB; a region past that is named instead. A pure delete shows the 2 lines on each
 * side of the gap it left.
 */
function replyOf(canonical: string, oldHash: string, written: TextFile, changes: readonly { start: number; length: number }[]): string {
  const header = `edited ${canonical}  file=${oldHash}->${written.hash}  lines=${written.lines.length}`;
  const n = written.lines.length;
  const starts = lineStarts(written);
  const ranges: { first: number; last: number }[] = [];
  for (const change of changes) {
    // Where the change sits in the edited text; one past the last line when it is at the very end.
    const at = change.start >= starts[n]! ? n + 1 : lineAt(starts, change.start);
    const pureGap = change.length === 0 && (at > n || starts[at - 1] === change.start);
    const first = at - REPLY_CONTEXT;
    const last = pureGap ? at - 1 + REPLY_CONTEXT : lineAt(starts, Math.max(change.start, change.start + change.length - 1)) + REPLY_CONTEXT;
    const clipped = { first: Math.max(1, first), last: Math.min(n, last) };
    if (clipped.first <= clipped.last) ranges.push(clipped);
  }
  ranges.sort((a, b) => a.first - b.first);
  const merged: { first: number; last: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.first <= previous.last + 1) previous.last = Math.max(previous.last, range.last);
    else merged.push({ ...range });
  }
  const named = (range: { first: number; last: number }): string => `lines ${range.first}-${range.last} changed; view_file start_line=${range.first}`;
  const out = [header];
  let budget = VIEW_MAX_BYTES - bytes(header);
  let shownLines = 0;
  let full = false;
  for (const [index, range] of merged.entries()) {
    const printed = full ? [] : Array.from({ length: range.last - range.first + 1 }, (_, offset) => {
      const number = range.first + offset;
      const lineText = written.lines[number - 1]!.text;
      return `${anchorOf(number, lineText)}|${cut(lineText)}`;
    });
    const cost = printed.reduce((sum, each) => sum + bytes(each) + 1, 0);
    // Room is kept for naming every region after this one.
    const later = merged.slice(index + 1).reduce((sum, each) => sum + bytes(named(each)) + 1, 0);
    if (!full && shownLines + printed.length <= VIEW_MAX_LINES && cost + later <= budget) {
      out.push(...printed);
      shownLines += printed.length;
      budget -= cost;
    } else {
      full = true;
      out.push(named(range));
      budget -= bytes(named(range)) + 1;
    }
  }
  return out.join('\n');
}

/**
 * A STALE or ANCHOR_MISMATCH report: the code sentence, one sentence per anchor that doesn't match,
 * the lines 3 either side of each such anchor, merged and in line order, then that nothing changed.
 * The other lines an anchor's hash matches, the 20 nearest to it, are given for information and
 * never applied. Like every reply it holds at most 400 lines and 50 KB: the anchors, in line order,
 * that would pass that are named with where to view them instead (FILES Implementation Decision 7's
 * erratum, 2026-10-14).
 */
function report(sentence: string, canonical: string, file: TextFile, anchors: readonly Anchor[]): string {
  const n = file.lines.length;
  const unique = [...new Map(anchors.map((each) => [each.text, each])).values()].sort((a, b) => a.number - b.number || a.hash.localeCompare(b.hash));
  // Every line is hashed once, however many anchors the report names.
  const byHash = new Map<string, number[]>();
  if (unique.length > 0) file.lines.forEach((current, index) => {
    const hash = lineHash(current.text);
    const numbers = byHash.get(hash);
    if (numbers === undefined) byHash.set(hash, [index + 1]);
    else numbers.push(index + 1);
  });
  const lineOf = (number: number): string => `${anchorOf(number, file.lines[number - 1]!.text)}|${cut(file.lines[number - 1]!.text)}`;
  const sentenceOf = (each: Anchor): string => {
    const matches = nearest(byHash.get(each.hash) ?? [], each.number);
    const where = matches.total === 0 ? 'matches no line'
      : matches.total === 1 ? `matches line ${matches.listed[0]}`
      : `matches lines ${matches.listed.join(', ')}${matches.total > matches.listed.length ? ` and ${matches.total - matches.listed.length} more` : ''}`;
    const now = each.number >= 1 && each.number <= n
      ? `Line ${each.number} is now ${lineOf(each.number)}`
      : `Line ${each.number} is past the end of ${canonical}, which has ${n} line${n === 1 ? '' : 's'}`;
    return `${now}; ${each.text} ${where}.`;
  };
  const nameOf = (each: Anchor): string => `Line ${each.number} (anchor ${each.text}) not shown; view_file start_line=${Math.max(1, Math.min(each.number, n) - REPORT_CONTEXT)}`;

  const last = 'Nothing was changed.';
  const sentences: string[] = [];
  const names: string[] = [];
  const shown = new Set<number>();
  // Each line costs its bytes and a line break; room is kept for the last line and for naming every
  // anchor after the one being placed.
  let usedBytes = bytes(sentence) + 1 + bytes(last);
  let usedLines = 2;
  let full = false;
  for (const [index, each] of unique.entries()) {
    const said = sentenceOf(each);
    const context: number[] = [];
    for (let number = Math.max(1, each.number - REPORT_CONTEXT); number <= Math.min(n, each.number + REPORT_CONTEXT); number += 1) {
      if (!shown.has(number)) context.push(number);
    }
    const cost = bytes(said) + 1 + context.reduce((sum, number) => sum + bytes(lineOf(number)) + 1, 0);
    const later = unique.slice(index + 1);
    const reserved = later.reduce((sum, other) => sum + bytes(nameOf(other)) + 1, 0);
    if (!full && usedLines + 1 + context.length + later.length <= VIEW_MAX_LINES && usedBytes + cost + reserved <= VIEW_MAX_BYTES) {
      sentences.push(said);
      for (const number of context) shown.add(number);
      usedBytes += cost;
      usedLines += 1 + context.length;
    } else {
      full = true;
      const name = nameOf(each);
      names.push(name);
      usedBytes += bytes(name) + 1;
      usedLines += 1;
    }
  }
  return [sentence, ...sentences, ...names, ...[...shown].sort((a, b) => a - b).map(lineOf), last].join('\n');
}

/**
 * The lines in `matches` (in line order) nearest to line `number`, at most 20: taken from both sides
 * by distance, the earlier line first on a tie, and listed in line order; with how many there are.
 */
function nearest(matches: readonly number[], number: number): { listed: number[]; total: number } {
  let right = 0;
  while (right < matches.length && matches[right]! < number) right += 1;
  let left = right - 1;
  const listed: number[] = [];
  while (listed.length < REPORT_MATCHES && (left >= 0 || right < matches.length)) {
    const before = left >= 0 ? number - matches[left]! : Infinity;
    const after = right < matches.length ? matches[right]! - number : Infinity;
    if (before <= after) listed.push(matches[left--]!);
    else listed.push(matches[right++]!);
  }
  return { listed: listed.sort((a, b) => a - b), total: matches.length };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function codeReply(code: string, reason: string): string {
  return `${code}: ${reason}\nNothing was changed.`;
}

/** A refusal: its code, its reason, and that nothing was changed. */
function refused(code: string, reason: string): ToolReply {
  return { success: false, content: [{ type: 'text', text: codeReply(code, reason) }] };
}
