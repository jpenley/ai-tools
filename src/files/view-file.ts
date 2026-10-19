// The studio's file viewer, `view_file` (FILES-view, studio-files.md): a file's lines, each with its
// anchor, `N:hhhhhh`, its number and a hash of its text, under a header holding the whole file's hash.
// An edit names lines by those anchors and the file by that hash, so it can prove the lines it changes
// are the lines the brain saw. Every reading role has it, by the same name in every harness.
//
// Each call judges its path with the shared file module's path layer (files.ts), with the session's
// roots worked out at the call's start, and reads the text with its reader. A reply holds at most 400
// lines and 50 KB and then says where to go on; a very long line is cut, its anchor still covering the
// whole line.
import type { GatewayTool, ToolReply } from '../contract.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';
import type { BuiltInTool } from '../contract.ts';
import { anchorOf, readText, startCall, type FileSession, type TextFile } from './files.ts';

/** The most lines one reply shows. */
export const VIEW_MAX_LINES = 400;
/** The most UTF-8 bytes one reply holds, unless its one line alone passes it. */
export const VIEW_MAX_BYTES = 50 * 1024;
/** The most characters of one line a reply shows; the rest is named, not shown. */
export const VIEW_MAX_LINE_CHARACTERS = 2000;

/** The file viewer as the gateway offers it. */
export const VIEW_FILE_TOOL: GatewayTool = {
  name: 'view_file',
  description:
    'Show a text file in your task worktree, or under engine/<repo> (read-only), with each line\'s anchor. ' +
    'The reply starts with a header, "<path>  file=<hash>  lines=<n>  eol=lf|crlf|mixed|none  bom=yes|no  final-newline=yes|no", then "showing a-b of n", then one line per file line as N:hhhhhh|text: ' +
    'N is the line number and hhhhhh a hash of that line\'s text, so the anchor N:hhhhhh names exactly the line you saw. ' +
    `A reply shows at most ${VIEW_MAX_LINES} lines or ${VIEW_MAX_BYTES / 1024} KB; when it stops early its last line is "next: start_line=K": call again with that start_line to see more. ` +
    `A line longer than ${VIEW_MAX_LINE_CHARACTERS} characters is cut, saying how many more it has; its anchor still covers the whole line. ` +
    'Paths are relative to the worktree, with / or \\; a folder the studio wrote for this session outside it, such as a skill\'s folder or a long change\'s, is read by its absolute path. Binary files, files over 16 MB, .git, credential files and links other than engine/<repo> are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      full: fullOutputProperty,
      path: { type: 'string', description: 'The file, relative to your worktree, such as src/main.ts or engine/world/README.md.' },
      start_line: { type: 'integer', minimum: 1, description: 'The first line to show; 1 by default.' },
      end_line: { type: 'integer', minimum: 1, description: 'The last line to show; the end of the file by default, within the reply\'s limits.' },
      tail_lines: { type: 'integer', minimum: 1, maximum: VIEW_MAX_LINES, description: 'Show the last 1-400 lines instead of a start/end range. Retains the 16 MiB full-file limit and edit-ready hashes.' },
    },
    required: ['path'],
  },
};

/** The file viewer for one session: its worktree, project and role, bound when the session starts. */
export function viewFileTool(session: FileSession): BuiltInTool {
  return {
    tool: VIEW_FILE_TOOL,
    async call(input): Promise<ToolReply> {
      const full = fullOutputArgument(input['full']);
      if (full === null) return answer(false, 'full must be true or false.');
      const tail = lineArgument(input['tail_lines'], 'tail_lines');
      if (typeof tail === 'string') return answer(false, tail);
      if (tail !== null && tail > VIEW_MAX_LINES) return answer(false, `tail_lines must be at most ${VIEW_MAX_LINES}.`);
      if (tail !== null && (input['start_line'] !== undefined || input['end_line'] !== undefined)) return answer(false, 'tail_lines cannot be combined with start_line/end_line.');
      const start = lineArgument(input['start_line'], 'start_line');
      if (typeof start === 'string') return answer(false, start);
      const end = lineArgument(input['end_line'], 'end_line');
      if (typeof end === 'string') return answer(false, end);
      if (start !== null && end !== null && end < start) return answer(false, `end_line (${end}) is before start_line (${start}).`);
      const path = startCall(session).judge(input['path'], 'read');
      if (!path.ok) return answer(false, path.reason);
      const read = readText(path);
      if (!read.ok) return answer(false, read.reason);
      return answer(true, viewOf(path.canonical, read.file, tail === null ? (start ?? 1) : Math.max(1, read.file.lines.length - tail + 1), end, full));
    },
  };
}

/**
 * The reply for `file` from line `start` to `end` (the last line when null): the header, the
 * `showing` line, then the lines, stopping at 400 lines or 50 KB of reply with a `next:` line.
 */
export function viewOf(canonical: string, file: TextFile, start: number, end: number | null, full = false, maxBytes = VIEW_MAX_BYTES): string {
  const n = file.lines.length;
  const header = `${canonical}  file=${file.hash}  lines=${n}  eol=${file.eol}  bom=${file.bom ? 'yes' : 'no'}  final-newline=${file.finalNewline ? 'yes' : 'no'}`;
  if (start > n) return `${header}\nshowing 0-0 of ${n}`;
  const last = Math.min(end ?? n, n);
  // The showing and next lines are reserved at their longest, so the reply stays under the cap
  // whichever line it stops at.
  let budget = maxBytes - bytes(`${header}\nshowing ${start}-${last} of ${n}\n`) - bytes(`\nnext: start_line=${last}`);
  const shown: string[] = [];
  let line = start;
  while (line <= last && (full || shown.length < VIEW_MAX_LINES)) {
    const text = file.lines[line - 1]!.text;
    const printed = `${anchorOf(line, text)}|${cut(text, full)}`;
    const cost = bytes(printed) + 1;
    if (!full && shown.length > 0 && cost > budget) break;
    shown.push(printed);
    budget -= cost;
    line += 1;
  }
  const lastShown = line - 1;
  const reply = [header, `showing ${start}-${lastShown} of ${n}`, ...shown];
  if (lastShown < last) reply.push(`next: start_line=${line}`);
  return reply.join('\n');
}

/** A line as a reply shows it: past 2,000 characters (code points, so no pair is split), cut and the rest counted. search_files cuts its lines the same way. */
export function cut(text: string, full = false): string {
  if (full || text.length <= VIEW_MAX_LINE_CHARACTERS) return text;
  const characters = Array.from(text);
  if (characters.length <= VIEW_MAX_LINE_CHARACTERS) return text;
  return `${characters.slice(0, VIEW_MAX_LINE_CHARACTERS).join('')} …[cut: ${characters.length - VIEW_MAX_LINE_CHARACTERS} more characters]`;
}

/**
 * A line-number argument: absent, or a whole number from 1, given as a number or as its digits (some
 * models send numbers as text). Returns the number, null when absent, or why it is refused.
 */
function lineArgument(raw: unknown, name: string): number | null | string {
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return `${name} must be a whole number from 1.`;
  return value;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}
