import { parseText, type FileSession } from './files.ts';
import { checked, fail, integer, MAX_REPLY_BYTES, readBytes, ReadBudgetExceeded, tool } from './core/filesystem.ts';
import { viewOf } from './view-file.ts';
import { fullOutputArgument, fullOutputProperty } from '../shared/output.ts';

export function viewFilesTool(session: FileSession) {
  return tool('view_files', 'Read 1-8 UTF-8 text files with hashes and line anchors. Default 40 lines per file (max_lines up to 100), 16 MiB total input and 50 KiB output. Paginate remaining paths with the returned offset; continue individual files with view_file. Per-file failures and omissions are explicit. full:true returns all selected lines without output cuts; input limits still apply.', {
    paths: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
    max_lines: { type: 'integer', minimum: 1, maximum: 100 },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based path index to start at; default 0. Use the returned next: offset=K with the same paths.' },
    full: fullOutputProperty,
  }, ['paths'], input => {
    const full = fullOutputArgument(input['full']);
    if (full === null) fail('full must be true or false.');
    if (!Array.isArray(input['paths']) || input['paths'].length < 1 || input['paths'].length > 8 || input['paths'].some(path => typeof path !== 'string')) fail('paths must contain 1-8 file paths.');
    const paths = input['paths'] as string[];
    const lines = integer(input['max_lines'], 40, 1, 100, 'max_lines');
    const offset = integer(input['offset'], 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    if (offset >= paths.length) return `Nothing from offset=${offset}; ${paths.length} paths requested.`;
    const sections: string[] = [];
    let inputBytes = 0;
    let outputBytes = 0;
    for (let index = offset; index < paths.length; index++) {
      let section: string;
      try {
        const path = checked(session, paths[index], 'read');
        const bytes = readBytes(path, 16 * 1024 * 1024 - inputBytes).bytes;
        inputBytes += bytes.length;
        const file = parseText(bytes);
        if (typeof file === 'string') fail(`${path.canonical} is binary or not UTF-8 text.`);
        // Leave room for continuation/omission metadata so even the first file makes progress.
        section = viewOf(path.canonical, file, 1, full ? null : lines, full, 48 * 1024);
        if (!full && file.lines.length > lines && !section.includes('\nnext: start_line=')) section += `\ncontinue: start_line=${lines + 1}`;
      } catch (error) {
        if (error instanceof ReadBudgetExceeded && inputBytes > 0 && error.size <= 16n * 1024n * 1024n) {
          sections.push(`omitted: file indexes ${index} through ${paths.length - 1}; aggregate input budget reached.\nnext: offset=${index}`);
          break;
        }
        section = `file_index=${index} ERROR: ${error instanceof Error ? error.message : 'Read failed.'}`;
      }
      if (!full && outputBytes + Buffer.byteLength(section) > MAX_REPLY_BYTES - 512) {
        sections.push(`omitted: file indexes ${index} through ${paths.length - 1}; output budget reached.\nnext: offset=${index}`);
        break;
      }
      sections.push(section);
      outputBytes += Buffer.byteLength(section) + 2;
      if (inputBytes >= 16 * 1024 * 1024 && index + 1 < paths.length) {
        sections.push(`omitted: remaining file indexes after ${index}; aggregate input budget reached.\nnext: offset=${index + 1}`);
        break;
      }
    }
    return sections.join('\n\n');
  });
}
