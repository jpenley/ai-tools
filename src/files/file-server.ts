import type { BuiltInTool } from '../contract.ts';
import { toolAccess, writableAccess, type ToolAccess } from '../shared/access.ts';
import { deleteFileTool } from './delete-file.ts';
import { editFileTool } from './edit-file.ts';
import { findFilesTool } from './find-files.ts';
import { startCall, type FileSession } from './files.ts';
import { DirectoryPermissions, type DirectoryConfig } from './directory-permissions.ts';
import { SessionDirectoryGrants } from './session-grants.ts';
import { requestDirectoryAccessTool, revokeDirectoryAccessTool } from './request-directory-access.ts';
import type { GitPlace } from '../git/git.ts';
import { listDirTool } from './list-dir.ts';
import { searchFilesTool } from './search-files.ts';
import { viewFileTool } from './view-file.ts';
import { writeFileTool } from './write-file.ts';
import { statPathTool } from './stat-path.ts';
import { diffFilesTool } from './diff-files.ts';
import { viewFilesTool } from './view-files.ts';
import { readExcerptTool } from './read-excerpt.ts';
import { makeDirectoryTool } from './make-directory.ts';
import { copyPathTool } from './copy-path.ts';
import { movePathTool } from './move-path.ts';
import { removeDirectoryTool } from './remove-directory.ts';

/** A file server's access and roots are captured once, before its tools are offered. */
export function fileServerTools(session: Omit<FileSession, 'role'> & { readonly directoryConfig?: DirectoryConfig }, place: GitPlace, access: ToolAccess, ripgrep: string | null, report?: (message: string) => void): readonly BuiltInTool[] {
  const mode = toolAccess(access);
  const fixedPlace = Object.freeze({ ...place });
  // Validate roots without letting a rule override credential or link protections.
  const grants = session.permissions?.sessionGrants ?? new SessionDirectoryGrants();
  const config = session.directoryConfig ?? { config: { directories: [] } };
  const permissions = session.directoryConfig === undefined && session.permissions !== undefined ? session.permissions : new DirectoryPermissions(config.config, path => {
    const answer = startCall({ worktree: session.worktree, project: null, role: 'reader', externalRead: true }).judge(path, 'read');
    if (!answer.ok || answer.kind !== 'folder' || answer.throughLink) throw new Error('Permission rules must name existing, readable, non-link directories outside protected paths.');
    return answer.absolute;
  }, config.path, config.fallbacks, config.protectedPaths, grants);
  if (mode === 'deny') return Object.freeze([]);
  const write = writableAccess(mode);
  const files: FileSession = Object.freeze({ ...session, ...(permissions === undefined ? {} : { permissions }), project: null, externalRead: mode === 'super', role: write ? 'implementer' : 'reader' });
  const tools = [viewFileTool(files), statPathTool(files), diffFilesTool(files), viewFilesTool(files), readExcerptTool(files)];
  if (write) tools.push(editFileTool(files), writeFileTool(files), deleteFileTool(files), makeDirectoryTool(files), copyPathTool(files), movePathTool(files), removeDirectoryTool(files));
  tools.push(listDirTool(files), findFilesTool(files, fixedPlace));
  if (ripgrep !== null) tools.push(searchFilesTool(files, fixedPlace, ripgrep, report === undefined ? {} : { report }));
  if (permissions.sessionGrants) tools.push(requestDirectoryAccessTool(files, mode, grants), revokeDirectoryAccessTool(files, grants));
  const scope = `Project settings are loaded before global defaults; most-specific directory wins, project wins ties. Use stat_path for the effective rule and source. ${mode === 'super' ? 'Default: repository writes and unrestricted external reads except settings denials and protected paths; external writes require an explicit grant.' : write ? 'Default: repository reads/writes; external paths require an explicit settings or user-approved session grant.' : 'Default: repository reads only; external reads require an explicit settings or user-approved session grant. Global read-only always forbids writes.'} Settings override session grants. Configuration and permission roots are protected; settings changes require an owner restart.`;
  return Object.freeze(tools.map(item => {
    if (['request_directory_access', 'revoke_directory_access'].includes(item.tool.name)) return item;
    const writing = ['edit_file', 'write_file', 'delete_file', 'make_directory', 'copy_path', 'move_path', 'remove_directory'].includes(item.tool.name);
    const descriptions: Record<string, string> = {
      view_file: 'Show a UTF-8 text file with its file hash and numbered line anchors. Supports start_line/end_line or tail_lines (1-400). Default replies: 400 lines or 50 KiB; follow next: start_line=K. full:true removes reply and long-line cuts within the selected range. Binary files and files over 16 MiB are still refused.',
      list_dir: 'List one folder, folders first, then files, by name ignoring case. Use hidden to include dot names. Default: 200 entries; follow next: offset=K. full:true returns every remaining permitted entry from offset.',
      find_files: 'Find permitted files. mode:glob (default) matches whole paths (*, **, ?, classes and alternatives) in ordinal order. mode:fuzzy matches query characters in order with gaps, ranking exact/prefix/substring/subsequence basenames before path-only matches; it does not correct spelling. exclude is up to 16 whole-path glob patterns; path does not rebase them. Use include_ignored for Git-ignored files. Default: 200 paths; follow next: offset=K. full:true returns all remaining matches; resource limits still apply.',
      search_files: 'Search permitted file text. Provide exactly one of pattern (regex by default, literal:true for fixed strings) or patterns (OR of 1-32 single-line literal strings, at most 8 KiB UTF-8 total; omit literal or set true). Use path/glob to narrow and exclude (up to 16 whole-path globs) to remove files before searching. case_insensitive and include_ignored default false. context:0-20 adds surrounding lines prefixed with context; matches retain N:hhhhhh|text anchors. Windows merge; context records never advance match offsets. Default: 200 matches or 50 KiB; follow next: offset=K with unchanged options. Oversized first windows omit context explicitly. full:true removes reply/line cuts, not the 10,000-match ceiling, read budget, or other resource limits.',
      edit_file: 'Edit a repository text file using its latest file hash as base and line anchors from view_file. Supports replace, delete, insert_before, insert_after, append and unique replace_text edits. Stale reads are refused; replace_text alone needs no base.',
      write_file: 'Create or replace a repository UTF-8 text file (no NUL, at most 16 MB). Missing parent folders are created. Replacing an existing file requires its latest view_file hash as base. Optional eol (preserve/lf/crlf), bom and final_newline explicitly change text formatting. Ordinary POSIX permissions are preserved; new files are private (0600).',
      delete_file: 'Delete one permitted regular file, text or binary, using its latest stat_path version/hash (or view_file hash) as base. Above 64 MiB the version checks metadata, not content. Folders are never deleted.',
    };
    const description = `${(descriptions[item.tool.name] ?? item.tool.description).replaceAll('repository paths', 'permitted paths').replaceAll('repository text file', 'permitted text file').replaceAll('repository directory', 'permitted directory').replaceAll('the destination must be in the repository', 'the destination must be writable')} ${scope} Paths may be repository-relative or absolute. Git internals and credential paths are refused. Symlinks/junctions may be followed only for reads when alias and target are allowed; traversal is unconditionally read-only, regardless of directory grants. No tool creates symlinks/junctions. External search patterns match whole absolute paths; use **/ to match any prefix. Writes refuse hard-linked files and stale hashes.`;
    return { ...item, tool: { ...item.tool, description, annotations: { readOnlyHint: !writing, ...(writing ? { destructiveHint: true, idempotentHint: false } : {}), openWorldHint: false } } };
  }));
}
