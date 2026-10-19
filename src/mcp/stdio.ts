import { RequestQueue } from './request-queue.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { DirectoryApprovalRequest, GatewayTool, ToolCallContext, ToolReply } from '../contract.ts';

interface McpServer {
  readonly name: string;
  readonly instructions?: string;
  tools(): Promise<readonly GatewayTool[]>;
  call(name: string, args: unknown, context?: ToolCallContext): Promise<ToolReply>;
  close(): void;
  /** Immediately revoke ephemeral capabilities on input disconnect. */
  disconnect?(): void;
}

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE = 32 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Shared MCP framing; each server supplies its own fixed inventory and call authorization. */
export function serveMcp(server: McpServer): void {
  const result = (id: string | number | null, value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const failure = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const queue = new RequestQueue();
  const pending = new Map<string | number, AbortController>();
  let sending = Promise.resolve();
  const send = (value: unknown, commit?: () => void): Promise<void> => {
    const sent = sending.then(async () => {
      const line = `${JSON.stringify(value)}\n`;
      commit?.();
      if (!process.stdout.write(line)) {
        process.stdin.pause();
        await once(process.stdout, 'drain');
        if (!ended) process.stdin.resume();
      }
    });
    sending = sent.catch(() => {});
    return sent;
  };
  let initialized = false;
  let formElicitation = false;
  const approvals = new Map<string, { finish(approved: boolean): void }>();
  const requestApproval = (request: DirectoryApprovalRequest, signal: AbortSignal): Promise<boolean> => {
    if (!formElicitation || signal.aborted || ended || approvals.size >= 4) return Promise.resolve(false);
    const id = `ai-tools-approval-${randomUUID()}`;
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return; settled = true;
        approvals.delete(id); clearTimeout(timer); signal.removeEventListener('abort', cancel);
        resolve(approved && !signal.aborted && !ended);
      };
      const cancel = () => { finish(false); send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Permission approval cancelled or expired.' } }); };
      const timer = setTimeout(cancel, 120_000);
      approvals.set(id, { finish }); signal.addEventListener('abort', cancel, { once: true });
      send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
        message: `Approve directory access for this MCP connection only?\nServer/project root: ${request.root}\nDirectory: ${request.directory}\nRequested access: ${request.access}\nAgent-provided reason (untrusted): ${JSON.stringify(request.reason)}\nThis grant expires on disconnect/revoke. Settings restrictions, protected paths, server ceilings and link read-only restrictions remain enforced.`,
        requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Allow the directory access described above for this session?', default: false } }, required: ['approve'], additionalProperties: false },
      } });
    });
  };
  const cancelPending = () => { for (const approval of approvals.values()) approval.finish(false); };
  async function handle(message: unknown): Promise<unknown> {
    if (!object(message)) return failure(null, -32600, 'Invalid Request: not a JSON-RPC message.');
    const { id, method, params } = message;
    const known = typeof id === 'string' || typeof id === 'number';
    if (typeof method !== 'string') {
      if ('result' in message || 'error' in message) {
        const approval = typeof id === 'string' ? approvals.get(id) : undefined;
        if (approval) {
          const result = message['result'];
          const content = object(result) ? result['content'] : undefined;
          approval.finish(message['jsonrpc'] === '2.0' && !('error' in message) && object(result) && result['action'] === 'accept' && object(content) && Object.keys(content).length === 1 && content['approve'] === true);
        }
        return null;
      }
      return failure(known ? id : null, -32600, 'Invalid Request: it names no method.');
    }
    if (id === undefined) {
      if (method === 'notifications/cancelled' && object(params) && (typeof params['requestId'] === 'string' || typeof params['requestId'] === 'number')) pending.get(params['requestId'])?.abort();
      return null;
    }
    if (!known) return failure(null, -32600, 'Invalid Request: its id must be a string or a number.');
    if (message['jsonrpc'] !== '2.0') return failure(id, -32600, 'Invalid Request: it is not JSON-RPC 2.0.');
    switch (method) {
      case 'initialize': {
        const asked = object(params) && typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
        if (initialized) return failure(id, -32600, 'This connection is already initialized.');
        initialized = true;
        const version = VERSIONS.includes(asked) ? asked : VERSIONS[0];
        const capabilities = object(params) && object(params['capabilities']) ? params['capabilities'] : {};
        const elicitation = capabilities['elicitation'];
        formElicitation = (version === '2025-11-25' || version === '2025-06-18') && object(elicitation) && (Object.keys(elicitation).length === 0 || object(elicitation['form']));
        return result(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: server.name, version: '1.0.0' }, ...(server.instructions === undefined ? {} : { instructions: server.instructions }) });
      }
      case 'ping': return result(id, {});
      case 'tools/list': {
        try {
          const tools = (await server.tools()).map(tool => ({ ...tool, inputSchema: object(tool.inputSchema) ? tool.inputSchema : { type: 'object' } }));
          return result(id, { tools });
        } catch (error) { return failure(id, -32603, messageOf(error)); }
      }
      case 'tools/call': {
        if (!object(params) || typeof params['name'] !== 'string') return failure(id, -32602, 'Invalid params: tools/call needs the name of the tool.');
        if (pending.has(id)) return failure(id, -32600, 'Duplicate active request id.');
        const controller = new AbortController();
        pending.set(id, controller);
        let committed = false;
        try {
          const name = params['name'];
          const context: ToolCallContext = { signal: controller.signal, ...(formElicitation ? { requestDirectoryApproval: (request: DirectoryApprovalRequest) => requestApproval(request, controller.signal) } : {}) };
          const args = params['arguments'] ?? {};
          return await queue.run(async () => {
            const reply = await server.call(name, args, context);
            const response = result(id, { content: reply.content, isError: !reply.success });
            if (!object(args) || args['full'] !== true) return response;
            // Hold the existing active slot until a large reply drains; otherwise queued calls
            // can multiply full results in memory even after stdin has been paused.
            await send(response, () => {
              if (controller.signal.aborted) throw new Error('Request cancelled; an already running operation may have completed. Inspect state before retrying.');
              committed = true;
            });
            return null;
          }, controller.signal);
        } catch (error) {
          if (committed) return null; // A cancellation after delivery cannot retract or duplicate the reply.
          return result(id, { content: [{ type: 'text', text: messageOf(error) }], isError: true });
        }
        finally { pending.delete(id); }
      }
      default: return failure(id, -32601, `Method not found: ${method}`);
    }
  }
  async function received(line: string): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return send(failure(null, -32700, 'Parse error: the line is not JSON.')); }
    if (!Array.isArray(message)) {
      const answer = await handle(message);
      if (answer !== null) await send(answer);
      return;
    }
    if (message.length === 0) return send(failure(null, -32600, 'Invalid Request: an empty batch.'));
    if (message.length > 32) return send(failure(null, -32600, 'Invalid Request: batches are limited to 32 requests.'));
    // A batch must be serialized as one array; reject large-output opt-ins before executing
    // any entry rather than materializing up to 32 full results before applying backpressure.
    if (message.some(entry => object(entry) && entry['method'] === 'tools/call' && object(entry['params']) && object(entry['params']['arguments']) && entry['params']['arguments']['full'] === true)) {
      return send(failure(null, -32600, 'Requests with full:true must be sent individually, not in a JSON-RPC batch. Use bounded pagination for batched calls.'));
    }
    const answers = (await Promise.all(message.map(handle))).filter(answer => answer !== null);
    if (answers.length > 0) await send(answers);
  }
  let input = '';
  let inFlight = 0;
  let ended = false;
  const settle = (): void => { if (ended && inFlight === 0) server.close(); };
  const disconnect = (): void => {
    if (ended) return;
    ended = true; server.disconnect?.(); cancelPending(); settle();
  };
  process.stdout.on('error', () => process.exit(0));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    for (let nl = input.indexOf('\n'); nl >= 0; nl = input.indexOf('\n')) {
      const line = input.slice(0, nl).trim();
      input = input.slice(nl + 1);
      if (line === '') continue;
      if (Buffer.byteLength(line) > MAX_LINE) { send(failure(null, -32700, 'Parse error: a message is over 32 MiB.')); continue; }
      inFlight += 1;
      void received(line).catch(error => send(failure(null, -32603, messageOf(error)))).finally(() => { inFlight -= 1; settle(); });
    }
    if (Buffer.byteLength(input) > MAX_LINE) {
      // Never interpret the suffix of an oversized message as a second request.
      process.stderr.write('MCP input exceeded 32 MiB.\n');
      process.exitCode = 2;
      process.stdin.destroy();
      disconnect();
    }
  });
  process.stdin.on('end', disconnect);
  process.stdin.on('close', disconnect);
  process.stdin.on('error', () => { process.exitCode = 2; disconnect(); });
}
