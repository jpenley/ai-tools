import type { FileSession } from './files.ts';
import { transferPathTool } from './core/transfer.ts';
export const movePathTool = (session: FileSession) => transferPathTool(session, true);
