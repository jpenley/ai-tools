import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GatewayTool } from '../src/contract.ts';

export interface MCPCallResult { readonly isError?: boolean; readonly content: readonly { readonly type: string; readonly text?: string }[] }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
type Options = { command: string; args: string[]; cwd: string; capabilities?: Record<string, unknown>; onElicitation?: (params: Record<string, unknown>, id: string) => unknown | Promise<unknown> };

/** Test client crossing only the public stdio MCP interface. */
export class MCPSession {
  server = { name: '' };
  tools: readonly GatewayTool[] = [];
  private id = 0;
  private stderr = '';
  private pending = new Map<number, Pending>();
  private child: ChildProcessWithoutNullStreams;
  private exited: Promise<void>;

  private constructor(options: Options) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd, windowsHide: true, stdio: 'pipe' });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    const fail = (error: Error): void => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
    };
    this.child.once('error', fail);
    this.child.once('exit', code => fail(new Error(`MCP process exited ${code}: ${this.stderr}`)));
    this.child.stdin.on('error', fail);
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      if (message.method === 'elicitation/create' && typeof message.id === 'string') {
        const id = message.id;
        void Promise.resolve().then(() => options.onElicitation?.(message.params ?? {}, id)).then(result => this.respond(id, result ?? { action: 'decline' })).catch(() => this.respond(id, { action: 'cancel' }));
        return;
      }
      if (typeof message.id !== 'number') return;
      const item = this.pending.get(message.id);
      if (item === undefined) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    });
  }

  static async open(options: Options & { transport: 'stdio' }): Promise<MCPSession> {
    const session = new MCPSession(options);
    try {
      const initialized = await session.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: options.capabilities ?? {}, clientInfo: { name: 'ai-tools-tests', version: '1' } }) as { serverInfo: { name: string } };
      session.server = initialized.serverInfo;
      session.tools = (await session.rpc('tools/list', {}) as { tools: GatewayTool[] }).tools;
      return session;
    } catch (error) { await session.close(); throw error; }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out: ${this.stderr}`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  get lastRequestId(): number { return this.id; }
  notify(method: string, params: unknown): void { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  respond(id: string, result: unknown): void { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }

  async call(name: string, args: unknown): Promise<MCPCallResult> { return await this.rpc('tools/call', { name, arguments: args }) as MCPCallResult; }

  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5_000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
