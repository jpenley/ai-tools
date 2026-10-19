// The studio's folder lister, `list_dir` (FILES-find, studio-files.md): one folder of the task
// worktree or of an engine link, one entry per line, folders first, then files, each compared
// case-insensitively with ties broken ordinally, paged at 200 entries with `next: offset=K`. Every
// reading role has it, by the same name in every harness.
//
// A listing reveals names, so it follows the read rule's spirit for what it prints: `.git` never
// appears, a credential-shaped name is shown only as refused, with no size, and `*.ff-tmp` (the
// writer's temporary files) is hidden. Dot entries appear only with `hidden`. Links are never
// followed: an engine link is marked read-only, every other link or junction is shown as a link,
// and neither shows where it points. The folder itself is judged by the shared path layer
// (files.ts), so a listing inside an engine link never reaches its dot folders' contents.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayTool, ToolReply } from '../contract.ts';
import { isCredentialFileName } from '../policy/sensitive-paths.ts';
import type { BuiltInTool } from '../contract.ts';
import { flagArgument, offsetArgument } from '../shared/arguments.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';
import { CONTROL, startCall, type FileCall, type FileSession } from './files.ts';

const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** The most entries one reply lists. */
export const LIST_PAGE = 200;

/** The folder lister as the gateway offers it. */
export const LIST_DIR_TOOL: GatewayTool = {
  name: 'list_dir',
  description:
    'List one folder of your task worktree, or under engine/<repo> (read-only): folders first, then files, by name ignoring case. ' +
    'One entry per line: "[dir]  src/", "[file] src/a.ts  (12.3 KB)", "[engine, read-only] engine/world/" for an engine repo, "[link] <path>" for any other link (never followed), ' +
    'and "<path>  refused: credential file" for a name the file tools refuse to read. ' +
    'Names starting with a dot are shown only with hidden: true; .git never is. ' +
    `A reply lists at most ${LIST_PAGE} entries; when there are more, its last line is "next: offset=K": send the same call with that offset to see the rest. ` +
    'Paths are relative to the worktree, with / or \\; "." is the worktree itself. A folder the studio wrote for this session outside it, such as a skill\'s folder or a long change\'s, is listed by its absolute path, read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      full: fullOutputProperty,
      path: { type: 'string', description: 'The folder, relative to your worktree, such as src or engine/world; "." for the worktree itself.' },
      hidden: { type: 'boolean', description: 'Also list names that start with a dot; false by default.' },
      offset: { type: 'integer', minimum: 0, description: 'How many entries to skip, from a previous reply\'s "next: offset=K"; 0 by default.' },
    },
    required: ['path'],
  },
};

/** One entry of a listing, before paging. */
interface Entry {
  readonly name: string;
  /** Folders and engine links sort before files and other links. */
  readonly folder: boolean;
  readonly line: string;
}

/** The folder lister for one session: its worktree, project and role, bound when the session starts. */
export function listDirTool(session: FileSession): BuiltInTool {
  return {
    tool: LIST_DIR_TOOL,
    async call(input): Promise<ToolReply> {
      const full = fullOutputArgument(input['full']);
      if (full === null) return answer(false, 'full must be true or false.');
      const hidden = flagArgument(input['hidden']);
      if (hidden === null) return answer(false, 'hidden must be true or false.');
      const offset = offsetArgument(input['offset']);
      if (offset === null) return answer(false, 'offset must be a whole number from 0.');
      const call = startCall(session);
      const folder = call.judge(input['path'], 'read');
      if (!folder.ok) return answer(false, folder.reason);
      if (folder.kind === 'missing') return answer(false, `${folder.canonical} not found.`);
      if (folder.kind === 'file') return answer(false, `${folder.canonical} is a file, not a folder; view_file shows it.`);
      let names: string[];
      try {
        names = readdirSync(folder.absolute);
      } catch (error) {
        return answer(false, `${folder.canonical} could not be listed (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
      }
      // The folder was judged before it was read: if it became a link or junction in between, the
      // names may be another folder's, so the listing is refused rather than shown.
      // shortcut: a folder above it swapped and swapped back around the read is not caught, as in
      // readText; revisit when a brain with a gateway can make links without also having a shell.
      if (!stillAFolder(folder.absolute)) return answer(false, `${folder.canonical} changed while it was being listed; try again.`);
      const entries: Entry[] = [];
      for (const name of names) {
        const entry = entryOf(call, folder.canonical, folder.requested ?? folder.absolute, name, hidden);
        if (entry !== null) entries.push(entry);
      }
      entries.sort(listOrder);
      return answer(true, pageOf(folder.canonical, entries, offset, hidden, full));
    },
  };
}

/** How `name` in the folder prints, or null when the listing leaves it out. */
function entryOf(call: FileCall, parent: string, parentAbsolute: string, name: string, hidden: boolean): Entry | null {
  const lower = name.toLowerCase();
  if (lower === '.git' || lower.endsWith('.ff-tmp')) return null;
  if (name.startsWith('.') && !hidden) return null;
  // A name holding a control character could print as another name; the path layer refuses it as an
  // argument anyway, so the listing shows it with each such character as ?, as a refusal does.
  const path = (parent === '.' ? name : `${parent}/${name}`).replace(CONTROL_ALL, '?');
  if (!call.judge(join(parentAbsolute, name), 'read').ok) return null;
  let stats;
  try {
    stats = lstatSync(join(parentAbsolute, name));
  } catch {
    // Gone since the folder was read: nothing to list.
    return null;
  }
  // The same names the path layer refuses to read as credentials; the parent already passed it. Checked
  // before the link test, so a link named .env shows as a refused credential file too.
  if (isCredentialFileName(name) || lower === '.secrets' || lower === '.ssh') return { name, folder: stats.isDirectory(), line: `${path}  refused: credential file` };
  if (stats.isSymbolicLink()) {
    // Only the path layer knows which links are engine links: the very link LINK kept as a root.
    const judged = call.judge(path, 'read');
    if (judged.ok && judged.engine !== null && judged.canonical === `engine/${judged.engine}`) {
      return { name, folder: true, line: `[engine, read-only] ${judged.canonical}/` };
    }
    return { name, folder: false, line: `[link] ${path}` };
  }
  const folder = stats.isDirectory();
  return folder ? { name, folder, line: `[dir]  ${path}/` } : { name, folder, line: `[file] ${path}  (${sizeOf(stats.size)})` };
}

/** Whether `absolute` is still a real folder, not a link or junction, after its names were read. */
function stillAFolder(absolute: string): boolean {
  try {
    const stats = lstatSync(absolute);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Folders first, then files; each by name ignoring case, then by the name's own code units. */
function listOrder(a: Entry, b: Entry): number {
  if (a.folder !== b.folder) return a.folder ? -1 : 1;
  return ordinal(a.name.toLowerCase(), b.name.toLowerCase()) || ordinal(a.name, b.name);
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The page of `entries` from `offset`, with `next: offset=K` when more follow. */
function pageOf(canonical: string, entries: readonly Entry[], offset: number, hidden: boolean, full: boolean): string {
  if (entries.length === 0) return `${canonical} has nothing to list${hidden ? '' : ' (names starting with a dot are hidden; hidden: true shows them)'}.`;
  if (offset >= entries.length) return `${canonical} has ${entries.length} entries; nothing from offset=${offset}.`;
  const next = full ? entries.length : offset + LIST_PAGE;
  const page = entries.slice(offset, next).map((entry) => entry.line);
  if (next < entries.length) page.push(`next: offset=${next}`);
  return page.join('\n');
}

/** A size as a listing prints it: bytes below 1 KB, then KB, MB or GB with one decimal (1 KB = 1,024 bytes). */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}
