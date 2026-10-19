// The studio's whole-file writer, `write_file` (FILES-write, studio-files.md): creates a file, with
// any missing parent folders, or replaces one the brain has seen. Replacing needs `base`, the file
// hash view_file showed, so a brain never overwrites a file that changed since it looked. Only
// implementers have it, by the same name in every harness.
//
// Each call judges its path with the shared file module's path layer (files.ts) for writing, with the
// session's roots worked out at the call's start, then writes through the module's atomic writer under
// the file's lock, which every session's writing tools share. Replacing an `lf` or `crlf` file gives the
// content the file's endings and BOM state (FILES-endings), so a whole-file write makes no noise in a
// diff; a new file, or a `mixed` or `none` one, is written as given.
import { lstatSync } from 'node:fs';
import type { GatewayTool, ToolReply } from '../contract.ts';
import type { BuiltInTool } from '../contract.ts';
import { MAX_FILE_BYTES, readText, startCall, withFileLock, writeAtomic, type FileSession, type TextFile, type WriterFaults } from './files.ts';

/** The whole-file writer as the gateway offers it. */
export const WRITE_FILE_TOOL: GatewayTool = {
  name: 'write_file',
  description:
    'Create a text file in your task worktree, or replace one. Missing parent folders are made. ' +
    'To replace a file that exists, pass base: the file=<hash> from your latest view_file of it; if the file changed since, nothing is written and the reply starts STALE, so view it again. ' +
    'The reply is "created <path>  file=<hash>  lines=<n>" or "replaced <path>  file=<hash>  lines=<n>". ' +
    'Replacing a file whose lines all end in LF, or all in CRLF, gives your content that ending and keeps the file\'s byte-order mark or its lack; a new file is written exactly as given. ' +
    'To change part of a file, prefer edit_file. Paths are relative to the worktree, with / or \\. ' +
    'Content must be UTF-8 text with no NUL, at most 16 MB. Engine repos (engine/<repo>) are read-only; .git, credential files, hard-linked files and links are refused.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file, relative to your worktree, such as src/new-module.ts.' },
      content: { type: 'string', description: 'The whole new content of the file.' },
      base: { type: 'string', description: 'Required to replace a file that exists: the file=<hash> from your latest view_file of it. Leave it out to create a new file.' },
      eol: { type: 'string', enum: ['preserve', 'lf', 'crlf'], description: 'Line endings; preserve is the default.' },
      bom: { type: 'boolean', description: 'Explicitly add/remove the UTF-8 BOM; absent preserves existing behavior.' },
      final_newline: { type: 'boolean', description: 'Explicitly add/remove the final newline; absent uses the supplied content.' },
    },
    required: ['path', 'content'],
  },
};

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The whole-file writer for one session, bound when the session starts; `faults` only in tests. */
export function writeFileTool(session: FileSession, faults: WriterFaults = {}): BuiltInTool {
  return {
    tool: WRITE_FILE_TOOL,
    async call(input): Promise<ToolReply> {
      const content = input['content'];
      if (typeof content !== 'string') return refused('BAD_ARGS', 'content must be text.');
      if (content.includes('\u0000')) return refused('BAD_ARGS', "content holds a NUL character; the studio's tools write UTF-8 text only.");
      if (!content.isWellFormed()) return refused('BAD_ARGS', "content holds a lone surrogate, which is not UTF-8; the studio's tools write UTF-8 text only.");
      const eol = input['eol'] ?? 'preserve';
      if (!['preserve', 'lf', 'crlf'].includes(eol as string)) return refused('BAD_ARGS', 'eol must be preserve, lf or crlf.');
      if (['bom', 'final_newline'].some(key => input[key] !== undefined && typeof input[key] !== 'boolean')) return refused('BAD_ARGS', 'bom and final_newline must be booleans.');
      const rawBase = input['base'];
      if (rawBase !== undefined && rawBase !== null && typeof rawBase !== 'string') return refused('BAD_ARGS', 'base must be text: the file=<hash> from view_file.');
      const base = typeof rawBase === 'string' && rawBase.trim() !== '' ? rawBase.trim().toLowerCase() : null;
      const path = startCall(session).judge(input['path'], 'write');
      if (!path.ok) return refused('PATH', path.reason);
      if (path.kind === 'folder') return refused('PATH', `${path.canonical} is a folder; write_file writes files.`);
      // The lock is taken before the first await, so writes sent together land in the order sent.
      return withFileLock(path.absolute, async () => {
        // What is there is read again under the lock: the path layer's look came before it.
        let current: TextFile | null = null;
        if (existsNoFollow(path.absolute)) {
          const read = readText({ ...path, kind: 'file' });
          if (!read.ok) return refused('UNREADABLE', read.reason);
          current = read.file;
        }
        if (current === null && base !== null) return refused('STALE', `${path.canonical} does not exist, so it is not ${base}.`);
        if (current !== null && base === null) {
          return refused('STALE', `${path.canonical} already exists; replacing it needs base, the file=<hash> from your latest view_file of it.`);
        }
        if (current !== null && current.hash !== base) return refused('STALE', `${path.canonical} is ${current.hash}, not ${base}.`);
        const bytes = encoded(content, current, eol as string, input['bom'] as boolean | undefined, input['final_newline'] as boolean | undefined);
        if (bytes.length > MAX_FILE_BYTES) {
          return refused('BAD_ARGS', `content is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_FILE_BYTES / (1024 * 1024)} MB the studio's tools write.`);
        }
        const written = await writeAtomic(path, bytes, current?.hash ?? null, faults);
        if (!written.ok) return refused(written.code, written.reason);
        return answer(true, `${current === null ? 'created' : 'replaced'} ${path.canonical}  file=${written.file.hash}  lines=${written.file.lines.length}`);
      });
    },
  };
}

/**
 * The bytes to write: `content` as given for a new file or a `mixed` or `none` one; for an `lf` or
 * `crlf` file, with every line ending turned into the file's (a lone CR is no ending and stays) and
 * the file's BOM state kept.
 */
function encoded(content: string, current: TextFile | null, eol: string, bom: boolean | undefined, finalNewline: boolean | undefined): Buffer {
  const selected = eol === 'preserve' ? current?.eol : eol;
  const normalize = selected === 'lf' || selected === 'crlf';
  const marked = bom ?? (normalize && current !== null ? current.bom : content.startsWith('\ufeff'));
  let text = content.startsWith('\ufeff') ? content.slice(1) : content;
  if (normalize) {
    text = text.replaceAll('\r\n', '\n');
    if (selected === 'crlf') text = text.replaceAll('\n', '\r\n');
  }
  if (finalNewline === false) text = text.replace(/(?:\r?\n)+$/, '');
  if (finalNewline === true && !text.endsWith('\n')) text += selected === 'crlf' ? '\r\n' : '\n';
  const bytes = Buffer.from(text, 'utf8');
  return marked ? Buffer.concat([BOM, bytes]) : bytes;
}

/** Whether anything is at `absolute`, a link included, without following it. */
function existsNoFollow(absolute: string): boolean {
  try {
    lstatSync(absolute);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** A refusal: its code, its reason, and that nothing was changed. */
function refused(code: string, reason: string): ToolReply {
  return answer(false, `${code}: ${reason}\nNothing was changed.`);
}

function answer(success: boolean, text: string): ToolReply {
  return { success, content: [{ type: 'text', text }] };
}
