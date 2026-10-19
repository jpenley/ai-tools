# Files MCP expansion

## Scope and sequence

1. Add reusable bounded byte reads, snapshots/version tokens, path locking and traversal under `src/files/core/`.
2. Add `stat_path`, `diff_files`, `view_files`, and `read_excerpt`; extend `view_file` with `tail_lines`.
3. Add `make_directory`, `copy_path`, `move_path`, and `remove_directory`, offered only in full mode.
4. Register tools with accurate read/destructive annotations and document contracts.
5. Test real stdio access-mode registration and focused filesystem security/behavior, then typecheck and review.

## Security and failure contract

- Existing path judgment remains authoritative. External sources can be read/copied in full mode, never moved/deleted/written. Credentials, Git internals and links remain refused.
- Moves/copies require a source `base` from `stat_path` (recursive for directory trees). Existing file hashes are accepted for files. Overwrite is explicit, file-only, and needs `destination_base`.
- Recursive copy/move/delete requires `recursive: true`. Recursive deletion additionally requires a preview/version token; execution must match the exact tree. All descendants are preflighted before mutation.
- Traversal is bounded to 1,000 entries and 64 MiB of file content. No unbounded recursive deletion primitive is used.
- Recursive operations are not filesystem transactions. Errors explicitly report partial completion. Directory moves use exclusive destination creation and per-file relocation, not replacement of an existing destination directory. Cross-filesystem moves are refused; callers can copy then explicitly delete instead.
- In-process locks cover source/destination trees and existing file-writer locks. Revalidate after acquiring locks. As with existing file writers, path-based OS calls cannot eliminate all races with independent external processes; these tools are not an OS sandbox.
- Read excerpts are bounded UTF-8 byte windows, not edit-ready full-file reads. Keep the existing 16 MiB edit-ready read limit. Multi-file reads and diffs have aggregate output/work limits.

## Validation

Exercise both access modes; outside read/copy vs outside mutation; stale source/destination/tree versions; binary copies; overwrite defaults; recursive opt-in; protected descendants; links/hard links; root and self/descendant operations; partial failures; output/work limits; package export compatibility; original stdio tests.
