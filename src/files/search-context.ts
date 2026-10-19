import { anchorOf, readText } from './files.ts';
import { cut, VIEW_MAX_BYTES } from './view-file.ts';
import type { Match } from './search-files.ts';

type RecordLine = { readonly printed: string; readonly match: boolean };
type Group = { readonly header: string; readonly records: Map<number, RecordLine> };
const OMITTED = '[context omitted: reply limit; use view_file for surrounding lines]';
const bytes = (text: string): number => Buffer.byteLength(text);

/** Offset counts matches, never context. A window commits whole or waits for the next reply. */
export function contextSearchReply(matches: readonly Match[], named: readonly string[], offset: number, context: number, maxRead: number, full: boolean, pageSize: number): string {
  let budget = VIEW_MAX_BYTES - bytes(`\nnext: offset=${matches.length}\n${OMITTED}`) - named.reduce((sum, line) => sum + bytes(line) + 1, 0);
  const groups: Group[] = [];
  let file: string | null = null;
  let group: Group | undefined;
  let text: readonly string[] | null = null;
  let read = 0;
  let index = offset;
  let omitted = false;
  while (index < matches.length && (full || index - offset < pageSize)) {
    const match = matches[index]!;
    let headerCost = 0;
    const newFile = match.path.canonical !== file;
    if (newFile) {
      if (index > offset && read >= maxRead) break;
      const opened = readText(match.path);
      text = opened.ok ? opened.file.lines.map(line => line.text) : null;
      if (opened.ok) read += opened.file.bytes.length;
      group = { header: opened.ok ? match.path.canonical : opened.reason, records: new Map() };
      headerCost = bytes(group.header) + 1;
    }
    const current = group!;
    let changes = new Map<number, RecordLine>();
    let cost = headerCost;
    if (text !== null) {
      const start = Math.max(1, match.line - context);
      const end = Math.min(text.length, match.line + context);
      for (let line = start; line <= end; line++) {
        const previous = current.records.get(line);
        const isMatch = line === match.line || previous?.match === true;
        if (previous !== undefined && previous.match === isMatch) continue;
        const value = text[line - 1]!;
        const printed = `${isMatch ? '' : 'context '}${anchorOf(line, value)}|${cut(value, full)}`;
        changes.set(line, { printed, match: isMatch });
        cost += bytes(printed) + 1 - (previous === undefined ? 0 : bytes(previous.printed) + 1);
      }
    }
    if (!full && cost > budget) {
      if (index > offset) break;
      // Optional context cannot prevent progress when a single window exceeds the reply cap.
      changes = new Map();
      cost = headerCost;
      const value = text?.[match.line - 1];
      if (value !== undefined) {
        const printed = `${anchorOf(match.line, value)}|${cut(value)}`;
        changes.set(match.line, { printed, match: true });
        cost += bytes(printed) + 1;
      }
      omitted = true;
    }
    if (newFile) { groups.push(current); file = match.path.canonical; }
    for (const [line, record] of changes) current.records.set(line, record);
    budget -= cost;
    index++;
    if (omitted) break;
  }
  const result: string[] = [];
  for (const item of groups) {
    result.push(item.header);
    for (const [, record] of [...item.records].sort(([a], [b]) => a - b)) result.push(record.printed);
  }
  if (omitted) result.push(OMITTED);
  result.push(...named);
  if (index < matches.length) result.push(`next: offset=${index}`);
  return result.join('\n');
}
