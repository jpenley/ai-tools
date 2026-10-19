// Test fixture: throwaway git repos under the system's temp folder, removed by `removeTempRepos`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders = new Set<string>();

/** Runs git in `cwd` as a test author, and returns what it printed, trimmed. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A folder for a test: a repo, a worktrees root, or anything else. */
export function tempFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.add(folder);
  return folder;
}

/** A repo whose `main` holds one commit: math.js with add(). */
export function tempRepo(): string {
  const repo = join(tempFolder('ff-repo-'), 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  git(repo, 'add', 'math.js');
  git(repo, 'commit', '-q', '-m', 'Add add()');
  return repo;
}

/** Writes `file` in `dir` and commits it there, as an implementer would. */
export function commitFile(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * How removing a folder rides out Windows holding a file in it for a moment after the process that
 * used it has ended (Defender or the search indexer scanning what it wrote): retried on EPERM and
 * EBUSY, waiting 200 ms longer each time, up to 11 s in all.
 */
export const REMOVE_RETRIES = { maxRetries: 10, retryDelay: 200 } as const;

/** Removes every folder `tempFolder` and `tempRepo` made; wait for any process working in one to end first. */
export function removeTempRepos(): void {
  removeEach(folders, 'Could not remove every temp folder.');
}

/**
 * Removes each of `folders` and forgets them all, and throws what failed once it has tried every one.
 * A folder still held by a process a failed test left running would otherwise stop the rest from
 * going, and fail every later test's cleanup; the run's own temp folder takes it when the run ends.
 */
export function removeEach(folders: Set<string>, message: string): void {
  const errors: unknown[] = [];
  for (const folder of folders) {
    try {
      rmSync(folder, { recursive: true, force: true, ...REMOVE_RETRIES });
    } catch (error) {
      errors.push(error);
    }
  }
  folders.clear();
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
