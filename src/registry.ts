import type { BuiltInTool, GatewayCall, ToolCallContext, ToolReply } from './contract.ts';

/** Private routes are fixed at startup; callers cannot add a tool or change access. */
export function createToolRegistry(builtIns: readonly BuiltInTool[]) {
  const routes = new Map<string, BuiltInTool>();
  for (const item of builtIns) {
    if (routes.has(item.tool.name)) throw new Error('Duplicate tool: ' + item.tool.name);
    routes.set(item.tool.name, item);
  }
  const tools = Object.freeze(builtIns.map(item => structuredClone(item.tool)));
  const denied = (message: string): ToolReply => ({ success: false, content: [{ type: 'text', text: message }] });
  let open = true;
  return {
    tools,
    async call(request: GatewayCall, context?: ToolCallContext): Promise<ToolReply> {
      if (!open) return denied('The server has closed.');
      const route = routes.get(request.tool);
      if (route === undefined) return denied('No tool ' + request.tool + ' is offered by this server.');
      const args = request.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return denied('Tool arguments must be a JSON object.');
      try { return await route.call(args as Readonly<Record<string, unknown>>, context); }
      catch (error) { return denied(error instanceof Error ? error.message : String(error)); }
    },
    async close(): Promise<void> { open = false; await Promise.all(builtIns.map(item => item.close?.())); },
  };
}
