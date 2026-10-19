/** Selected by the owner at startup; tool arguments cannot change this ceiling. */
export type ToolAccess = 'deny' | 'read-only' | 'full' | 'super';

export function toolAccess(value: unknown): ToolAccess {
  if (value !== 'deny' && value !== 'read-only' && value !== 'full' && value !== 'super') throw new Error('Access must be deny, read-only, full or super.');
  return value;
}
export function writableAccess(access: ToolAccess): boolean { return access === 'full' || access === 'super'; }
