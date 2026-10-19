import { randomBytes } from 'node:crypto';
import type { ToolReply } from '../contract.ts';

export const GIT_MAX_BYTES = 50 * 1024;
export const GIT_MAX_LINES = 2000;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_RESULTS = 4;
const CACHE_TTL_MS = 5 * 60 * 1000;

type Snapshot = { text: string; success: boolean; bytes: number; expires: number };
const answer = (success: boolean, text: string): ToolReply => ({ success, content: [{ type: 'text', text }] });

/** Per-tool-instance snapshots: reading another page never executes the original command again. */
export class GitOutputPages {
  private readonly snapshots = new Map<string, Snapshot>();
  private bytes = 0;

  present(success: boolean, text: string, full: boolean): ToolReply {
    this.sweep();
    if (full) return answer(success, text);
    const end = pageEnd(text, 0);
    if (end === text.length) return answer(success, text);
    const size = Buffer.byteLength(text);
    if (size > CACHE_MAX_BYTES) return answer(false, 'Output exceeds the pagination snapshot budget. The command has already run; inspect repository state before retrying a mutation.');
    while (this.snapshots.size >= CACHE_MAX_RESULTS || this.bytes + size > CACHE_MAX_BYTES) {
      this.remove(this.snapshots.keys().next().value!);
    }
    const id = randomBytes(16).toString('hex');
    const snapshot = { text, success, bytes: size, expires: Date.now() + CACHE_TTL_MS };
    this.snapshots.set(id, snapshot);
    this.bytes += size;
    return this.page(id, snapshot, 0, false);
  }

  continue(cursor: string, full: boolean): ToolReply {
    this.sweep();
    const match = /^([0-9a-f]{32}):(\d{1,16})$/.exec(cursor);
    const snapshot = match ? this.snapshots.get(match[1]!) : undefined;
    const offset = match ? Number(match[2]) : NaN;
    if (!match || !snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.text.length || isLowSurrogate(snapshot.text.charCodeAt(offset))) {
      return answer(false, 'Invalid or expired output cursor. Cursors belong to this tool connection and expire after 5 minutes or cache eviction. Do not rerun a mutation just to recover its output; inspect repository state first.');
    }
    return this.page(match[1]!, snapshot, offset, full);
  }

  private page(id: string, snapshot: Snapshot, offset: number, full: boolean): ToolReply {
    const end = full ? snapshot.text.length : pageEnd(snapshot.text, offset);
    const body = snapshot.text.slice(offset, end);
    return answer(snapshot.success, end < snapshot.text.length ? `${body}\nnext: cursor=${id}:${end}` : body);
  }

  private remove(id: string): void {
    const snapshot = this.snapshots.get(id)!;
    this.bytes -= snapshot.bytes;
    this.snapshots.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots) if (snapshot.expires <= now) this.remove(id);
  }
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Preserve every code point and newline, splitting oversized lines across pages rather than cutting. */
function pageEnd(text: string, offset: number): number {
  let end = offset, bytes = 0, lines = 0;
  // Reserve room for the continuation marker, keeping the entire reply within its normal byte cap.
  const budget = GIT_MAX_BYTES - 512;
  while (end < text.length && lines < GIT_MAX_LINES) {
    const code = text.codePointAt(end)!;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > budget) break;
    bytes += width;
    end += code > 0xffff ? 2 : 1;
    if (code === 10) lines++;
  }
  return end;
}
