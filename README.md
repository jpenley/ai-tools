# AI tools

Independent file and Git MCP servers. Each captures a repository root and an owner-
selected `deny`, `read-only`, `full`, or `super` startup ceiling. Calls cannot change
that ceiling; owner-approved directory grants may last for one connection only.

Requires Node 24 or newer and Git. Run `npm ci` to install dependencies.
Ripgrep is optional; `search_files` is listed only when it is available at startup.

```text
node C:/FactoryFloor/repos/ai-tools/src/files/server.ts --root C:/path/to/repo --access full
node C:/FactoryFloor/repos/ai-tools/src/git/server.ts --root C:/path/to/repo --access read-only
```

In a harness, configure separate stdio MCP entries with an absolute Node executable
and those argument arrays. Optional `--git <absolute-executable>` and
`--ripgrep <absolute-executable>` support hosts that supply no PATH. The root must
be a Git repository or registered worktree root. Missing or invalid access refuses
startup. Full/super roots must not traverse symlinks/junctions or contain `..`;
read-only startup may use a linked root, pinned to its resolved repository.
MCP server names are `ai-tools-files` and `ai-tools-git`.

For stable Pi operation while developing this repository, use the launchers in
[`deploy/`](deploy/README.md), not the editable source entry points above.
`npm run deploy` publishes a validated, self-contained snapshot of committed HEAD;
restart/reconnect both servers after publication to activate it.

| Startup mode | Files: repository default | Files: external default | Git |
| --- | --- | --- | --- |
| `deny` | No tools | No tools | No tools |
| `read-only` | Read-only | Denied | Read-only subcommands |
| `full` | Read/write | Denied | Repository reads/writes |
| `super` | Read/write | Read-only, subject to settings denials/protected paths | Same as `full` |

**Migration:** `full` no longer grants unrestricted external reads. Select `super`
explicitly to retain that breadth, or grant only the directories this project needs.
No mode implicitly grants external writes. File writes retain read hashes, anchored
edits, atomic replacement and stale-read refusals.

Files discovers `<server-root>/.mcp-config/ai-tools-files-permissions.json`, then
`<owner-home>/.mcp-config/ai-tools-files-permissions.json`. Most-specific directory
wins; project wins equal-path ties. Rules use `deny`, `read-only`, or `full`; the
startup read-only ceiling and link read-only ceiling cannot be overridden.
`--permissions <absolute-project-json-file>` replaces the project source and must
stay inside this server root. `--global-permissions <absolute-json-file>` replaces
the intentionally shared global defaults. Keep project-specific grants in the
project file—not a shared launch argument or global file. Configure the host's
`--root` for the actual project; client working-directory changes do not retarget it.
Settings files (including absent automatic locations) and permission roots are protected.

`request_directory_access {path, access, reason}` asks an MCP host that advertises
**form elicitation** to confirm a connection-local directory grant. The host must
return `accept` with the approval checkbox explicitly `true`; model-supplied approval
arguments do not work. Unsupported hosts, decline, cancellation, disconnection and
a two-minute timeout grant nothing. Settings take precedence over session grants.
`revoke_directory_access {path}` removes a session grant without editing settings.
External find/search patterns match whole absolute paths; use `**/` for any prefix.
See [DIRECTORY-PERMISSIONS.md](DIRECTORY-PERMISSIONS.md) for details and limits.
Git rejects directory settings options and has no directory-escalation tool.

Standalone servers do not use project-specific `engine/<repo>` declarations or
privileged engine links. Ordinary folders named `engine` follow the same rules as
other repository folders. Symlinks and junctions may be traversed for **read-only**
access: both the requested namespace and every target must be permitted. No
directory grant can enable mutations through links, including deletion/movement
of the link itself. No tool creates symlinks or junctions. Dangling links and
cycles are refused. Credential paths, Git internals, unsafe path forms and external
writes without an explicit full-mode grant remain refused. OS permissions still apply.
Studio adapters using the shared library may retain their own engine-link policy
and fixed extra readable folders.

## File discovery and content search

`find_files` keeps whole-path glob matching and ordinal ordering by default:

```json
{"pattern":"**/*.ts","exclude":["test/**","**/*.generated.ts"]}
```

Use `mode: "fuzzy"` for filename discovery without writing a glob:

```json
{"pattern":"srchfl","mode":"fuzzy","path":"src"}
```

Fuzzy matching is case-insensitive: query characters must occur in order, with
intervening characters allowed. It is not spelling correction. Exact basenames
rank first, then basename prefixes, contiguous substrings, basename subsequences,
and path-only subsequences. Ties favor fewer gaps, earlier starts, shorter names
and paths, then ordinal path order. Subsequence scores use the first left-to-right
greedy alignment, not the tightest possible alignment. The query is limited to
512 characters.
Fuzzy searches retain the normal 200-path page, offset and full-output behavior.
Entry/time, matching-work and 16 MiB retained-path budgets refuse oversized searches;
narrow `path` rather than treating a refusal as a partial result.

`search_files` keeps regular expressions by default. Use `literal: true` when
punctuation must match exactly:

```json
{"pattern":"a.b","literal":true,"glob":"**/*.ts","context":2}
```

To search for any of several literal strings, use `patterns` instead of `pattern`:

```json
{"patterns":["firstName","first_name"],"context":2,"exclude":["test/**"]}
```

Provide exactly one of `pattern` or `patterns`. A pattern array always uses literal
OR matching; omit `literal` or set it to `true`. A line matching several patterns
is returned once. Arrays contain 1-32 nonempty strings, each at most 2,000 characters,
with at most 8 KiB of UTF-8 text in total. Literal strings cannot contain actual CR,
LF or NUL characters; a backslash followed by `n` remains literal text.
`case_insensitive` remains `false` by default in every content-search mode.

Both tools accept `exclude`, an array of at most 16 glob patterns (512 characters
each). They use the existing case-insensitive whole-canonical-path glob syntax:
`*` stops at `/`, `**` crosses it, and classes/alternatives are supported.
`path` narrows the search but does not rebase exclusions. For example, use `src/test/**`
inside `path: "src"`, not `test/**`. External paths are absolute; use `**/` for any
prefix. A leading `/` also retains the existing shorthand for worktree-relative
patterns. Exclusions share bounded matching work and refuse on exhaustion. Excluded
files are not passed to the content-search process. Permissions and credential/link
protections still apply; exclusions never grant access.

`context` adds 0-20 lines before and after a match; the default is 0. Overlapping
windows merge within each reply. Matches keep the usual `N:hhhhhh|text` format;
context records use `context N:hhhhhh|text`, preserving the same line anchors.
A matching line outside the current page can appear as context without advancing
the offset. Continuations count matching lines, not context records; repeat every
selection option unchanged. Normal reply limits can shorten a page. If the first
window alone is too large, the reply emits its match, reports omitted context, and
continues from the next match. `full: true` removes reply and long-line cuts, not
collection/read safeguards. Listings and searches remain live, not snapshots.

## Pagination and full output

Replies are bounded by default. Continue with the reported arguments, keeping the
other selection arguments unchanged:

| Tool | Default output limit | Continuation |
| --- | --- | --- |
| `list_dir` | 200 entries | `offset` from `next: offset=K` |
| `find_files` | 200 paths | `offset` from `next: offset=K` |
| `search_files` | 200 matches or 50 KiB | `offset` from `next: offset=K` |
| `view_file` | 400 lines or 50 KiB | `start_line` from `next: start_line=K` |
| `view_files` | 40 lines per file, 50 KiB total | `offset` for remaining path indexes; use `view_file` for more lines of an individual file |
| `diff_files` | 200 diff records or about 48 KiB | `offset`, `left_base` and `right_base` from the reply |
| `git` | 2,000 lines or 50 KiB | `cursor` alone, without `args` |

All seven tools accept optional `full: true` for codemode or another consumer that
filters results before displaying them. It returns all remaining selected results
without reply-size limits or long-line cuts. The default is `false`. `full` must be
a JSON boolean. A host can still impose its own output limits, so filter the tool
response before forwarding it to the model. Send `full: true` calls as individual
MCP requests, not entries in a JSON-RPC batch. The transport rejects such batches
before executing any entry to avoid multiplying large results in memory. Individual
full-output calls retain an active request slot until their replies drain.

```json
{"pattern":"**/*.ts","full":true}
```

For `list_dir`, `find_files`, `search_files` and `view_files`, `full` starts at the
supplied `offset`, not the beginning. `view_file` still respects `start_line`,
`end_line` and `tail_lines`. `view_files` ignores `max_lines` in full mode and returns
all selected files' lines. `diff_files` ignores `max_lines` in full mode but retains
its offset and continuation-hash requirements.

`full` changes presentation, not permission or resource policy. File-size limits,
the 16 MiB aggregate input budget for `view_files`, search's 10,000-match ceiling
and 32 MiB read budget per call, enumeration bounds, subprocess buffers and timeouts
still apply. Resource-bound continuations and per-file failures remain explicit.
Listings and searches re-enumerate on each call, so concurrent changes can shift
offsets. Diff continuations refuse changed file hashes.

Git pagination reads a retained snapshot of a completed command. It never reruns
a command, including mutations. Use the returned cursor on the same connection:

```json
{"args":["diff"]}
{"cursor":"<returned cursor>"}
{"cursor":"<returned cursor>","full":true}
```

The last call returns all remaining snapshot output. A new command can also use
`{"args":["diff"],"full":true}`. Do not supply `args` with `cursor`. Git snapshots
expire after five minutes and are bounded to four results and 32 MiB per tool
connection. Expired or evicted cursors return an error. Inspect state before
retrying a mutation whose output is no longer available.

Git pages preserve every character of the tool's formatted result, including Unicode
and newline endings. Existing status messages and diagnostic prefixes remain part of
that result; this is not a raw stdout or binary-output interface. An oversized line
can span pages. To reconstruct exact output, concatenate page
bodies after removing only each appended `\nnext: cursor=...` footer. Git's 16 MiB
process buffer and 60-second timeout apply in both modes. Overflow is an error,
not successful partial output, and does not produce a continuation cursor.

## File inspection and filesystem operations

- `stat_path {path, recursive?}` returns existence, type, size, timestamps, access
  status and a `version`. Access flags describe tool policy, not guaranteed OS
  permissions. Files up to 64 MiB also include a raw-byte `hash`.
  `recursive:true` previews the entire allowed directory tree; a protected descendant
  refuses the snapshot rather than being silently skipped. Larger individual files
  support metadata inspection, but bounded copy/move operations refuse them.
- `view_file {path, tail_lines?}` supports the final 1-400 lines. `tail_lines` cannot
  be combined with `start_line`/`end_line`; the existing 16 MiB full-file limit and
  edit-ready hashes/anchors remain unchanged.
- `view_files {paths, max_lines?, offset?, full?}` reads 1-8 text files with hashes/anchors. Its total
  input budget is 16 MiB and default output budget is 50 KiB; per-file errors and omissions
  are explicit. Use `view_file` for continuation.
- `diff_files {left, right, max_lines?, context_lines?, offset?, left_base?, right_base?}`
  compares two UTF-8 files (16 MiB each) with multiple contextual hunks. Bounded
  patience matching may show repetitive/unanchored regions as replacements.
  Continue with the reported offset and both file hashes as left_base/right_base;
  stale continuations refuse. Keep context_lines unchanged between pages.
  Output is inspection-only, not an apply-ready patch. Formatting metadata is included.
- `read_excerpt {path, byte_offset?, max_bytes?}` reads at most 32 KiB of UTF-8,
  including from large files. It reports adjusted UTF-8 offsets and a metadata
  version, but **no edit-ready file hash or line anchors**. Only the selected window
  is validated as text; it does not certify the whole file as non-binary.
- `write_file` accepts optional `eol: preserve|lf|crlf`, `bom: boolean` and
  `final_newline: boolean`. Defaults retain existing behavior. Explicit settings
  override formatting preservation but still require a fresh base for replacement.
  Text edits/replacements preserve ordinary POSIX mode bits (not set-id bits);
  new files and staging temporaries are private (0600). Windows ACL preservation
  is not promised by atomic replacement; use OS permissions for that boundary.
- `delete_file {path, base}` deletes a single regular file, including binary files.
  Up to 64 MiB use a stat_path version/hash or view_file hash. Above 64 MiB only
  the metadata version is accepted: identity, mode, link count, size and timestamps,
  not content. Changed versions refuse deletion. Hard-linked files remain refused.
- `make_directory {path, parents?}` creates empty repository directories, with
  missing-parent creation only when `parents:true` is explicit.
- `copy_path` and `move_path` take `{source, destination, base, recursive?,
  overwrite?, destination_base?, preview?}`. Get `base` from `stat_path` (use
  `recursive:true` for directory trees), or obtain it as `source.version` from a
  transfer's `preview:true` response. A full file hash also works for a regular
  file. Existing destinations are refused by default. File-only replacement needs
  `overwrite:true` and the existing destination's version/hash as `destination_base`.
  Directory merging/replacement is not supported. Destination parents must exist.
- `remove_directory {path, preview?, recursive?, base?}` is empty-only by default.
  First call with `preview:true`, inspect the manifest/version, then execute with
  `base` equal to that version. Nonempty trees additionally require `recursive:true`.
  A recursive `stat_path` version can also serve as the inspected preview token.

All mutations require full/super mode and writable paths: the repository by default, plus
explicitly granted external directories. Copy can import an external readable source
into a writable destination; move additionally requires write access to its source.
Neither operation stages Git changes. Trees are limited to 1,000 entries (including
root) and 64 MiB of content, and every descendant is checked before mutation. Moves
are limited to one filesystem. Copy preserves bytes, not ownership, mode bits or
other metadata. Move uses hard-link/unlink relocation for non-overwriting files,
retaining their underlying file metadata; directory identities/timestamps change.

Recursive operations are **not transactions**. They create exclusive destination
directories, never silently merge or overwrite a directory, and report partial
completion if an OS operation fails. Recursive removal uses checked individual
unlinks and empty-directory removal, never an unbounded recursive-delete primitive.
Unexpected entries cause failure. Inspect both paths before retrying a partial
operation. Version checks and in-process locks protect cooperating tool calls;
independent OS processes can still race path-based filesystem calls. No tool is an
OS sandbox. Mutations through links, credentials, Git internals and repository-root
mutations remain refused, as do hard-linked write targets and move/delete sources. A readable
hard-linked copy source is allowed because copying does not mutate that source.

Full Git supports staging, commits, branches, switching, merging, rebasing,
cherry-picking, tags, stash, reset/restore, removal, clean, fetch, push and pull.
Hooks, signing and interactive editors are disabled. Global configuration/root
overrides, caller-selected programs and explicit helper transports are refused.
Read-only Git cannot lazy-fetch missing objects. Git still trusts the owner's
configured filters, credentials and transports. These modes govern this server's
tools; they do not provide an operating-system sandbox for other harness tools.
Git file-input switches (including -F/-f input files, templates, pathspec files,
exclude files and blame revision files) are refused rather than bypassing path
authorization. Use inline messages/patterns and explicit repository pathspecs.
Git materializes checked-out symlinks as regular files (`core.symlinks=false`).
Commands that may rewrite the worktree conservatively refuse any existing links,
including ignored links (bounded preflight: 100,000 entries/5 seconds). Reads,
staging and ordinary commits remain available. This can require an owner-managed
link-free checkout for switching/merging/cleaning; no override is exposed.

The credential-name policy has narrow exceptions for credential/credentials source
modules and their test/spec variants (JS/TS), not arbitrary source filenames.
Actual credential stores such as .env, credentials.json and private keys remain protected.

## MCP resource bounds

Each server permits at most 4 active tool calls and 32 queued calls, shared across
individual messages and batches. Batches are limited to 32 entries. Overflow is
rejected; output backpressure pauses further input. Cancellation removes queued
work before execution. Active filesystem/Git cancellation is best-effort reporting:
it does not interrupt/roll back an operation already running. Inspect state before
retrying. Permission approval is different: cancellation prevents a pending grant.

## Proposed Git permission levels

[GIT-PERMISSIONS-PLAN.md](GIT-PERMISSIONS-PLAN.md) proposes finer local, destructive
and remote capabilities. It is a proposal only; Git currently keeps read-only/full
command behavior (`super` aliases full; `deny` offers no tools).

Source layout:

- `src/files/`: Files MCP entry point (`server.ts`) and individual file tools.
- `src/files/core/`: bounded byte reads, snapshots, traversal, locks and transfer primitives. Existing text editing continues to use `files.ts`.
- `src/git/`: Git MCP entry point (`server.ts`) and Git implementation. File listings also use its hardened Git helpers.
- `src/shared/`: access-mode validation and argument helpers used by both servers.
- `src/mcp/`: common startup and stdio protocol handling.
- `src/policy/`: path and credential policy helpers.

Package imports use `@factory-floor/ai-tools/files/*`, `git/*`, and `shared/*`.
Existing `@factory-floor/ai-tools/tools/*` imports remain compatible through export
aliases, but direct source-path consumers must update their paths. MCP host entries
must point to the new `src/files/server.ts` or `src/git/server.ts` launch paths.
Factory Floor consumes this repository through its `engine/ai-tools` link. This repo
has no Factory Floor runtime imports. `EXTRACTION.md` records provenance and the boundary.

Run `npm test` for real stdio MCP checks against temporary local repositories and
a local bare remote. Run `npm run typecheck` for the package's TypeScript check.
Tests need no model, browser, studio process or external Git remote.
