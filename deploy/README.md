# Stable MCP deployment

This folder separates the tools Pi runs from the source we edit.

## Publish a release

Requires Node 24+, Git and npm. From the repository root:

```text
npm run deploy
```

The publisher snapshots **HEAD**, not uncommitted files. Commit release-ready changes
first. It installs locked dependencies in a private staging folder, runs typecheck
and tests there, prunes development dependencies, then renames the complete snapshot
to `deploy/releases/<commit>/`. Only after success does it atomically replace
`deploy/current.json`. Failures before activation leave the active pointer alone.
Network/package-install failures likewise do not activate a release.

Releases, staging files and the active pointer are local, ignored artifacts.
The scripts and these instructions are tracked. There is no active release until
the first successful deployment. Existing release directories are never overwritten;
republishing the same commit fails safely. Each release has its own node_modules.
Do not edit release contents or delete a release while a server may still use it.

## Configure Pi

Keep the existing Node executable, server names and server-specific options.
Replace only the source entry point in each MCP argument array:

```text
node C:/FactoryFloor/repos/ai-tools/deploy/launch.mjs files --root C:/path/to/repo --access full
node C:/FactoryFloor/repos/ai-tools/deploy/launch.mjs git --root C:/path/to/repo --access full
```

Retain your actual root, access ceiling, Git/ripgrep paths and permissions options;
the examples are not a recommendation to expand access. Source location and target
repository are independent. Pi configuration is not modified by deployment.

Each launcher reads the pointer once, then imports one immutable release. Publishing
does not hot-reload or interrupt existing servers. Restart/reconnect **both** MCP
servers and refresh Pi's tool definitions after publication. During staggered restarts,
the two servers can temporarily run different releases.

For rollback, stop the servers, restore current.json to the previous release's
`{"commit":"<full commit hash>"}`, then reconnect. Keep that release directory intact.
The publisher uses an exclusive .release-lock directory; after an interrupted deploy,
remove it only after verifying no publisher is still running.
