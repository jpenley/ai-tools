/** Presentation override only: callers cannot use it to relax access or collection limits. */
export const fullOutputProperty = {
  type: 'boolean',
  default: false,
  description: 'Return all remaining selected results without reply-size or line-length cuts, for codemode or other programmatic filtering. Default false. Permission checks, input-size limits, timeouts and collection/resource safeguards still apply. Use individual MCP requests, not JSON-RPC batches. The host may impose its own output limit.',
} as const;

export function fullOutputArgument(raw: unknown): boolean | null {
  return raw === undefined ? false : typeof raw === 'boolean' ? raw : null;
}
