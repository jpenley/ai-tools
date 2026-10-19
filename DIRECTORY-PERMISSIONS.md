# Directory permissions (Files MCP only)

## Startup ceiling and scope

| Startup access | Repository default | External default |
| --- | --- | --- |
| `deny` | No tools | No tools |
| `read-only` | Read-only | Denied |
| `full` | Read/write | Denied |
| `super` | Read/write | Read-only |

`super` adds broad external **reads**, not external writes, and cannot bypass settings
denials, credential/Git-internal protection, OS permissions or the unconditional
read-only ceiling on symlinks/junctions. `full` is now project-scoped by default;
select `super` explicitly if broad external reads are wanted. Both permit external
writes only through explicit settings or a user-approved session grant. Read-only
startup never allows mutations. `deny` offers no tools, including approval tools.

These modes constrain this Files server, not other tools or operating-system
processes. Git accepts the same startup values, with `super` equivalent to full Git,
but does not support directory configuration or directory-escalation tools.

## Project discovery and global defaults

At startup the Files server reads, in priority order:

1. `<server-root>/.mcp-config/ai-tools-files-permissions.json` (this project).
2. `<owner-home>/.mcp-config/ai-tools-files-permissions.json` (shared global defaults).

The root is the owner-selected `--root`, not the client's current directory or a
model-supplied project name. Configure the host to start a separate server for each
project root. A project file is never searched in sibling projects or inherited
from another server session. Global rules are intentionally shared: put grants
that belong to one project in that project's file, **not** the global file.

Optional owner-selected replacements:

```text
node src/files/server.ts --root C:/Work/repo --access full --permissions C:/Work/repo/.mcp-config/custom.json --global-permissions C:/MCP/shared-defaults.json
```

`--permissions` replaces only the project source and must be inside this server
root; using another project's JSON is an error. `--global-permissions` replaces only
the global source and is deliberately global, not project-isolated. Automatic files
may be absent; explicitly named missing files are errors. Existing malformed or
unreadable files always refuse startup, never silently fall back to broader access.
No configuration sources may be reached through links/junctions.

Each source has exactly this schema:

```json
{
  "directories": [
    { "path": "C:/Shared/reference", "access": "read-only" },
    { "path": "C:/Work/output", "access": "full" },
    { "path": "C:/Work/output/private", "access": "deny" }
  ]
}
```

These are example paths, not installed grants. `super` is a startup mode, **not** a
directory-rule value. Directories must already exist.

## Resolution and hard limits

1. Unsafe-path, credential, Git-internal and configuration-file protections apply.
   Links may be followed for reads only; both alias and targets must be authorized.
   No grant enables mutations through links or movement/deletion of the links
   themselves. No tool creates links. Dangling links and cycles refuse.
2. Match canonical directory paths by component boundaries, not string prefixes.
   Across both settings sources, the longest matching directory wins; project wins
   equal-path ties. Thus a more-specific global rule beats a broader project rule,
   and an explicit child setting may allow a child below a denied parent when
   directly named. A `deny` selected by this resolution applies even in super mode.
3. **Any matching settings rule takes precedence over all session grants.** A
   narrower session grant cannot relax a settings denial or read-only rule. A broad
   session grant does not bypass settings restrictions on its descendants.
4. If no settings rule matches, use the most-specific session grant, if any; else
   the startup defaults above. Apply the startup read-only write ceiling in all cases.
5. Symlink/junction access remains read-only independently of all modes/grants.

A rule of `read-only` or `full` can grant external reads even with read-only startup;
`full` grants writes only with full/super startup. Denial includes metadata results.

## Session grants and user confirmation

```text
request_directory_access {"path":"C:/Work/output","access":"full","reason":"Update the generated output requested by the user."}
revoke_directory_access {"path":"C:/Work/output"}
```

`request_directory_access` accepts only `path`, `access` (`read-only` or `full`) and
`reason` (1–1000 characters). It cannot change the startup ceiling or settings.
It requires an existing non-linked directory below a filesystem root. A directory
replacement while the user is deciding invalidates the request. Already-allowed
access reports `already-allowed` without creating a grant or prompting.

The transport requires the client to advertise MCP **form elicitation** support.
It sends `elicitation/create` showing the exact server/project root, directory,
access, session lifetime and the agent's reason clearly labeled untrusted. Approval
uses a boolean checkbox defaulting to false. Only a correlated client response with
`action:"accept"` and `content:{"approve":true}` grants access. A model argument
like `approved:true`, accepting without checking the box, URL-only capability,
unsupported clients, errors, decline, cancel, a two-minute timeout or disconnect
all fail closed. Late responses after cancellation/timeout are ignored. This trusts
the MCP host to obtain actual user consent; server code cannot independently prove
that a host displayed its UI. No approval is inferred from agent prose.

Grants are memory-only and private to this connection/server instance. They are
not serialized, inherited by another session/project, or written into settings.
At most 64 grant roots are allowed; revoke unused grants to free slots. Read-only
grants require another confirmation to upgrade. Revoke reduces access without
approval and invalidates outstanding approval requests so a late accept cannot
reinstate revoked access. Disconnect/restart removes all grants; revocation does not roll back
filesystem work already completed or interrupt an operation already underway.
Grant roots are protected namespace anchors while active. Root replacement fails
closed; revoke it and request approval again. Embedding adapters supplying their
own DirectoryPermissions must explicitly provide its SessionDirectoryGrants store
to opt into the approval tools; they must forward the trusted ToolCallContext and
close the registry on disconnect. Model-supplied arguments must never create that
context. Standalone servers already supply this transport/lifecycle integration.

## Validation and startup lifetime

- Each settings file is UTF-8 JSON, at most 64 KiB, containing at most 128 rules.
  Unknown fields, invalid values and duplicate canonical roots within a source
  refuse startup. Equal paths across sources use the precedence above.
- Rule roots are absolute, existing, readable non-link directories outside protected
  paths. Missing roots, UNC/device paths and linked root ancestors are errors.
- Settings rules are copied, frozen and captured once; editing JSON does not hot-
  reload the active server. Restart and refresh tool definitions after owner review.
  Protect settings with owner-controlled OS permissions and do not commit unreviewed
  grants. Current and automatic source filenames are unreadable/unwritable through
  file tools, **even when the automatic files are absent**, or replacements are used.
  The conventional `.mcp-config/ai-tools-files-permissions.json` filename is also
  reserved in other/external trees, including missing files, so an external full
  grant cannot plant another project's automatic settings. Custom source paths are
  protected when loaded by this server; secure other projects' custom files with OS
  permissions. This protection applies to file tools, not a separate shell or Git server.
- Repository and configured rule roots cannot be moved, removed or replaced through
  file tools. Descendants may be writable. Device/file identity pins each rule root;
  replacement fails closed until the owner reviews and restarts.

## Inspection and recursive operations

`stat_path` includes effective policy and the selected source:

```json
{
  "access": "read-only",
  "rule": {
    "path": "C:/Work/output",
    "access": "full",
    "source": "C:/Work/repo/.mcp-config/ai-tools-files-permissions.json"
  },
  "capped_by_global_read_only": true
}
```

Session rules use `source:"session:user-approved"`; `rule:null` means default scope.
Link reads also return `capped_by_link:true` and effective `access:read-only`.
Readable/writable flags describe policy, not guaranteed OS permission. Protected
roots may allow full access to contents but have `writable:false` for replacement
of the root itself. Denied paths return an error instead of existence/size metadata.
Validation may inspect metadata internally; this is not an OS syscall sandbox.

Individual reads/writes and recursive snapshots use the same policy. Recursive
move/copy/delete preflight every descendant and refuse if any is inaccessible or
non-writable; they never skip a protected descendant then mutate the rest. Hashes,
version tokens, overwrite opt-ins, bounds, hard-link protection and partial-failure
reporting remain. Listings hide denied entries and walks prune denied directories;
name an explicitly permitted descendant directly if needed. Search supplies ripgrep
with bounded batches of pre-authorized regular files, rather than broad scanning
and output filtering. Git may select repository paths/ignores internally; directory
rules do not restrict the separate Git server or other harness tools.

Independent OS processes can still race path-based calls. A refusal does not confer
permission to bypass the server through another tool.
