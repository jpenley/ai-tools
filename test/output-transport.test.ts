import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const moduleUrl = new URL('../src/mcp/stdio.ts', import.meta.url).href;
const cwd = fileURLToPath(new URL('../', import.meta.url));
const fixture = (size: number, blocked = false): string => `import { serveMcp } from ${JSON.stringify(moduleUrl)};
  let started = 0;
  const payload = 'x'.repeat(${size});
  ${blocked ? "process.stdout.write = () => { setImmediate(() => console.error(JSON.stringify({started}))); return false; };" : ''}
  serveMcp({ name: 'output-fixture', tools: async () => [],
    call: async () => { started++;
      setImmediate(() => console.error(JSON.stringify({started})));
      return { success: true, content: [{ type: 'text', text: payload }] }; },
    close: () => { if (!${blocked}) console.error(JSON.stringify({closed: started})); } });`;
const request = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture', arguments: { full: true } } });

describe('large-output transport safeguards', () => {
  // Catches one batch multiplying a full result into an unbounded aggregate before backpressure.
  it('rejects full-output batches before any tool executes', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture(1)], {
      cwd, encoding: 'utf8', input: JSON.stringify([request(1), request(2)]) + '\n', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply).toHaveProperty('error.message', expect.stringMatching(/full.*individual/i));
    expect(JSON.parse(result.stderr.trim())).toEqual({ closed: 0 });
  });

  // Catches releasing active slots while a slow client leaves many full replies buffered on stdout.
  it('holds full-output active slots until stdout accepts their replies', async () => {
    // Simulate backpressure at the OS-stream boundary; native pipe writes can block synchronously on Windows.
    const child = spawn(process.execPath, ['--input-type=module', '-e', fixture(8 * 1024 * 1024, true)], { cwd, stdio: 'pipe' });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdout.pause();
    try {
      const checkpoint = new Promise<number>((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`No output-backpressure checkpoint: ${stderr}`)), 10_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
          const newline = stderr.indexOf('\n');
          if (newline >= 0) { clearTimeout(timer); resolve((JSON.parse(stderr.slice(0, newline)) as { started: number }).started); }
        });
      });
      child.stdin.end(Array.from({ length: 10 }, (_, i) => JSON.stringify(request(i))).join('\n') + '\n');
      expect(await checkpoint).toBe(4);
    } finally {
      child.kill();
      child.stdout.resume();
      await closed;
    }
  }, 15_000);
});
