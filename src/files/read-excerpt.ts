import { TextDecoder } from 'node:util';
import type { FileSession } from './files.ts';
import { checked, fail, integer, pathProperty, readBytes, stamp, tool, version } from './core/filesystem.ts';

export function readExcerptTool(session: FileSession) {
  return tool('read_excerpt', 'Read a bounded UTF-8 byte window from a regular file, including files over 16 MiB. This is NOT an edit-ready full-file read: no edit hash/line anchors are supplied. UTF-8 boundaries are adjusted and actual offsets reported; binary/non-UTF-8 windows are refused. At most 32 KiB per call.', {
    path: pathProperty, byte_offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 4, maximum: 32768 },
  }, ['path'], input => {
    const path = checked(session, input['path'], 'read');
    const offset = integer(input['byte_offset'], 0, 0, Number.MAX_SAFE_INTEGER - 32768, 'byte_offset');
    const limit = integer(input['max_bytes'], 8192, 4, 32768, 'max_bytes');
    const read = readBytes(path, limit, offset, limit);
    let start = 0;
    while (offset > 0 && start < Math.min(3, read.bytes.length) && (read.bytes[start]! & 0xc0) === 0x80) start++;
    let text: string;
    const atEnd = BigInt(offset + read.bytes.length) >= read.stats.size;
    try {
      // Stream mode buffers only an incomplete final code point; malformed bytes still fail.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes.subarray(start), { stream: !atEnd });
    } catch { fail('The requested window is not valid UTF-8.'); }
    if (text.includes('\0')) fail('The requested window is binary (NUL byte).');
    const end = start + Buffer.byteLength(text, 'utf8');
    if (end <= start && read.bytes.length > 0) fail('No complete UTF-8 characters in this window; increase max_bytes.');
    return `${path.canonical}  edit_ready=no  version=${version(stamp(read.stats))}\nbyte_offset=${offset + start} next_byte_offset=${offset + end} size=${read.stats.size} eof=${BigInt(offset + end) >= read.stats.size}\n${text}`;
  });
}
