import { accessSync, constants, statSync } from 'node:fs';

import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

export function programPath(program: string, worktree: string, env: Readonly<Record<string, string>>): string | null {
  const windows = process.platform === 'win32';
  const lookup = (name: string): string | undefined => Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === name : key === name))?.[1];
  const extensions = windows && extname(program) === '' ? (lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '') : [''];
  const candidates = (base: string): string[] => extensions.map((ext) => base + ext);
  if (isAbsolute(program) || /[\\/]/.test(program)) return candidates(resolve(worktree, program)).find(runnable) ?? null;
  for (const folder of (lookup('PATH') ?? '').split(delimiter)) {
    if (folder === '' || !isAbsolute(folder)) continue;
    const found = candidates(join(folder, program)).find(runnable);
    if (found !== undefined) return found;
  }
  return null;
}

function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
