#!/usr/bin/env node
import { startToolServer } from '../mcp/start.ts';

await startToolServer('git').catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
