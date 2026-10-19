import type { FileSession } from './files.ts';
import { transferPathTool } from './core/transfer.ts';
export const copyPathTool = (session: FileSession) => transferPathTool(session, false);
