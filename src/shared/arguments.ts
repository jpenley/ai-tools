// What the studio's built-in tools take as a list, a flag or an offset, as some models send them: local
// models behind a tool-call parser (Qwen on vLLM among them) often send a nested array as its JSON
// text and a boolean or number as its text. The studio reads that text back into the value rather
// than refusing a call the model meant well.

/** `raw` as the model meant it: a list given as JSON text is read as that list; anything else as it is. */
export function listArgument(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text.startsWith('[')) return raw;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : raw;
  } catch {
    return raw;
  }
}

/** A true-or-false argument such as `hidden`: absent (false), a boolean, or its text, as some models send booleans. Null when it is neither. */
export function flagArgument(raw: unknown): boolean | null {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/** `offset`: absent (0), or a whole number from 0, given as a number or as its digits. Null when it is neither. */
export function offsetArgument(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  const value = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
