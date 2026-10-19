# Proposed Git permission model (not implemented)

## Goal

Let owners grant useful local work without implicitly authorizing destructive
cleanup, history replacement or remote publication. Preserve immutable startup
policy; no MCP operation can grant capabilities, edit policy or reconfigure Git
helpers. Files directory permissions remain a separate policy.

## Local levels

Each level includes the previous one. Read/write authorization must be parsed per
subcommand and option, not inferred from the subcommand name alone.

| Level | Allowed local operations | Excluded without additional capabilities |
| --- | --- | --- |
| `inspect` | Current read-only Git operations; branch/worktree listing | Index/worktree/ref writes, lazy fetch |
| `edit` | Stage/unstage explicit paths; ordinary mv/rm; create a branch; safe branch switching | Commits/tags, integration, discarding changes, branch/ref replacement |
| `commit` | Commit staged work, amend only when explicitly enabled; create non-replacing tags; revert by making a new commit | Amend by default, resets of branch tips, integration, tag replacement/deletion |
| `integrate` | Merge, cherry-pick, rebase and normal stash save/apply/pop | Forced/discarding variants, cleanup, stash drop/clear, deleting or forcibly replacing refs |

Recommended agent default: `commit`, `destructive=false`, `network=none`.
Choose `integrate` deliberately for an integration task. Ordinary file removal at
`edit` requires explicit repository pathspecs and must not discard modified files;
Git's own safety refusal stays enabled. Future structured operations should expose
previews and state tokens for potentially lossy actions.

`amend` is a separate owner opt-in at `commit` or above because it replaces history.
Rebase is deliberately confined to `integrate`; it rewrites the task's local commits.
Protected branch rules should independently block direct commits/rebases/ref writes
on owner-listed branches regardless of the selected local level.

## Destructive opt-in

`destructive=true` additionally permits, subject to the local level:

- clean, force removal, worktree restore/discard, checkout/switch discard flags;
- hard reset and other branch-tip replacement/reset operations;
- branch/tag deletion or forced replacement;
- stash drop/clear and equivalent data-discarding forms.

Initially require a dedicated structured destructive operation with an explicit
preview and an expected HEAD/index/worktree token, rather than arbitrary raw flags.
The preview is a stale-state guard, not proof of user approval. The harness remains
responsible for obtaining user authorization. `inspect` can never mutate, even if
an inconsistent destructive flag is supplied at startup (reject that configuration).

## Network is orthogonal

| Network capability | Allowed operations |
| --- | --- |
| `none` | No caller-requested fetch/push/pull or lazy fetch |
| `fetch` | Fetch from owner-allowlisted configured remotes; lazy fetch only from those remotes when explicitly enabled |
| `publish` | Fetch plus normal non-forced push to owner-allowlisted remote/ref destinations |

`pull` requires both `fetch` and `integrate`, since it combines remote retrieval
and local integration. Fetch also writes local object/ref metadata, so reject
`inspect + fetch` unless a future explicit remote-inspection operation has a
separate object-storage contract. Prefer `edit + fetch` for retrieval-only agents.
Normal publication requires `commit` or above.

Remote creation/configuration and caller-supplied arbitrary URLs/helper transports
remain unavailable by default. Local-path remotes are still remote destinations:
fetch/push can read or mutate another repository and require the same allowlist.
Validate actual owner-configured remotes after URL rewriting, not just the raw
`origin` token. Capture reviewed remote destinations at startup; fail closed if
configuration changes underneath the session rather than silently expanding access.

Remote history deletion/replacement (`--force`, `--force-with-lease`, delete, mirror,
force refspecs and related forms) needs a separate `remote_destructive=true` grant
and explicit remote/ref allowlists. Require leases and previewed expected remote
OIDs wherever supported; never silently turn this on with local `destructive`.

These controls constrain operations requested through this MCP server. Owner
filters, helpers and transports remain trusted and may execute programs or access
the network during otherwise local commands. This is not an OS execution/egress
sandbox. Enforce OS/container restrictions separately if that boundary is needed.

## Non-overridable restrictions

- No caller-selected executables, configuration injection, external-file option
  inputs, alternate Git roots, interactive editors or tool-created links.
- Symlink/junction traversal is read-only; no permission level overrides that.
  The current conservative working-tree link preflight remains until finer-grained
  command-specific affected-path validation is designed and tested.
- Current hook/signing restrictions remain unless separately reviewed by the owner.
- Startup policy, credentials/path protections, resource limits and stale-state
  protections cannot be loosened through tool arguments.

## Implementation and migration

1. Build typed per-command parsers that distinguish options, option values,
   revisions, refspecs and pathspecs. Reject unknown options before invoking Git.
2. Resolve operations into required local/network/destructive capabilities;
   check every constituent action of combined commands such as pull.
3. Add owner configuration for protected refs, remote/ref allowlists and immutable
   startup profiles. Return active capabilities in server instructions/tool metadata.
4. Add preview/state-guarded destructive endpoints, keeping normal calls concise.
5. Test each command/option at every boundary, including aliases, abbreviations,
   bundled short options, option-like values after `--`, rewritten URLs, local-path
   remotes, submodules, protected branches, stale previews and link paths.
6. Keep `--access read-only` as an alias for `inspect + network=none`. Retain
   `--access full` temporarily as an explicit legacy profile with today's broad
   permissions and a startup warning. Do not silently map it to safer behavior or
   silently grant broad rights to a new named profile. Deprecate only after owners
   migrate launch configurations. No new levels are activated by this proposal.
